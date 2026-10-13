import type { ResolvedLoop } from "../resolved-types.js";

/**
 * Loop time helpers shared by every consumer of a looping node (`underflow:
 * "loop"`): the compositor (per-frame content time), the two audio mixers
 * and the preview's clip collector (unrolled iterations), the editor's
 * playhead descent, and the flattener.
 */

/** Content-local time for node-local output time `t`: wraps into one cycle
 *  when the node loops, identity otherwise. */
export function loopLocalTime(loop: ResolvedLoop | undefined, t: number): number {
  if (!loop || loop.period <= 0) return t;
  const u = (t + loop.phase) % loop.period;
  return u < 0 ? u + loop.period : u;
}

/** One replay of a looping node's cycle, in node-local output seconds. */
export interface LoopIteration {
  /** 0-based cycle index. */
  index: number;
  /** Where this cycle is visible within the node: `[start, end)` ⊂ `[0, span)`. */
  start: number;
  end: number;
  /** Content time at `start` (non-zero for the first cycle after a crop). */
  offset: number;
}

/** Enumerate the cycles a looping node plays across `span` node-local
 *  output seconds. A non-looping node yields the single iteration
 *  `[0, span)`. Each cycle's content runs `offset .. offset + (end − start)`. */
export function loopIterations(loop: ResolvedLoop | undefined, span: number): LoopIteration[] {
  if (!loop || loop.period <= 0 || span <= 0) {
    return [{ index: 0, start: 0, end: Math.max(0, span), offset: 0 }];
  }
  const out: LoopIteration[] = [];
  const EPS = 1e-9;
  // The first cycle starts `phase` seconds into its content.
  let start = 0;
  let offset = loop.phase;
  let index = 0;
  while (start < span - EPS) {
    const end = Math.min(span, start + (loop.period - offset));
    out.push({ index, start, end, offset });
    start = end;
    offset = 0;
    index++;
  }
  return out;
}
