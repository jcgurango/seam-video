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

import type { z, ZodTypeAny } from "zod";

/** Which nodes a contributed field lands on. `"visual"` = every node that
 *  draws: clip, static, text, rect, circle, composition and every
 *  extension node type. */
export type FieldTarget = "visual";

/** The CORE node types `"visual"` expands to (extension node types are
 *  visual too). */
export const VISUAL_NODE_TYPES = [
  "clip",
  "static",
  "text",
  "rect",
  "circle",
  "composition",
] as const;

/** Presentation + behaviour shared by every kind of field. */
interface FieldBase {
  /** The JSON key. Must not collide with a core field or another extension's. */
  readonly key: string;
  /** Present on a field contributed to EXISTING nodes (see
   *  {@link SeamExtension.fields}); absent on a node type's own fields
   *  ({@link NodeTypeDef.fields}). */
  readonly nodes?: FieldTarget;
  /** Accepts `[time, value, easing?]` keyframes as well as a plain value. */
  readonly animatable?: boolean;
  /** The key must be authored (node-type fields only). */
  readonly required?: boolean;
  /** Editor presentation hints. */
  readonly label?: string;
  readonly group?: string;
  readonly hint?: string;
}

export interface NumberFieldSpec extends FieldBase {
  readonly type: "number";
  readonly min?: number;
  readonly max?: number;
  /** The value an omitted field evaluates to — the editor's placeholder and
   *  where a slider rests. Required on a field a colour stage consumes. */
  readonly default?: number;
  readonly step?: number;
  readonly unit?: string;
  /** The slider's span when the valid range (`min`/`max`) is too wide to be a
   *  useful control; typed values may still go anywhere in the valid range. */
  readonly softMin?: number;
  readonly softMax?: number;
  /** Custom keyframe interpolation (default: linear `sampleNumber`). The
   *  editor uses it to show the value at the playhead; the extension uses
   *  the same function when it renders. */
  readonly sample?: (value: unknown, t: number, duration: number) => number;
}

export interface StringFieldSpec extends FieldBase {
  readonly type: "string";
  readonly default?: string;
  /** The value is a media path the host resolves (like a clip's `source`):
   *  export, remote .seam and proxies rewrite it. */
  readonly source?: boolean;
}

export interface EnumFieldSpec extends FieldBase {
  readonly type: "enum";
  readonly options: readonly string[];
  readonly default?: string;
}

export interface ColorFieldSpec extends FieldBase {
  readonly type: "color";
  readonly default?: string;
}

/** A `Length`: pixel number, `"p%"` or `"p% ± n"`. */
export interface LengthFieldSpec extends FieldBase {
  readonly type: "length";
  readonly default?: string;
  /** Percent substituted when only a pixel number is given (default 0). */
  readonly percentDefault?: number;
}

/** Schema-building helpers handed to a {@link CustomFieldSpec}. `z` is core's
 *  own Zod, so an extension needs no Zod dependency (or version) of its own. */
export interface SchemaHelpers {
  /** Wrap a value schema so it also accepts keyframe tuples. */
  keyframed<T extends ZodTypeAny>(schema: T): ZodTypeAny;
  /** The `Length` schema. */
  readonly length: ZodTypeAny;
}

/** A structured value (array / object / union) validated by a schema the
 *  extension builds. Gets no Properties row — JSON panel, or the extension's
 *  own editing surface. */
export interface CustomFieldSpec extends FieldBase {
  readonly type: "custom";
  /** Returns the schema of the VALUE (core adds optionality). Wrap it in
   *  `h.keyframed(...)` yourself when the field animates. */
  readonly schema: (zod: typeof z, h: SchemaHelpers) => ZodTypeAny;
  /** On a field contributed to visual nodes: this field positions the node
   *  inside an extension container (see {@link NodeTypeDef.createAnchors}),
   *  so its baked layout rect is meaningless and layout re-evaluates per frame. */
  readonly anchor?: boolean;
}

/** A first-class field contributed by an extension, declared as data. Authored
 *  flat on the node (`{ "type": "clip", "saturation": 0 }`). This ONE
 *  declaration drives schema validation, keyframing, per-frame sampling and
 *  the editor's Properties row. */
export type FieldSpec =
  | NumberFieldSpec
  | StringFieldSpec
  | EnumFieldSpec
  | ColorFieldSpec
  | LengthFieldSpec
  | CustomFieldSpec;

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

// ── Node types ──────────────────────────────────────────────────────

/** A resolved extension node as core hands it to hooks: the fields core
 *  guarantees. The node's own fields (`NodeTypeDef.fields`) sit flat beside
 *  them, authored values verbatim. */
