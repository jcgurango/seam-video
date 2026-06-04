// One canonical predicate for "node with a `source` field that points
// at a file on disk / in OPFS". Used everywhere we need to walk the
// document to find external media — for blob URL preloading, Save As
// path rewriting, and zip-export bundling.
//
// Source-time-aware tools (split, attach, JSON inspector) stay on the
// narrower `clip | audio` check because they care about in/out trim,
// which `static` doesn't have.

import type { Audio, Child, Clip, Static } from "@seam/core";

/** True when `child` carries an external `source` reference to a media
 *  file. Currently: `clip`, `audio`, or `static`. */
export function isMediaSource(child: Child): child is Clip | Audio | Static {
  return (
    child.type === "clip" || child.type === "audio" || child.type === "static"
  );
}
