/**
 * mediabunny `Source` over a `BlockStore`, carrying a mutable **tag** that every
 * read is attributed to. The player's `Input` uses `LIVE_TAG`; the planner's
 * prefetch `Input` switches the tag to the cut it is currently warming, so the
 * cut's byte span is learned from the reads mediabunny makes for its packets.
 *
 * Built on the public `CustomSource` with its own cache + prefetch disabled, so
 * every demuxer read reaches the store exactly as issued (the store rounds to
 * blocks and does the read-ahead).
 */
import { CustomSource } from "mediabunny";
import { BlockStore, LIVE_TAG } from "./blockStore.js";

export class PlannedSource extends CustomSource {
  private readonly state: { tag: string };

  constructor(readonly store: BlockStore, tag: string = LIVE_TAG) {
    const state = { tag };
    super({
      getSize: () => store.size(),
      read: (start, end) => store.read(start, end, state.tag),
      maxCacheSize: 0,
      prefetchProfile: "none",
    });
    this.state = state;
  }

  get tag(): string {
    return this.state.tag;
  }

  set tag(tag: string) {
    this.state.tag = tag;
  }
}
