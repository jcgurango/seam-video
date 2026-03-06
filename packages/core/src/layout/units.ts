const DIMENSION_RE = /^(-?\d+(?:\.\d+)?)(px|%)?$/;

export function parseDimension(input: string): { value: number; unit: "px" | "%" } {
  const match = input.match(DIMENSION_RE);
  if (!match) {
    throw new Error(`Invalid dimension: "${input}"`);
  }
  return {
    value: parseFloat(match[1]),
    unit: (match[2] as "px" | "%" | undefined) ?? "px",
  };
}

export function resolveDimension(input: string, parentSize: number): number {
  const { value, unit } = parseDimension(input);
  if (unit === "%") {
    return (value / 100) * parentSize;
  }
  return value;
}
