import { useCallback, useSyncExternalStore } from "react";
import type { CloudClient, CloudState } from "./CloudClient.js";

/**
 * Subscribe a component to a CloudClient's state. Returns null when there's no
 * client (cloud not configured). Backed by useSyncExternalStore, so the client
 * is the single source of truth and updates fan out to every consumer. The
 * subscribe/snapshot callbacks are memoized on `client` so the hook doesn't
 * re-subscribe every render.
 */
export function useCloud(client: CloudClient | null): CloudState | null {
  const subscribe = useCallback(
    (cb: () => void) => (client ? client.subscribe(cb) : () => {}),
    [client]
  );
  const getSnapshot = useCallback(
    () => (client ? client.getState() : null),
    [client]
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
