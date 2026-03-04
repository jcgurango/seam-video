import type { Justify } from "../types.js";

/**
 * Compute start offsets for each child based on justify mode.
 * Returns an array of timeline start positions.
 */
export function computeJustifyOffsets(
  justify: Justify,
  durations: number[],
  gap: number,
  containerDuration: number
): number[] {
  const n = durations.length;
  if (n === 0) return [];

  const totalContent = durations.reduce((a, b) => a + b, 0);
  const totalGap = gap * Math.max(0, n - 1);
  const usedSpace = totalContent + totalGap;

  switch (justify) {
    case "start": {
      const offsets: number[] = [];
      let pos = 0;
      for (let i = 0; i < n; i++) {
        offsets.push(pos);
        pos += durations[i] + gap;
      }
      return offsets;
    }

    case "end": {
      const offsets: number[] = [];
      let pos = containerDuration - usedSpace;
      for (let i = 0; i < n; i++) {
        offsets.push(pos);
        pos += durations[i] + gap;
      }
      return offsets;
    }

    case "center": {
      const offsets: number[] = [];
      let pos = (containerDuration - usedSpace) / 2;
      for (let i = 0; i < n; i++) {
        offsets.push(pos);
        pos += durations[i] + gap;
      }
      return offsets;
    }

    case "space-between": {
      if (n === 1) {
        return [0];
      }
      const spaceBetween = (containerDuration - totalContent) / (n - 1);
      const offsets: number[] = [];
      let pos = 0;
      for (let i = 0; i < n; i++) {
        offsets.push(pos);
        pos += durations[i] + spaceBetween;
      }
      return offsets;
    }
  }
}
