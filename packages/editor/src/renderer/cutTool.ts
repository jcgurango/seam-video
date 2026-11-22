// `keepRanges` — keep some ranges of a composition and drop the rest, in
// place. It is split + delete at scale, as one operation:
//
//   - the composition becomes a run of pieces, one per kept range, each the
//     same body with a different `in` / `out` window (so nothing inside it —
//     its captions, say — is touched, and any piece can be re-cut later);
//   - the first piece takes over the slot (`id`, `start`, `offset`); the rest
//     are plain run members, so the pieces butt together;
//   - a sibling anchored to the composition keeps pointing at the same
//     MOMENT: its anchor is retargeted to the piece that contains it. If that
//     moment was cut out, the sibling's run is removed, and so is anything
//     anchored to it in turn — exactly what deleting that piece by hand does.
//
// The result is what slicing at every range boundary and deleting the gaps
// produces, computed directly instead of re-resolving the document per cut.
//
// Ranges are in the composition's INNER time (the space of its `in` / `out`).
// They are sorted, clamped to the current window and merged first, so the
// kept pieces always play in source order.
//
// Pure — no React, no platform.

import {
  formatStart,
  parseStart,
  type Child,
  type Composition,
  type Seam,
  type SeamFile,
  type Start,
} from "@seam/core";
import type { BinEntry } from "./nodeBin.js";
import { editContainer, splitLast, type NodePath } from "./nodePath.js";
import { removeFromRuns, withDependents } from "./runEdit.js";

export interface KeepRange {
  /** Composition inner time, seconds. */
  start: number;
  end: number;
}

export type KeepRangesResult =
  | {
      ok: true;
      doc: SeamFile;
      /** Paths of the pieces, in order. */
      pieces: NodePath[];
    }
  | { ok: false; error: string };

/** Sort, clamp to `[lo, hi]` and merge touching / overlapping ranges. */
export function normalizeRanges(ranges: readonly KeepRange[], lo: number, hi: number): KeepRange[] {
  const clamped = ranges
    .map((r) => ({ start: Math.max(lo, Math.min(r.start, r.end)), end: Math.min(hi, Math.max(r.start, r.end)) }))
    .filter((r) => r.end - r.start > 1e-9)
    .sort((a, b) => a.start - b.start);
  const out: KeepRange[] = [];
  for (const r of clamped) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1e-9) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

type Placed = { id?: string; start?: Start; offset?: number };

/** A node heads a run when it is first or carries a `start`. */
const isRunHead = (children: Child[], i: number): boolean =>
  i === 0 || (children[i] as Placed).start !== undefined;

/** Every id in the document (for generating unique piece ids). */
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

function freshId(ids: Set<string>, base: string): string {
  let i = 2;
  while (ids.has(`${base}_${i}`)) i++;
  const id = `${base}_${i}`;
  ids.add(id);
  return id;
}

/** The composition's inner length — what `out` defaults to. `bin` is the
 *  scope its `binItem` (if any) resolves against. */
function innerLength(seam: Seam, comp: Composition, bin: BinEntry[]): number {
  try {
    const wrapper: Composition = {
      type: "composition",
      children: [comp as Child],
      ...(bin.length ? { bin } : {}),
    };
    const compiled = seam.compileSeamFile(wrapper as SeamFile, { runScripts: false }).doc;
    // Resolved as a root, a composition ignores its own window.
    return seam.resolveComposition((compiled.children ?? [])[0] as Composition).duration;
  } catch {
    return 0;
  }
}

/**
 * Keep `ranges` of the composition at `path`, replacing it in place with a
 * run of windowed pieces. See the file header for the rules.
 */
