/**
 * Convert seconds to frames at the given FPS.
 */
export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

/**
 * Format a frame number as an MLT time string "HH:MM:SS.mmm" or frame-based.
 * For simplicity in V1, we use the frame count directly.
 */
export function framesToMltTime(frames: number): string {
  return String(frames);
}
