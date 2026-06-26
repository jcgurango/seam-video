// Peak-normalize tool: analyze a clip/audio node's [in, out] source region and
// set its `volume` so the region's peak hits a target level (-1 dBFS). Pure
// math + a path-keyed volume writer; the decode/orchestration lives in
// `useNormalize.ts`. Compositions are out of scope (no single source to read).

import type { SeamFile, Clip, Audio } from "@seam/core";
import {
  getNodeAtPath,
  splitLast,
  updateCompAtPath,
  type NodePath,
} from "./nodePath.js";

/** Peak target for normalization, in dBFS. */
export const TARGET_PEAK_DB = -1;

/** A node normalization can act on: has a `source` + `[in, out]` trim. */
export function isNormalizable(node: { type: string }): node is Clip | Audio {
  return node.type === "clip" || node.type === "audio";
}

/**
 * Linear gain (in dB) that brings `samples`' peak to `targetDb`. Returns null
 * for silence (no peak to anchor to) so the caller can skip rather than apply
 * an infinite boost.
 */
export function peakGainDb(
  samples: Float32Array,
  targetDb: number = TARGET_PEAK_DB,
): number | null {
  let peak = 0;
  // Plain loop — `Math.max(...samples)` overflows the call stack on large
  // PCM arrays.
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (!(peak > 0)) return null;
  const peakDb = 20 * Math.log10(peak);
  return targetDb - peakDb;
}

/** Format a dB gain as a `volume` string the schema accepts (`"6.0dB"`). */
export function formatDbVolume(db: number): string {
  // Round to 0.1 dB; collapse a rounded "-0.0" to "0.0".
  const rounded = Math.round(db * 10) / 10;
  const safe = Object.is(rounded, -0) ? 0 : rounded;
  return `${safe.toFixed(1)}dB`;
}

/** Set `volume` on the clip/audio node at `path`, immutably. No-op if the path
 *  doesn't resolve to a clip/audio node. */
export function setNodeVolume(
  doc: SeamFile,
  path: NodePath,
  volume: string,
): SeamFile {
  const split = splitLast(path);
  if (!split) return doc;
  const { parent, last } = split;
  return updateCompAtPath(doc, parent, (comp) => {
    const arr =
      last.field === "children" ? comp.children ?? [] : comp.attachments ?? [];
    const node = arr[last.index];
    if (!node || !isNormalizable(node)) return comp;
    const newArr = arr.slice();
    newArr[last.index] = { ...node, volume };
    return last.field === "children"
      ? { ...comp, children: newArr }
      : { ...comp, attachments: newArr };
  });
}

/** The subset of `selectionKeys` (as paths) pointing at clip/audio nodes —
 *  the tool's actual targets. Compositions and other types are dropped. */
export function normalizeTargets(
  doc: SeamFile,
  selectionPaths: NodePath[],
): NodePath[] {
  return selectionPaths.filter((p) => {
    const node = getNodeAtPath(doc, p);
    return node != null && isNormalizable(node);
  });
}
