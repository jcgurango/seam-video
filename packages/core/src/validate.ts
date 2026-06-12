import { SeamFileSchema } from "./schema.js";
import { formatZodError } from "./format-error.js";
import { expandMacros } from "./macros.js";
import type { SeamFile } from "./types.js";

export type ValidationResult =
  | { success: true; data: SeamFile }
  | { success: false; errors: string[] };

/** Strict Zod validation, run against the *macro-expanded* document.
 *
 *  Macros are a pre-validation substitution pass: a `"$$NAME"` placeholder
 *  can legitimately sit in a position whose schema type the bare string can't
 *  satisfy — e.g. an array-valued points macro spliced into `MapPath.points`,
 *  which requires `[number, number]` tuples. Validating the raw source would
 *  reject every such (valid) document, so we expand first and validate the
 *  result.
 *
 *  On success we return the **authored source** (with the `macros` block and
 *  `$$` references intact), *not* the expanded/defaulted form: the editor
 *  keeps this as canonical state so the JSON view round-trips exactly what the
 *  user wrote, and `compileSeamFile` re-expands downstream. (Zod's schema
 *  defaults therefore aren't baked into the returned doc — which matches how
 *  the editor already operates on documents after an in-place edit, and the
 *  renderer/preview null-guard every optional field.) */
export function validate(input: unknown): ValidationResult {
  const expanded = expandMacros(input);
  if (!expanded.success) {
    return { success: false, errors: expanded.errors };
  }
  const result = SeamFileSchema.safeParse(expanded.data);
  if (!result.success) {
    return {
      success: false,
      // Descends into `z.union` errors (Child, graphic objects, Length, …)
      // so failures report the offending node's real problem instead of
      // collapsing to Zod's top-level union message, `"Invalid input"`.
      errors: formatZodError(result.error),
    };
  }
  return { success: true, data: input as SeamFile };
}

/** Source-document entry point: parse JSON, validate. Does NOT expand
 *  macros — that happens at the compile boundary. The editor needs the
 *  source form preserved so the JSON editor can show what the user
 *  authored. */
export function parseSeamFile(json: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { success: false, errors: ["Invalid JSON"] };
  }
  return validate(parsed);
}
