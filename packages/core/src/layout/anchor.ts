/**
 * The `start` grammar. Every node in a `children` array is placed at
 *
 *   (start ?? end of the previous node, 0 for the first) + offset
 *
 * `start` is either a bare number (absolute seconds in the container) or an
 * anchor string referencing a sibling by id:
 *
 *   "id"       start of `id`
 *   "id@50%"   that fraction of `id`'s output span (0% = start, 100% = end)
 *   "id@10"    source-time second 10 of `id` — the pre-trim/pre-speed media
 *              time of a clip/audio, the pre-window inner time of a
 *              composition (plain output seconds from the start for
 *              everything else)
 *
 * There is no offset in the expression: shifting is the node's `offset`.
 */
export type Start = number | string;

export type AnchorPoint =
  /** Fraction (0..1 for 0%..100%, may exceed) of the target's output span. */
  | { kind: "percent"; value: number }
  /** Seconds in the target's source timeline. */
  | { kind: "source"; value: number };

export type ParsedStart =
  | { kind: "absolute"; time: number }
  | { kind: "node"; id: string; point?: AnchorPoint };

const ANCHOR_RE = /^([^@]+)(?:@(-?\d+(?:\.\d+)?)(%)?)?$/;

export function parseStart(start: Start): ParsedStart {
  if (typeof start === "number") return { kind: "absolute", time: start };
  const m = ANCHOR_RE.exec(start);
  if (!m) throw new Error(`invalid start anchor "${start}"`);
  const id = m[1];
  if (m[2] == null) return { kind: "node", id };
  const n = parseFloat(m[2]);
  return {
    kind: "node",
    id,
    point: m[3] ? { kind: "percent", value: n / 100 } : { kind: "source", value: n },
  };
}

/** Inverse of `parseStart`. Numbers are trimmed of float noise (6 dp). */
export function formatStart(parsed: ParsedStart): Start {
  if (parsed.kind === "absolute") return parsed.time;
  if (!parsed.point) return parsed.id;
  const n = +parsed.point.value.toFixed(6);
  return parsed.point.kind === "percent"
    ? `${parsed.id}@${+(parsed.point.value * 100).toFixed(6)}%`
    : `${parsed.id}@${n}`;
}

/** The id a `start` anchors to, or `undefined` for absolute / unset. */
export function startAnchorId(start: Start | undefined): string | undefined {
  if (typeof start !== "string") return undefined;
  const parsed = parseStart(start);
  return parsed.kind === "node" ? parsed.id : undefined;
}

/** True when `children[index]` continues the previous node's run (no `start`
 *  of its own and not the first node). */
export function isRunMember(children: { start?: Start }[], index: number): boolean {
  return index > 0 && children[index].start == null;
}

/** Index of the head of the run `children[index]` belongs to. */
export function runHeadIndex(children: { start?: Start }[], index: number): number {
  let i = index;
  while (i > 0 && children[i].start == null) i--;
  return i;
}

/** The runs of a `children` array as `[headIndex, endIndexExclusive]` pairs,
 *  in array order. */
export function runsOf(children: { start?: Start }[]): [number, number][] {
  const runs: [number, number][] = [];
  for (let i = 0; i < children.length; i++) {
    if (i === 0 || children[i].start != null) runs.push([i, i + 1]);
    else runs[runs.length - 1][1] = i + 1;
  }
  return runs;
}
