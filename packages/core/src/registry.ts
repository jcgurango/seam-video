// The set of extensions one `Seam` instance was created with.
//
// Internal: everything in core that depends on which extensions are installed
// takes a `Registry` as its first argument, and the only way to get one is
// `createSeam()` (see `seam.ts`). There is deliberately no module-level
// default — two projects with different extension sets can live in one
// process, and a call that forgot its instance is a type error, not a silent
// fallback to "no extensions".
//
// The extension contract below grows only when an extension needs it — see
// docs/extensions.md.

/** Which nodes a contributed field lands on. `"visual"` = every node that
 *  draws: clip, static, text, rect, circle, map, composition. */
export type FieldTarget = "visual";

/** Node types `"visual"` expands to. */
export const VISUAL_NODE_TYPES = [
  "clip",
  "static",
  "text",
  "rect",
  "circle",
  "map",
  "composition",
] as const;

/** A first-class node field contributed by an extension. Authored flat on the
 *  node (`{ "type": "clip", "saturation": 0 }`). This ONE declaration drives
 *  schema validation, keyframing, per-frame sampling and the editor's
 *  Properties row. */
export interface FieldSpec {
  /** The JSON key. Must not collide with a core field or another extension's. */
  readonly key: string;
  readonly nodes: FieldTarget;
  /** Value type. Only numbers exist so far. */
  readonly type: "number";
  readonly min?: number;
  readonly max?: number;
  /** The value that means "no effect" — what an omitted field evaluates to,
   *  and what the editor shows as the placeholder. */
  readonly default: number;
  /** Accepts `[time, value, easing?]` keyframes as well as a plain value. */
  readonly animatable?: boolean;
  /** Editor presentation hints. `softMin`/`softMax` are the slider's span
   *  when the valid range (`min`/`max`) is too wide to be a useful control;
   *  typed values may still go anywhere in the valid range. */
  readonly softMin?: number;
  readonly softMax?: number;
  readonly label?: string;
  readonly group?: string;
  readonly step?: number;
  readonly unit?: string;
}

/** A per-pixel colour function fused into the compositor's fragment shader
 *  (one pass per quad). Stages run in registration order, on gamma-encoded
 *  RGB, after the texture sample and before the shape mask. */
export interface ColorStage {
  /** `vec4f` uniform slots this stage owns. */
  readonly slots: number;
  /** WGSL source: any helper functions plus the entry function
   *  `fn <entry>(rgb: vec3f, p0: vec4f, …, p<slots-1>: vec4f) -> vec3f`.
   *  Every identifier must be prefixed so stages can't collide. */
  readonly wgsl: string;
  readonly entry: string;
  /** Fill `out` (`slots × 4` floats) from a node's sampled field values.
   *  A missing key means that field's default. Called per draw, per frame. */
  prepare(values: Readonly<Record<string, number>>, out: Float32Array): void;
}

/** An extension. */
export interface SeamExtension {
  /** Unique within an instance; duplicate names are a registration error. */
  readonly name: string;
  readonly fields?: readonly FieldSpec[];
  readonly colorStage?: ColorStage;
}

export interface RegisteredField extends FieldSpec {
  /** Name of the contributing extension. */
  readonly extension: string;
}

export interface RegisteredColorStage extends ColorStage {
  readonly extension: string;
  /** First `vec4f` slot of this stage in the shared `ext` uniform array. */
  readonly offset: number;
}

export interface Registry {
  readonly extensions: readonly SeamExtension[];
  readonly fields: readonly RegisteredField[];
  /** Keys of the fields that land on visual nodes, in registration order. */
  readonly visualFieldKeys: readonly string[];
  readonly colorStages: readonly RegisteredColorStage[];
  /** Total `vec4f` slots across all colour stages. */
  readonly colorSlots: number;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildRegistry(extensions: readonly SeamExtension[]): Registry {
  const names = new Set<string>();
  const fields: RegisteredField[] = [];
  const owners = new Map<string, string>();
  const colorStages: RegisteredColorStage[] = [];
  const entries = new Map<string, string>();
  let colorSlots = 0;

  for (const ext of extensions) {
    if (typeof ext?.name !== "string" || ext.name.length === 0) {
      throw new Error("An extension needs a non-empty 'name'");
    }
    if (names.has(ext.name)) {
      throw new Error(`Extension "${ext.name}" is registered twice`);
    }
    names.add(ext.name);

    for (const f of ext.fields ?? []) {
      if (!KEY_RE.test(f.key)) {
        throw new Error(`Extension "${ext.name}": "${f.key}" is not a valid field key`);
      }
      const owner = owners.get(f.key);
      if (owner != null) {
        throw new Error(
          `Extension "${ext.name}": field "${f.key}" is already contributed by "${owner}"`,
        );
      }
      if (f.min != null && f.max != null && f.min > f.max) {
        throw new Error(`Extension "${ext.name}": field "${f.key}" has min > max`);
      }
      owners.set(f.key, ext.name);
      fields.push(Object.freeze({ ...f, extension: ext.name }));
    }

    const stage = ext.colorStage;
    if (stage) {
      if (!Number.isInteger(stage.slots) || stage.slots < 1) {
        throw new Error(`Extension "${ext.name}": a colour stage needs at least one slot`);
      }
      if (!KEY_RE.test(stage.entry)) {
        throw new Error(`Extension "${ext.name}": "${stage.entry}" is not a valid WGSL entry name`);
      }
      const other = entries.get(stage.entry);
      if (other != null) {
        throw new Error(
          `Extension "${ext.name}": colour stage entry "${stage.entry}" is already used by "${other}"`,
        );
      }
      entries.set(stage.entry, ext.name);
      colorStages.push(
        Object.freeze({
          slots: stage.slots,
          wgsl: stage.wgsl,
          entry: stage.entry,
          prepare: stage.prepare.bind(stage),
          extension: ext.name,
          offset: colorSlots,
        }),
      );
      colorSlots += stage.slots;
    }
  }

  return Object.freeze({
    extensions: Object.freeze([...extensions]),
    fields: Object.freeze(fields),
    visualFieldKeys: Object.freeze(fields.filter((f) => f.nodes === "visual").map((f) => f.key)),
    colorStages: Object.freeze(colorStages),
    colorSlots,
  });
}
