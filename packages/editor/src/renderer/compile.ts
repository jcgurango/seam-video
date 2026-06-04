// Thin shim over the core compile pass — kept so existing editor
// imports don't need to flip to `@seam/core` all at once. The compile
// pass itself (bin / binItem / script resolution) now lives in core,
// since they're first-party schema fields rather than editor-only
// metadata conventions.

import { compileSeamFile } from "@seam/core";
import type {
  CompileError as CoreCompileError,
  CompileOptions as CoreCompileOptions,
  CompileResult as CoreCompileResult,
} from "@seam/core";

export type CompileError = CoreCompileError;
export type CompileOptions = CoreCompileOptions;
export type CompileResult = CoreCompileResult;

export function compileDocument(
  doc: Parameters<typeof compileSeamFile>[0],
  options: CompileOptions = {},
): CompileResult {
  return compileSeamFile(doc, options);
}

/** No-op identity. The new schema stores no rendered shadow alongside
 *  user-authored fields, so JSON editing sees the canonical form
 *  already. Kept as a passthrough so call sites don't need updating
 *  in this pass. */
export function stripForJsonEditing(
  node: unknown,
  _options: { isRoot?: boolean } = {},
): unknown {
  return node;
}
