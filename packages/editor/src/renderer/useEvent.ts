import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Stable-identity callback that always sees the latest closure. The
 * returned function never changes (so it can be passed to effects /
 * external subscriptions without re-binding), but calling it dispatches
 * to whatever was passed in on the most recent render.
 *
 * Same shape as React's experimental `useEffectEvent`. Drop-in once
 * that ships; until then this is the standard ref-mirror pattern.
 *
 * The mirror write happens in `useLayoutEffect` so calls dispatched
 * from layout effects in the same render see the new closure rather
 * than the previous one.
 */
export function useEvent<Args extends unknown[], R>(
  fn: (...args: Args) => R,
): (...args: Args) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: Args) => ref.current(...args), []);
}
