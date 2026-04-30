const PERCENT_RE = /^(-?\d+(?:\.\d+)?)%$/;

export function parseDimension(
  input: number | string
): { value: number; unit: "px" | "%" } {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new Error(`Invalid dimension: ${input}`);
    }
    return { value: input, unit: "px" };
  }
  const match = input.match(PERCENT_RE);
  if (!match) {
    throw new Error(`Invalid dimension: "${input}" (must be a number or "<n>%")`);
  }
  return { value: parseFloat(match[1]), unit: "%" };
}

export function resolveDimension(
  input: number | string,
  parentSize: number
): number {
  const { value, unit } = parseDimension(input);
  if (unit === "%") return (value / 100) * parentSize;
  return value;
}
