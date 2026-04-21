import { useCallback, useRef, useState } from "react";

const MAX_HISTORY = 200;

export interface History<T> {
  current: T;
  push: (value: T) => void;
  replace: (value: T) => void;
  pushPast: (snapshot: T) => void;
  undo: () => T | null;
  redo: () => T | null;
  canUndo: boolean;
  canRedo: boolean;
  reset: (value: T) => void;
}

/**
 * Undo/redo stack. `push` adds a new entry (clearing any redo future).
 * `replace` overwrites the current entry without creating history
 * (useful for saves that remap paths but don't change semantics).
 */
export function useHistory<T>(initial: T): History<T> {
  const [current, setCurrent] = useState(initial);
  const pastRef = useRef<T[]>([]);
  const futureRef = useRef<T[]>([]);

  const push = useCallback((value: T) => {
    setCurrent((prev) => {
      pastRef.current.push(prev);
      if (pastRef.current.length > MAX_HISTORY) {
        pastRef.current.shift();
      }
      futureRef.current = [];
      return value;
    });
  }, []);

  const replace = useCallback((value: T) => {
    setCurrent(value);
  }, []);

  // Push a snapshot into past without modifying current. Used with `replace`
  // during drag: snapshot before drag starts, replace during, no commit at end.
  const pushPast = useCallback((snapshot: T) => {
    pastRef.current.push(snapshot);
    if (pastRef.current.length > MAX_HISTORY) pastRef.current.shift();
    futureRef.current = [];
  }, []);

  const undo = useCallback((): T | null => {
    const past = pastRef.current;
    if (past.length === 0) return null;
    const prev = past.pop()!;
    setCurrent((cur) => {
      futureRef.current.push(cur);
      return prev;
    });
    return prev;
  }, []);

  const redo = useCallback((): T | null => {
    const future = futureRef.current;
    if (future.length === 0) return null;
    const next = future.pop()!;
    setCurrent((cur) => {
      pastRef.current.push(cur);
      return next;
    });
    return next;
  }, []);

  const reset = useCallback((value: T) => {
    pastRef.current = [];
    futureRef.current = [];
    setCurrent(value);
  }, []);

  return {
    current,
    push,
    replace,
    pushPast,
    undo,
    redo,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
    reset,
  };
}
