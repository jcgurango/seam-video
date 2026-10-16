/**
 * A clip/audio's source span is `[in, out]`; `out` may be omitted when
 * `duration` is given, meaning `out = in + duration` (played at speed 1 — the
 * span then exactly fills the duration). Every reader of an authored `out`
 * goes through here so the shorthand is understood uniformly (resolver,
 * editor tools, mixers).
 */
export function clipOut(clip: { in: number; out?: number; duration?: number }): number {
  return clip.out ?? clip.in + (clip.duration ?? 0);
}
