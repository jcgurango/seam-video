/** Seconds before a node's start time to mount it in the DOM for preloading */
export const PRELOAD_AHEAD = 1;

/**
 * Whether a node should be mounted in the DOM for preloading.
 * Mounts the node PRELOAD_AHEAD seconds before its start time.
 */
export function shouldBeInDOM(
  currentTime: number,
  nodeStart: number,
  nodeEnd: number
): boolean {
  return currentTime >= nodeStart - PRELOAD_AHEAD && currentTime < nodeEnd;
}
