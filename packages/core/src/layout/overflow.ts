import type { Overflow } from "../types.js";

export interface AdjustedRange {
  sourceIn: number;
  sourceOut: number;
  speed: number;
}

/**
 * Apply overflow strategy when target duration < natural duration.
 * Trims the clip to fit within the target.
 */
export function applyOverflow(
  strategy: Overflow,
  sourceIn: number,
  sourceOut: number,
  targetDuration: number
): AdjustedRange {
  const natural = sourceOut - sourceIn;

  switch (strategy) {
    case "trim-end":
      return {
        sourceIn,
        sourceOut: sourceIn + targetDuration,
        speed: 1,
      };

    case "trim-start":
      return {
        sourceIn: sourceOut - targetDuration,
        sourceOut,
        speed: 1,
      };

    case "trim-center": {
      const excess = natural - targetDuration;
      const trimEach = excess / 2;
      return {
        sourceIn: sourceIn + trimEach,
        sourceOut: sourceOut - trimEach,
        speed: 1,
      };
    }

    case "stretch":
      // Speed up to fit natural content into target duration
      return {
        sourceIn,
        sourceOut,
        speed: natural / targetDuration,
      };
  }
}
