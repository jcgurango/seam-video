import type { Underflow } from "../types.js";

export interface AdjustedRange {
  sourceIn: number;
  sourceOut: number;
  speed: number;
  /** `loop`: the range is one cycle, replayed until the target is filled. */
  loop?: true;
}

/**
 * Apply underflow strategy when target duration > natural duration.
 * Extends the clip to fill the target.
 */
export function applyUnderflow(
  strategy: Underflow,
  sourceIn: number,
  sourceOut: number,
  targetDuration: number
): AdjustedRange {
  const natural = sourceOut - sourceIn;

  switch (strategy) {
    case "extend-end":
      return {
        sourceIn,
        sourceOut: sourceIn + targetDuration,
        speed: 1,
      };

    case "extend-start":
      return {
        sourceIn: sourceOut - targetDuration,
        sourceOut,
        speed: 1,
      };

    case "extend-center": {
      const extra = targetDuration - natural;
      const extendEach = extra / 2;
      return {
        sourceIn: sourceIn - extendEach,
        sourceOut: sourceOut + extendEach,
        speed: 1,
      };
    }

    case "stretch":
      // Slow down to stretch natural content across target duration
      return {
        sourceIn,
        sourceOut,
        speed: natural / targetDuration,
      };

    case "loop":
      // Keep the natural range and rate; the caller marks the node as a
      // loop so consumers replay the cycle across the target.
      return { sourceIn, sourceOut, speed: 1, loop: true };
  }
}
