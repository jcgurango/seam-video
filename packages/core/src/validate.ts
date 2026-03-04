import { SeamFileSchema } from "./schema.js";
import type { SeamFile } from "./types.js";

export type ValidationResult =
  | { success: true; data: SeamFile }
  | { success: false; errors: string[] };

export function validate(input: unknown): ValidationResult {
  const result = SeamFileSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data as SeamFile };
  }
  return {
    success: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`
    ),
  };
}

export function parseSeamFile(json: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { success: false, errors: ["Invalid JSON"] };
  }
  return validate(parsed);
}
