// Debug harness: resolve a .seam exactly like the CLI render path and dump
// every resolved child with its output timing in seconds AND frames — using
// both Math.round and Math.ceil so frame-boundary mismatches between the
// sequential track (ceil) and overlay tracks (round) are visible.
//
//   npx tsx packages/cli/harness.mts <file.seam> [fps] [PROXY_ORIG:REPL ...]
import { readFileSync } from "node:fs";
import {
  compileSeamFile,
  parseSeamFile,
  resolveComposition,
  resolveSpatial,
  DEFAULT_CANVAS_WIDTH,
  DEFAULT_CANVAS_HEIGHT,
  type ResolvedChild,
  type ResolvedTimeline,
} from "@seam/core";

const [file, fpsArg, ...proxyArgs] = process.argv.slice(2);
const fps = fpsArg ? parseInt(fpsArg, 10) : 30;
const proxies = new Map<string, string>();
for (const p of proxyArgs) {
  const i = p.indexOf(":");
  if (i > 0) proxies.set(p.slice(0, i), p.slice(i + 1));
}

function applyProxies(children: ResolvedChild[]): void {
  for (const c of children) {
    if (c.type === "clip" || c.type === "static" || c.type === "audio") {
      const r = proxies.get(c.source);
      if (r != null) c.source = r;
    } else if (c.type === "composition") applyProxies(c.children);
  }
}

const parsed = parseSeamFile(readFileSync(file, "utf-8"));
if (!parsed.success) {
  console.error(parsed.errors);
  process.exit(1);
}
const { doc } = compileSeamFile(parsed.data);
const temporal = resolveComposition(doc);
const W = (temporal.contentWidth as number) ?? DEFAULT_CANVAS_WIDTH;
const H = (temporal.contentHeight as number) ?? DEFAULT_CANVAS_HEIGHT;
const timeline: ResolvedTimeline = resolveSpatial(temporal, W, H);
applyProxies(timeline.children);

const label = (c: ResolvedChild): string => {
  const src = (c as { source?: string }).source;
  if (src) return src.split("/").pop()!;
  if (c.type === "composition") {
    const inner = (c as { children?: ResolvedChild[] }).children?.[0];
    const isrc = inner && (inner as { source?: string }).source;
    return `comp(${isrc ? isrc.split("/").pop() : (inner?.type ?? "?")})`;
  }
  return c.type;
};

const rows = timeline.children.map((c, i) => {
  const s = c.timelineStart;
  const e = c.timelineEnd;
  return {
    i,
    type: c.type,
    label: label(c),
    start: s.toFixed(3),
    end: e.toFixed(3),
    // sequential track uses ceil; overlay tracks use round.
    fStartCeil: Math.ceil(s * fps),
    fEndCeil: Math.ceil(e * fps),
    fStartRound: Math.round(s * fps),
    fEndRound: Math.round(e * fps),
    opacity: (c as { opacity?: unknown }).opacity,
  };
});
rows.sort((a, b) => Number(a.start) - Number(b.start));

console.log(`fps=${fps}  children=${timeline.children.length}  duration=${timeline.duration.toFixed(3)}s`);
console.log(
  "idx type        label                              start    end      [ceil s..e]   [round s..e]   opacity",
);
for (const r of rows) {
  console.log(
    `${String(r.i).padStart(3)} ${r.type.padEnd(11)} ${r.label.slice(0, 34).padEnd(34)} ${r.start.padStart(8)} ${r.end.padStart(8)}  ${String(r.fStartCeil).padStart(5)}..${String(r.fEndCeil).padEnd(5)} ${String(r.fStartRound).padStart(5)}..${String(r.fEndRound).padEnd(5)}` +
      (r.opacity !== undefined ? `  op=${JSON.stringify(r.opacity)}` : ""),
  );
}