export function keepRanges(
  seam: Seam,
  doc: SeamFile,
  path: NodePath,
  ranges: readonly KeepRange[],
): KeepRangesResult {
  const split = splitLast(path);
  if (!split || split.last.field !== "children") {
    return { ok: false, error: "Select a composition to cut." };
  }
  const index = split.last.index;
  const rootBin = (doc.bin ?? []) as BinEntry[];
  const ids = collectIds(doc);

  let error: string | null = null;
  let pieceCount = 0;
  // Where the first piece lands (siblings removed before it shift the index).
  let piecesAt = index;
  const next = editContainer(doc, split.parent, rootBin, (container) => {
    const children = container.children ?? [];
    const target = children[index];
    if (!target || target.type !== "composition") {
      error = "Only a composition can be cut by ranges.";
      return null;
    }
    const comp = target as Composition & Placed;
    if (comp.underflow === "loop") {
      error = "A looping composition can't be cut by ranges.";
      return null;
    }
    const stretches =
      comp.duration == null ||
      ((comp.overflow ?? "stretch") === "stretch" && (comp.underflow ?? "stretch") === "stretch");
    if (!stretches) {
      error = "A composition with a trimmed or extended 'duration' can't be cut by ranges.";
      return null;
    }

    const in0 = comp.in ?? 0;
    const out0 = comp.out ?? innerLength(seam, comp, (container.bin ?? rootBin) as BinEntry[]);
    if (!(out0 > in0)) {
      error = "The composition has no length to cut.";
      return null;
    }
    const kept = normalizeRanges(ranges, in0, out0);
    if (kept.length === 0) {
      error = "Nothing to keep: no range falls inside the composition.";
      return null;
    }

    // ── the pieces ──
    const { id: origId, start, offset, ...body } = comp;
    const pieces: (Composition & Placed)[] = kept.map((r, i) => ({
      ...(body as Composition),
      in: r.start,
      out: r.end,
      // A stretched `duration` is shared out in proportion to the window.
      ...(comp.duration != null ? { duration: (comp.duration * (r.end - r.start)) / (out0 - in0) } : {}),
      // The first piece takes over the slot.
      ...(i === 0 && origId != null ? { id: origId } : {}),
      ...(i === 0 && start !== undefined ? { start } : {}),
      ...(i === 0 && offset != null ? { offset } : {}),
    }));
    pieceCount = pieces.length;

    // ── siblings anchored to the composition ──
    const pieceAt = (moment: number): number => {
      for (let i = 0; i < kept.length; i++) {
        // A moment on a shared boundary belongs to the piece that starts there;
        // the very end belongs to the last piece.
        const last = i === kept.length - 1;
        if (moment >= kept[i].start - 1e-9 && (moment < kept[i].end - 1e-9 || (last && moment <= kept[i].end + 1e-9))) {
          return i;
        }
      }
      return -1;
    };
    const idOf = (i: number): string => {
      const piece = pieces[i];
      if (!piece.id) piece.id = freshId(ids, origId ?? "piece");
      return piece.id;
    };

    const remove = new Set<number>();
    const rewritten = children.map((child, i): Child => {
      if (i === index || origId == null) return child;
      const placed = child as Child & Placed;
      if (typeof placed.start !== "string") return child;
      const parsed = parseStart(placed.start);
      if (parsed.kind !== "node" || parsed.id !== origId) return child;
      // The anchored moment, in the composition's inner time. A bare id is
      // its start; a percentage is that fraction of its window.
      const moment = !parsed.point
        ? in0
        : parsed.point.kind === "source"
          ? parsed.point.value
          : in0 + parsed.point.value * (out0 - in0);
      const p = pieceAt(moment);
      if (p < 0) {
        // Its moment is gone: the whole run it heads goes with it (the head
        // would only hand the dangling anchor to the next member).
        for (let k = i; k < children.length && (k === i || !isRunHead(children, k)); k++) {
          if (k !== index) remove.add(k);
        }
        return child;
      }
      const id = idOf(p);
      let nextStart: Start;
      if (!parsed.point) {
        // "The start of the node": only true of the piece when the moment is
        // that piece's own start; otherwise pin the moment explicitly.
        nextStart =
          Math.abs(moment - kept[p].start) < 1e-9
            ? id
            : formatStart({ kind: "node", id, point: { kind: "source", value: moment } });
      } else if (parsed.point.kind === "source") {
        nextStart = formatStart({ kind: "node", id, point: { kind: "source", value: moment } });
      } else {
        const len = kept[p].end - kept[p].start;
        nextStart = formatStart({
          kind: "node",
          id,
          point: { kind: "percent", value: len > 0 ? (moment - kept[p].start) / len : 0 },
        });
      }
      return nextStart === placed.start ? child : ({ ...placed, start: nextStart } as Child);
    });

    // Drop the runs anchored to cut-out moments (and their dependents), then
    // put the pieces where the composition was.
    const doomed = withDependents(rewritten, remove);
    doomed.delete(index);
    const pruned = removeFromRuns(rewritten, doomed);
    let at = index;
    for (const k of doomed) if (k < index) at--;
    piecesAt = at;
    const result = [...pruned.slice(0, at), ...(pieces as Child[]), ...pruned.slice(at + 1)];
    return { ...container, children: result };
  });

  if (error) return { ok: false, error };
  if (next === doc) return { ok: false, error: "Nothing changed." };

  return {
    ok: true,
    doc: next,
    pieces: Array.from({ length: pieceCount }, (_, i) => [
      ...split.parent,
      { field: "children" as const, index: piecesAt + i },
    ]),
  };
}
