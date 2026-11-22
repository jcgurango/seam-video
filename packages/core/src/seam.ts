// `createSeam(extensions)` — the one entry point to everything in core that
// depends on the installed extensions: validating, compiling and resolving a
// document. A host (editor, preview, CLI, renderer) creates one instance at
// boot from its extension list and hands it to whatever needs it.
//
// Functions that do NOT depend on the extension set (`resolveSpatial`, the
// samplers, anchor / loop / clip-span helpers, …) stay plain exports.

import {
  buildRegistry,
  type Registry,
  type RegisteredColorStage,
  type RegisteredField,
  type RegisteredNodeType,
  type RegisteredOverlay,
  type SeamExtension,
} from "./registry.js";
import {
  validate,
  parseSeamFile,
  schemaFor,
  type ValidationResult,
} from "./validate.js";
import {
  compileSeamFile,
  type CompileOptions,
  type CompileResult,
} from "./compile.js";
import { resolveComposition, type ResolveOptions } from "./layout/resolve.js";
import type { Composition, SeamFile } from "./types.js";
import type { ResolvedTimeline } from "./resolved-types.js";

export interface Seam {
  /** The extensions this instance was created with, in registration order. */
  readonly extensions: readonly SeamExtension[];
  /** Every contributed field, in registration order — what the editor's
   *  Properties catalog and the render list's per-frame sampler read. */
  readonly fields: readonly RegisteredField[];
  /** Contributed colour stages in the order the shader runs them, each with
   *  its slot offset in the shared uniform array. Read by the compositor. */
  readonly colorStages: readonly RegisteredColorStage[];
  /** Total `vec4f` uniform slots the colour stages need. */
  readonly colorSlots: number;
  /** Contributed node types by `type` — the render list (containers, child
   *  anchoring, self-drawing nodes), the hosts (rasterizers) and the editor
   *  (catalog, import, block colours) read them. */
  readonly nodeTypes: ReadonlyMap<string, RegisteredNodeType>;
  /** Contributed overlays (layers drawn on top of a surface), bottom first. */
  readonly overlays: readonly RegisteredOverlay[];
  /** Strict schema validation of a (macro-expanded) document. Returns the
   *  authored source on success. */
  validate(input: unknown): ValidationResult;
  /** `JSON.parse` + {@link Seam.validate}. */
  parseSeamFile(json: string): ValidationResult;
  /** Expand macros, splice bin references, run scripts. */
  compileSeamFile(doc: SeamFile, options?: CompileOptions): CompileResult;
  /** Lay a compiled composition out in time. */
  resolveComposition(composition: Composition, options?: ResolveOptions): ResolvedTimeline;
}

export function createSeam(extensions: readonly SeamExtension[] = []): Seam {
  const registry: Registry = buildRegistry(extensions);
  // Build the schema now so a field that collides with a core key fails at
  // creation, not at the first validate.
  schemaFor(registry);
  return Object.freeze({
    extensions: registry.extensions,
    fields: registry.fields,
    colorStages: registry.colorStages,
    colorSlots: registry.colorSlots,
    nodeTypes: registry.nodeTypes,
    overlays: registry.overlays,
    validate: (input: unknown) => validate(registry, input),
    parseSeamFile: (json: string) => parseSeamFile(registry, json),
    compileSeamFile: (doc: SeamFile, options?: CompileOptions) =>
      compileSeamFile(registry, doc, options),
    resolveComposition: (composition: Composition, options?: ResolveOptions) =>
      resolveComposition(registry, composition, options),
  });
}
