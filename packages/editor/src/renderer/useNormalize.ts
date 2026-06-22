// Drives the peak-normalize tool: for each selected clip/audio node, decode its
// [in, out] source region (mediabunny), measure the peak, and write a `volume`
// dB gain that brings it to -1 dBFS. Decoding is I/O, so this is async; the
// whole batch commits as a single undo step. A failed decode (missing source,
// silence) is collected as a non-fatal error and the rest proceed.

import { useCallback, useState } from "react";
import type { SeamFile, Clip, Audio } from "@seam/core";
import type { Platform } from "./platform/index.js";
import { decodeMonoRange } from "./audioExtract.js";
import { getNodeAtPath, parsePath, type NodePath } from "./nodePath.js";
import {
  formatDbVolume,
  normalizeTargets,
  peakGainDb,
  setNodeVolume,
  TARGET_PEAK_DB,
} from "./normalizeTool.js";

export interface UseNormalizeOptions {
  platform: Platform;
  basePath: string;
  /** Commit the normalized document (one undo step for the whole batch). */
  onDocumentChange: (doc: SeamFile) => void;
}

export interface UseNormalize {
  /** True while a normalize batch is decoding. */
  normalizing: boolean;
  /** Non-fatal per-node failures from the last run. */
  errors: string[];
  run: (doc: SeamFile, selectionKeys: string[]) => Promise<void>;
}

export function useNormalize(opts: UseNormalizeOptions): UseNormalize {
  const { platform, basePath, onDocumentChange } = opts;
  const [normalizing, setNormalizing] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const run = useCallback(
    async (doc: SeamFile, selectionKeys: string[]) => {
      const targets: NodePath[] = normalizeTargets(
        doc,
        selectionKeys.map(parsePath),
      );
      if (targets.length === 0) return;

      setErrors([]);
      setNormalizing(true);
      const errs: string[] = [];
      let working = doc;

      for (const path of targets) {
        // Re-read from the working doc each iteration (paths are stable —
        // we only edit a node's `volume`, never the tree shape).
        const node = getNodeAtPath(working, path) as Clip | Audio | undefined;
        if (!node) continue;
        try {
          const url = platform.resolveSource(node.source, basePath);
          const { samples } = await decodeMonoRange(url, node.in, node.out);
          const gainDb = peakGainDb(samples, TARGET_PEAK_DB);
          if (gainDb == null) {
            errs.push(`${node.source}: silent — left unchanged`);
            continue;
          }
          working = setNodeVolume(working, path, formatDbVolume(gainDb));
        } catch (err) {
          errs.push(
            `${node.source}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (working !== doc) onDocumentChange(working);
      setNormalizing(false);
      if (errs.length > 0) setErrors(errs);
    },
    [platform, basePath, onDocumentChange],
  );

  return { normalizing, errors, run };
}
