// The editor's implementation of the extension contract in `@seam/core`'s
// `editor-api.ts`: the document tools an extension command receives, built
// on the editor's own run-aware edit helpers.

import type {
  Child,
  Composition,
  EditorTools,
  ResolvedChild,
  Seam,
  SeamFile,
} from "@seam/core";
import { keepRanges } from "./cutTool.js";
import {
  getNodeAtPath,
  parsePath,
  pathKey,
  removeNodesAtPaths,
  updateCompAtPath,
  updateNodeAtPath,
} from "./nodePath.js";

/** Every id in the document, bin bodies included. */
function collectIds(doc: SeamFile): Set<string> {
  const out = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const rec = node as { id?: unknown; children?: unknown; bin?: unknown };
    if (typeof rec.id === "string") out.add(rec.id);
    if (Array.isArray(rec.children)) rec.children.forEach(visit);
    if (Array.isArray(rec.bin)) rec.bin.forEach(visit);
  };
  visit(doc);
  return out;
}

export function createEditorTools(seam: Seam): EditorTools {
  return {
    updateNode: (doc, key, update) => updateNodeAtPath(doc, parsePath(key), update),

    appendChildren: (doc, containerKey, nodes) =>
      nodes.length === 0
        ? doc
        : updateCompAtPath(doc, parsePath(containerKey), (comp) => ({
            ...comp,
            children: [...(comp.children ?? []), ...nodes],
          })),

    removeNodes: (doc, keys) => removeNodesAtPaths(doc, keys.map(parsePath)),

    childSpans(doc, containerKey) {
      const container = containerKey === "" ? doc : getNodeAtPath(doc, parsePath(containerKey));
      if (!container || container.type !== "composition") return null;
      try {
        // The body on its own (root bin attached so `binItem`s resolve),
        // scripts off, uncropped: resolved children stay 1:1 with authored.
        const body: Composition = {
          type: "composition",
          children: (container as Composition).children ?? [],
          ...(doc.bin ? { bin: doc.bin } : {}),
        };
        const compiled = seam.compileSeamFile(body as SeamFile, { runScripts: false }).doc;
        return seam
          .resolveComposition(compiled as Composition, { uncropped: true })
          .children.map((c) => ({ start: c.timelineStart, end: c.timelineEnd }));
      } catch {
        return null;
      }
    },

    parentKey: (key) => pathKey(parsePath(key).slice(0, -1)),

    freshId(doc, base) {
      const ids = collectIds(doc);
      for (let n = 1; ; n++) {
        const candidate = `${base}-${n}`;
        if (!ids.has(candidate)) return candidate;
      }
    },

    keepRanges(doc, key, ranges) {
      const result = keepRanges(seam, doc, parsePath(key), ranges);
      return result.ok
        ? { ok: true, doc: result.doc, pieces: result.pieces.map(pathKey) }
        : result;
    },
  };
}

/**
 * Resolve the node at `key` on its own: wrapped in a synthetic root carrying
 * the document's bin / macros / canvas (so `binItem`s and `$$` references
 * resolve), scripts off, its placement dropped (its anchors point at siblings
 * that aren't in the wrapper). Its own window still applies, so a
 * composition's children come back cropped + rebased to what it shows. Null
 * when it can't be resolved.
 */
export function resolveStandalone(seam: Seam, doc: SeamFile, key: string): ResolvedChild | null {
  const node = getNodeAtPath(doc, parsePath(key));
  if (!node) return null;
  try {
    const { start: _start, offset: _offset, ...unplaced } = node as Child & {
      start?: unknown;
      offset?: unknown;
    };
    const wrapper: Composition = {
      type: "composition",
      children: [unplaced as Child],
      ...(doc.bin ? { bin: doc.bin } : {}),
      ...(doc.macros ? { macros: doc.macros } : {}),
      ...(doc.contentWidth != null ? { contentWidth: doc.contentWidth } : {}),
      ...(doc.contentHeight != null ? { contentHeight: doc.contentHeight } : {}),
    };
    const compiled = seam.compileSeamFile(wrapper as SeamFile, { runScripts: false }).doc;
    return seam.resolveComposition(compiled as Composition).children[0] ?? null;
  } catch {
    return null;
  }
}