export interface ExtensionNodeView {
  readonly type: string;
  readonly timelineStart: number;
  readonly timelineEnd: number;
  /** Extension fields authored on the node (e.g. a child's `pin`). */
  readonly ext?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** Where a child's `origin` lands inside its extension container's inner
 *  canvas (px, top-left origin), or null to lay it out normally. Called per
 *  child per frame with the child's own local time. */
export type ChildAnchor = (
  child: ExtensionNodeView,
  t: number,
  duration: number,
) => { x: number; y: number } | null;

/** A drawing surface: the subset of a canvas both hosts provide (a browser
 *  `HTMLCanvasElement` / `OffscreenCanvas`, `@napi-rs/canvas` in Node). */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: "2d"): unknown;
}

/** Random-access bytes of a media source (pmtiles' `Source` shape). */
export interface ByteSource {
  getKey(): string;
  getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string,
  ): Promise<{ data: ArrayBuffer; etag?: string; cacheControl?: string; expires?: string }>;
}

/** What a host gives a rasterizer. */
export interface RasterHost {
  /** A new canvas of the host's kind. */
  createCanvas(width: number, height: number): CanvasLike;
  /** Open a node's media `source` for byte-range reads; null when the host
   *  can't locate it (yet). */
  openSource(source: string): Promise<ByteSource | null>;
  /** Ask the host to repaint (async content landed). Hosts that await
   *  {@link NodeRasterizer.ensure} instead may ignore it. */
  requestRepaint(): void;
}

/** Produces the pixels of a node type that draws itself. One instance per
 *  host frame provider; owns whatever caches it needs. */
export interface NodeRasterizer {
  /** Draw the node at node-local `drawTime` and `width`×`height` from
   *  whatever is ready NOW and return its canvas (stable per node), or null
   *  when nothing can be drawn yet. Missing content is requested; the host
   *  hears about it through `requestRepaint`. Synchronous. */
  draw(node: ExtensionNodeView, drawTime: number, width: number, height: number): CanvasLike | null;
  /** Resolve once everything `draw` needs for these arguments is loaded.
   *  The offline renderer awaits it before each `draw`. */
  ensure?(node: ExtensionNodeView, drawTime: number, width: number, height: number): Promise<void>;
  /** Forget per-node state (a new timeline was set). Decoded media may stay. */
  clear?(): void;
  dispose(): void | Promise<void>;
}

/** A node type contributed by an extension.
 *
 *  Core gives every such node, without it being declared: `duration`
 *  (required — the node shows for exactly that long), the spatial fields,
 *  placement (`id` / `start` / `offset`), `metadata`, an inner canvas
 *  (`contentWidth` / `contentHeight`, default 100% of the parent), and every
 *  field extensions contribute to visual nodes. */
export interface NodeTypeDef {
  /** The JSON `type`. Must not collide with a core type or another extension's. */
  readonly type: string;
  /** The node's own fields. */
  readonly fields?: readonly FieldSpec[];
  /** The node has `children`: ordinary nodes of any type, placed like a
   *  composition's (runs + `start` anchors) in node-local time at speed 1,
   *  laid out against the node's inner canvas. They never extend the node. */
  readonly children?: boolean;
  /** The node draws itself: the render list emits one draw for it (beneath
   *  its children) at its inner-canvas size and node-local time, and the
   *  host gets the pixels from {@link NodeTypeDef.rasterizer}. */
  readonly draws?: boolean;
  /** Container only: build this frame's {@link ChildAnchor} from the node's
   *  state at node-local `t`. `inner` is the inner canvas in px. */
  readonly createAnchors?: (
    node: ExtensionNodeView,
    t: number,
    duration: number,
    inner: { width: number; height: number },
  ) => ChildAnchor | null;
  /** Hosts that render call this once per frame provider. Lives on the
   *  definition an extension's `./render` entry exports, so pure consumers
   *  (validate / resolve) never load the rasterizer's dependencies. */
  readonly rasterizer?: (host: RasterHost) => NodeRasterizer;
  /** Editor: timeline block colours. */
  readonly editor?: { readonly color: string; readonly border: string; readonly label?: string };
  /** Editor: files that become this node when dropped / imported. */
  readonly import?: {
    /** Lower-case extensions without the dot (`["pmtiles"]`). */
    readonly extensions: readonly string[];
    /** Read by byte range straight from storage — never loaded whole or
     *  given a blob URL. */
    readonly byteRange?: boolean;
    /** The node to insert for an imported file at `source`. `defaults`
     *  carries the host's default length for a still. */
    create(source: string, defaults: { duration: number }): Record<string, unknown>;
  };
}

