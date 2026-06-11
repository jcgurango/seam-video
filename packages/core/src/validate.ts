import { SeamFileSchema } from "./schema.js";
import { formatZodError } from "./format-error.js";
import type { SeamFile } from "./types.js";

export type ValidationResult =
  | { success: true; data: SeamFile }
  | { success: false; errors: string[] };

/** Strict Zod validation. The Composition schema accepts a passthrough
 *  `macros` field so source documents (pre-expansion) validate as-is —
 *  the editor can keep them in React state and round-trip them through
 *  save/load. Macro expansion runs later, inside `compileSeamFile`. */
export function validate(input: unknown): ValidationResult {
  const result = SeamFileSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data as SeamFile };
  }
  return {
    success: false,
    // Descends into `z.union` errors (Child, graphic objects, Length, …)
    // so failures report the offending node's real problem instead of
    // collapsing to Zod's top-level union message, `"Invalid input"`.
    errors: formatZodError(result.error),
  };
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
