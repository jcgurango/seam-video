/**
 * A clip/audio's source span is `[in, out]`; `out` may be omitted when
 * `duration` is given, meaning `out = in + duration` (played at speed 1 — the
 * span then exactly fills the duration). Every reader of an authored `out`
 * goes through here so the shorthand is understood uniformly (resolver,
 * editor tools, mixers).
 *
 * **Reverse playback**: a clip/audio plays backwards when `out < in`, or when
 * `duration` is negative (so `{in: 5, duration: -3}` ≡ `{in: 5, out: 2}`:
 * shows source 5 → 2). Either signal reverses; they don't cancel. The output
 * length is `|duration|` when set, else `|out − in| / speed`.
 */
export function clipOut(clip: { in: number; out?: number; duration?: number }): number {
  return clip.out ?? clip.in + (clip.duration ?? 0);
}

type AuthoredSpan = { in: number; out?: number; speed?: number; duration?: number };

/** True when the authored clip/audio plays its span backwards. */
export function clipIsReversed(clip: AuthoredSpan): boolean {
  return clipOut(clip) < clip.in || (clip.duration ?? 0) < 0;
}

/**
 * The authored span in playback order: `start` is the source time shown at
 * the node's first output instant, `end` at its last. Forward: `start < end`;
 * reversed: `start > end`. (`start === in` except for the redundant
 * `{in < out, duration < 0}` spelling, which plays `out → in`.)
 */
export function clipPlayRange(clip: AuthoredSpan): { start: number; end: number; reverse: boolean } {
  const out = clipOut(clip);
  const lo = Math.min(clip.in, out);
  const hi = Math.max(clip.in, out);
  return clipIsReversed(clip)
    ? { start: hi, end: lo, reverse: true }
    : { start: lo, end: hi, reverse: false };
}

/** Authored natural output length (seconds, ≥ 0): the span played at
 *  `speed`, ignoring `duration` (which is a target the overflow / underflow
 *  strategies fill — see the resolver). */
export function clipNaturalDuration(clip: AuthoredSpan): number {
  return Math.abs(clipOut(clip) - clip.in) / (clip.speed ?? 1);
}

// ── Resolved nodes ──────────────────────────────────────────────────────
// A resolved clip/audio always has `sourceIn < sourceOut` and `speed > 0`;
// direction rides on `reverse`. These are the only places that turn that into
// a time mapping — every consumer (compositor hosts, mixers, editor tools)
// goes through them.

type ResolvedSpan = { sourceIn: number; sourceOut: number; speed: number; reverse?: boolean };

/** Source time at the node's first output instant (of one cycle). */
export function resolvedPlayStart(node: ResolvedSpan): number {
  return node.reverse ? node.sourceOut : node.sourceIn;
}

/** SIGNED d(sourceTime)/d(node-local output time): `−speed` when reversed. */
export function resolvedSignedRate(node: ResolvedSpan): number {
  return node.reverse ? -node.speed : node.speed;
}

/** Source time shown `local` output seconds into the node's cycle (loop
 *  wrapping is the caller's — pass the wrapped time). */
export function clipSourceTime(node: ResolvedSpan, local: number): number {
  return resolvedPlayStart(node) + local * resolvedSignedRate(node);
}