/** An extension. */
export interface SeamExtension {
  /** Unique within an instance; duplicate names are a registration error. */
  readonly name: string;
  /** Fields added to existing nodes. */
  readonly fields?: readonly FieldSpec[];
  readonly colorStage?: ColorStage;
  /** New node types. */
  readonly nodes?: readonly NodeTypeDef[];
}

export type RegisteredField = FieldSpec & {
  /** Name of the contributing extension. */
  readonly extension: string;
};

export interface RegisteredColorStage extends ColorStage {
  readonly extension: string;
  /** First `vec4f` slot of this stage in the shared `ext` uniform array. */
  readonly offset: number;
}

export interface RegisteredNodeType extends NodeTypeDef {
  readonly extension: string;
}

export interface Registry {
  readonly extensions: readonly SeamExtension[];
  /** Fields contributed to existing (visual) nodes, in registration order. */
  readonly fields: readonly RegisteredField[];
  /** Keys of {@link Registry.fields}, in registration order. */
  readonly visualFieldKeys: readonly string[];
  /** Keys of the visual fields flagged `anchor`. */
  readonly anchorFieldKeys: readonly string[];
  readonly colorStages: readonly RegisteredColorStage[];
  /** Total `vec4f` slots across all colour stages. */
  readonly colorSlots: number;
  /** Contributed node types by `type`. */
  readonly nodeTypes: ReadonlyMap<string, RegisteredNodeType>;
}

/** The node types core itself defines. */
export const CORE_NODE_TYPES = [
  "clip",
  "audio",
  "static",
  "data",
  "text",
  "rect",
  "circle",
  "composition",
] as const;

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildRegistry(extensions: readonly SeamExtension[]): Registry {
  const names = new Set<string>();
  const fields: RegisteredField[] = [];
  const owners = new Map<string, string>();
  const colorStages: RegisteredColorStage[] = [];
  const entries = new Map<string, string>();
  const nodeTypes = new Map<string, RegisteredNodeType>();
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
      checkField(ext.name, f);
      if (f.nodes !== "visual") {
        throw new Error(
          `Extension "${ext.name}": field "${f.key}" needs \`nodes: "visual"\` (the only target)`,
        );
      }
      const owner = owners.get(f.key);
      if (owner != null) {
        throw new Error(
          `Extension "${ext.name}": field "${f.key}" is already contributed by "${owner}"`,
        );
      }
      owners.set(f.key, ext.name);
      fields.push(Object.freeze({ ...f, extension: ext.name }));
    }

    for (const def of ext.nodes ?? []) {
      if (!KEY_RE.test(def.type)) {
        throw new Error(`Extension "${ext.name}": "${def.type}" is not a valid node type`);
      }
      if ((CORE_NODE_TYPES as readonly string[]).includes(def.type)) {
        throw new Error(`Extension "${ext.name}": node type "${def.type}" is a core type`);
      }
      const other = nodeTypes.get(def.type);
      if (other) {
        throw new Error(
          `Extension "${ext.name}": node type "${def.type}" is already contributed by "${other.extension}"`,
        );
      }
      const seen = new Set<string>();
      for (const f of def.fields ?? []) {
        checkField(ext.name, f);
        if (f.nodes != null) {
          throw new Error(
            `Extension "${ext.name}": "${def.type}.${f.key}" is the node's own field — drop \`nodes\``,
          );
        }
        if (seen.has(f.key)) {
          throw new Error(`Extension "${ext.name}": "${def.type}" declares "${f.key}" twice`);
        }
        seen.add(f.key);
      }
      if (def.createAnchors && !def.children) {
        throw new Error(
          `Extension "${ext.name}": "${def.type}" has createAnchors but no children`,
        );
      }
      nodeTypes.set(def.type, Object.freeze({ ...def, extension: ext.name }));
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
    visualFieldKeys: Object.freeze(fields.map((f) => f.key)),
    anchorFieldKeys: Object.freeze(
      fields.filter((f) => f.type === "custom" && f.anchor === true).map((f) => f.key),
    ),
    colorStages: Object.freeze(colorStages),
    colorSlots,
    nodeTypes,
  });
}

function checkField(extension: string, f: FieldSpec): void {
  if (!KEY_RE.test(f.key)) {
    throw new Error(`Extension "${extension}": "${f.key}" is not a valid field key`);
  }
  if (f.type === "number" && f.min != null && f.max != null && f.min > f.max) {
    throw new Error(`Extension "${extension}": field "${f.key}" has min > max`);
  }
  if (f.type === "enum" && f.options.length === 0) {
    throw new Error(`Extension "${extension}": enum field "${f.key}" has no options`);
  }
}
