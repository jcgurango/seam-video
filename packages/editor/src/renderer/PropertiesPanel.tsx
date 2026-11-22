// Properties accordion section: edit the authored properties of the selected
// node(s). Adobe-style multi-select — the header says how many of what, the
// rows are the properties every selected type shares, a value is shown when
// all nodes agree and "—" (mixed) otherwise; typing into a mixed field sets
// every node. Omitted keys show their effective default as a placeholder.
// `Length` properties get a percent input and a pixel input side by side.
// Animatable properties carry a diamond toggle that turns the control into a
// stack of [time] [value] [easing] rows. The stack is playhead-aware: the
// keyframe the playhead sits on is highlighted (that is the one the viewport
// gizmo edits), each row has a go-to that snaps the playhead onto it, and
// "+ keyframe" inserts at the playhead, in time order.
//
// All the data logic (catalog, mixed detection, length splitting, keyframe
// patching, multi-node write-back + validation) lives in propertyCatalog.ts.

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  isKeyframed,
  type Child,
  type Distort,
  type Inset,
  type Length,
  type ResolvedTimeline,
  type SeamFile,
  type TimeExpr,
} from "@seam/core";
import { useTimeline } from "@seam/preview";
import {
  DISTORT_CORNERS,
  GROUP_ORDER,
  INSET_EDGES,
  rootProps,
  addKeyframe,
  applyPropertyEdit,
  formatNumber,
  joinLength,
  parseNumberInput,
  patchKeyframe,
  pointAxis,
  propState,
  removeKeyframe,
  selectedNodes,
  sharedProps,
  splitLength,
  summarizeSelection,
  toAnimated,
  toStatic,
  insetEdges,
  withDistortCoord,
  withInsetEdge,
  withPointAxis,
  type AnyKeyframe,
  type Axis,
  type LengthParts,
  type PropDef,
  type PropGroup,
} from "./propertyCatalog.js";
import type { NodePath } from "./nodePath.js";
import {
  activeKeyframeIndex,
  insertKeyframeAtPlayhead,
  interpolatedValue,
  keyframeMoment,
  nodeClock,
} from "./playheadKeyframe.js";
import { useSeam } from "./seamContext.js";

interface PropertiesPanelProps {
  document: SeamFile;
  /** Path keys of the selected nodes (`children.0`, …). */
  selection: string[];
  /** Commit an edited document WITHOUT clearing the selection. With
   *  `coalesce`, the edit replaces the current history entry instead of
   *  adding one — the later ticks of one slider drag. */
  onDocumentEdit: (next: SeamFile, opts?: EditOptions) => void;
  /** The editor timeline (scripts off, root `uncropped`) — maps the playhead
   *  into each node's keyframe time. Without it the keyframe stacks lose
   *  their playhead features (highlight, go-to, insert-at-playhead). */
  timeline?: ResolvedTimeline | null;
}

/** How an edit lands in undo history. */
export interface EditOptions {
  /** Replace the current history entry instead of pushing a new one. */
  coalesce?: boolean;
}

/** What a keyframe stack needs to place the playhead in a node's own time. */
interface PlayheadSource {
  timeline: ResolvedTimeline | null;
  document: SeamFile;
  /** Authored node → its path (the updater receives the node). */
  pathOf: Map<Child, NodePath>;
  /** The first selected node — drives the highlight and go-to. */
  primary: NodePath | null;
}
const PlayheadContext = createContext<PlayheadSource | null>(null);

const EASINGS = [
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "discrete",
  "step-start",
];

const MIXED = "—";

export default function PropertiesPanel({
  document,
  selection,
  onDocumentEdit,
  timeline = null,
}: PropertiesPanelProps) {
  const seam = useSeam();
  // No selection → the root composition itself (its own, parentless catalog).
  const isRoot = selection.length === 0;
  const selected = useMemo(() => selectedNodes(document, selection), [document, selection]);
  const nodes = useMemo(() => selected.map((s) => s.node), [selected]);
  const paths = useMemo(() => selected.map((s) => s.path), [selected]);
  const props = useMemo(
    () => (isRoot ? rootProps(seam) : sharedProps(seam, nodes)),
    [seam, isRoot, nodes],
  );
  const summary = useMemo(() => summarizeSelection(nodes), [nodes]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [selection]);
  const playhead = useMemo<PlayheadSource>(
    () => ({
      timeline,
      document,
      pathOf: new Map(selected.map((s) => [s.node, s.path])),
      primary: selected[0]?.path ?? null,
    }),
    [timeline, document, selected],
  );

  const edit = (
    key: string,
    update: (current: unknown, node: Child) => unknown,
    opts?: EditOptions,
  ) => {
    const result = applyPropertyEdit(seam, document, paths, key, update);
    if (result.errors) {
      setError(result.errors[0] ?? "invalid value");
      return;
    }
    setError(null);
    if (result.doc !== document) onDocumentEdit(result.doc, opts);
  };

  if (selected.length === 0) {
    return (
      <div style={{ padding: 12, color: "#777" }}>
        Nothing selected resolves to a node.
      </div>
    );
  }

  const groups = new Map<PropGroup, PropDef[]>();
  for (const def of props) {
    const list = groups.get(def.group) ?? [];
    list.push(def);
    groups.set(def.group, list);
  }

  return (
    <PlayheadContext.Provider value={playhead}>
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 12px 16px" }}>
      <div style={{ color: "#999", fontSize: 11, marginBottom: 8 }}>
        {isRoot
          ? "Root composition"
          : summary.count === 1
          ? `1 ${nodes[0].type}`
          : `${summary.count} selected · ${summary.types
              .map((t) => `${t.count} ${t.type}${t.count > 1 ? "s" : ""}`)
              .join(", ")}`}
        {summary.types.length > 1 && (
          <span style={{ color: "#666" }}> · shared properties only</span>
        )}
      </div>
      {error && (
        <div
          style={{
            background: "#3a1f1f",
            border: "1px solid #7a3030",
            color: "#f0b0b0",
            borderRadius: 4,
            padding: "6px 8px",
            marginBottom: 8,
            fontSize: 11,
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </div>
      )}
      {[
        ...GROUP_ORDER.filter((g) => groups.has(g)),
        // Groups named by extensions, after core's, in first-appearance order.
        ...[...groups.keys()].filter((g) => !GROUP_ORDER.includes(g)),
      ].map((g) => (
        <div key={g} style={{ marginBottom: 10 }}>
          <div
            style={{
              color: "#777",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              margin: "6px 0 4px",
            }}
          >
            {g}
          </div>
          {groups.get(g)!.map((def) => (
            <PropRow key={def.key} def={def} nodes={nodes} onEdit={(u, o) => edit(def.key, u, o)} />
          ))}
        </div>
      ))}
      {props.length === 0 && (
        <div style={{ color: "#777" }}>These node types share no editable properties.</div>
      )}
    </div>
    </PlayheadContext.Provider>
  );
}

// ── Rows ───────────────────────────────────────────────────────────

interface PropRowProps {
  def: PropDef;
  nodes: Child[];
  onEdit: (update: (current: unknown, node: Child) => unknown, opts?: EditOptions) => void;
}

function PropRow({ def, nodes, onEdit }: PropRowProps) {
  const state = propState(nodes, def.key);
  const value = state.kind === "same" ? state.value : undefined;
  const mixed = state.kind === "mixed";
  const animated = !mixed && isKeyframed(value as never);
  // Mixed where *every* node is animated: still show the toggle lit.
  const allAnimated =
    mixed && nodes.every((n) => isKeyframed((n as unknown as Record<string, unknown>)[def.key] as never));

  const toggleAnimate = () => {
    if (animated || allAnimated) {
      onEdit((cur) => toStatic(cur));
    } else {
      onEdit((cur) => toAnimated(cur, defaultValueFor(def)));
    }
  };

  return (
    <div
      title={def.hint}
      style={{
        display: "flex",
        alignItems: animated || allAnimated ? "flex-start" : "center",
        gap: 6,
        padding: "3px 0",
      }}
    >
      <div
        style={{
          width: 96,
          flexShrink: 0,
          color: "#bbb",
          fontSize: 11,
          paddingTop: animated || allAnimated ? 5 : 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {def.label}
      </div>
      {def.animatable ? (
        <AnimateToggle on={animated || allAnimated} onClick={toggleAnimate} />
      ) : (
        <div style={{ width: 16, flexShrink: 0 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        {animated ? (
          <KeyframeStack def={def} kfs={value as AnyKeyframe[]} onEdit={onEdit} />
        ) : allAnimated ? (
          <div style={{ color: "#777", fontSize: 11, paddingTop: 5 }}>
            {MIXED} different keyframes
          </div>
        ) : (
          <ValueControl def={def} value={value} mixed={mixed} slider onChange={(v, o) => onEdit(() => v, o)} onAxis={
            def.kind === "point"
              ? (axis, parts) =>
                  onEdit((cur) =>
                    withPointAxis(cur as never, axis, mergeLength(pointAxis(cur as never, axis), parts)),
                  )
              : undefined
          } onLength={
            def.kind === "length"
              ? (parts) => onEdit((cur) => mergeLength(cur as never, parts))
              : undefined
          } />
        )}
      </div>
    </div>
  );
}

/** The literal an omitted animatable key animates FROM (its effective
 *  default), for the static → animated conversion. */
function defaultValueFor(def: PropDef): unknown {
  switch (def.key) {
    case "origin":
      return "50%";
    case "translation":
      return 0;
    case "size":
    case "contentWidth":
    case "contentHeight":
      return "100%";
    case "rotation":
    case "cornerRadius":
    case "strokeWidth":
    case "latitude":
    case "longitude":
      return 0;
    case "opacity":
    case "volume":
    case "mapOpacity":
    case "zoom":
      return 1;
    case "inset":
      return 0;
    case "distort":
      return {};
    case "fontSize":
      return 16;
    case "lineHeight":
      return 19;
    case "fill":
    case "color":
    case "strokeColor":
      return "black";
    case "stroke":
    case "backgroundColor":
      return "transparent";
    default:
      return def.kind === "number" ? def.default ?? 0 : "";
  }
}

/** Merge a partial length edit (one of the two inputs) into the current
 *  authored value. `undefined` parts keep the current part. */
function mergeLength(current: unknown, patch: Partial<LengthParts>): Length | undefined {
  const cur = splitLength(current as Length | undefined);
  return joinLength({
    percent: patch.percent !== undefined ? patch.percent : cur.percent,
    px: patch.px !== undefined ? patch.px : cur.px,
  });
}

function AnimateToggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={on ? "Animated — click to make static (keeps the first keyframe)" : "Animate"}
      style={{
        width: 16,
        height: 16,
        flexShrink: 0,
        padding: 0,
        background: "none",
        border: "none",
        cursor: "pointer",
        color: on ? "#e8c45a" : "#555",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12">
        <path
          d="M6 0.5 L11.5 6 L6 11.5 L0.5 6 Z"
          fill={on ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth={1.2}
        />
      </svg>
    </button>
  );
}

// ── Value controls ─────────────────────────────────────────────────

interface ValueControlProps {
  def: PropDef;
  value: unknown;
  mixed: boolean;
  /** Whole-value replacement (`undefined` = unset). */
  onChange: (next: unknown, opts?: EditOptions) => void;
  /** Show a slider beside a ranged number (the row's main control only —
   *  keyframe rows stay compact). */
  slider?: boolean;
  /** Point kinds: one axis' percent/px part changed. */
  onAxis?: (axis: Axis, parts: Partial<LengthParts>) => void;
  /** Length kinds: percent/px part changed. */
  onLength?: (parts: Partial<LengthParts>) => void;
}

function ValueControl({ def, value, mixed, slider, onChange, onAxis, onLength }: ValueControlProps) {
  switch (def.kind) {
    case "number":
      if (slider && def.range) {
        return (
          <SliderInput
            value={mixed ? undefined : (value as number | undefined)}
            mixed={mixed}
            range={def.range}
            fallback={def.default ?? def.range.min}
            placeholder={mixed ? MIXED : def.placeholder ?? ""}
            unit={def.unit}
            onCommit={onChange}
          />
        );
      }
      return (
        <NumberInput
          value={mixed ? undefined : (value as number | undefined)}
          placeholder={mixed ? MIXED : def.placeholder ?? ""}
          unit={def.unit}
          onCommit={(n) => onChange(n)}
        />
      );
    case "scalar":
      return (
        <TextInput
          value={mixed ? "" : value == null ? "" : String(value)}
          placeholder={mixed ? MIXED : def.placeholder ?? ""}
          mono
          onCommit={(s) => {
            const t = s.trim();
            if (t === "") return onChange(undefined);
            const n = Number(t);
            onChange(Number.isFinite(n) ? n : t);
          }}
        />
      );
    case "string":
      return (
        <TextInput
          value={mixed ? "" : value == null ? "" : String(value)}
          placeholder={mixed ? MIXED : def.placeholder ?? ""}
          onCommit={(s) => onChange(s === "" ? undefined : s)}
        />
      );
    case "text": {
      if (!mixed && value != null && typeof value !== "string") {
        return <div style={{ color: "#777", fontSize: 11 }}>inline runs — edit in JSON</div>;
      }
      return (
        <TextInput
          value={mixed ? "" : value == null ? "" : String(value)}
          placeholder={mixed ? MIXED : def.placeholder ?? ""}
          multiline
          onCommit={(s) => onChange(s === "" ? undefined : s)}
        />
      );
    }
    case "enum":
      return (
        <select
          value={mixed ? "__mixed__" : value == null ? "" : String(value)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__mixed__") return;
            if (v === "") return onChange(undefined);
            // Numeric enums (orientation) are authored as numbers.
            onChange(def.key === "orientation" ? Number(v) : v);
          }}
          style={{ ...fieldStyle, width: "100%" }}
        >
          {mixed && <option value="__mixed__">{MIXED}</option>}
          <option value="">{def.placeholder ? `default (${def.placeholder})` : "default"}</option>
          {def.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "color":
      return (
        <ColorInput
          value={mixed ? "" : value == null ? "" : String(value)}
          placeholder={mixed ? MIXED : def.placeholder ?? ""}
          onCommit={(s) => onChange(s === "" ? undefined : s)}
        />
      );
    case "length":
      return (
        <LengthInput
          value={mixed ? undefined : (value as never)}
          mixed={mixed}
          percentPlaceholder={def.percentDefault != null ? String(def.percentDefault) : ""}
          pxPlaceholder="0"
          onPart={(parts) => onLength?.(parts)}
        />
      );
    case "inset": {
      const inset = mixed ? undefined : (value as Inset | undefined);
      const edges = insetEdges(inset);
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {INSET_EDGES.map((edge, i) => (
            <div key={edge} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 10, color: "#777", fontSize: 10 }} title={edge}>
                {edge[0].toUpperCase()}
              </span>
              <LengthInput
                value={edges[i]}
                mixed={mixed}
                percentPlaceholder="0"
                pxPlaceholder="0"
                onPart={(parts) => onChange(withInsetEdge(inset, i, mergeLength(edges[i], parts)))}
              />
            </div>
          ))}
        </div>
      );
    }
    case "distort": {
      const distort = mixed ? undefined : (value as Distort | undefined);
      const coord = (key: keyof Distort, label: string, home: number) => (
        <div key={key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, color: "#777", fontSize: 10 }}>{label}</span>
          <LengthInput
            value={distort?.[key]}
            mixed={mixed}
            percentPlaceholder={String(home)}
            pxPlaceholder="0"
            onPart={(parts) => onChange(withDistortCoord(distort, key, mergeLength(distort?.[key], parts)))}
          />
        </div>
      );
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {DISTORT_CORNERS.map((c) => (
            <React.Fragment key={c.x}>
              <div style={{ color: "#777", fontSize: 10 }}>{c.label}</div>
              {coord(c.x, "X", c.homeX)}
              {coord(c.y, "Y", c.homeY)}
            </React.Fragment>
          ))}
        </div>
      );
    }
    case "point": {
      const row = (axis: Axis) => (
        <div key={axis} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, color: "#777", fontSize: 10 }}>{axis.toUpperCase()}</span>
          <LengthInput
            value={mixed ? undefined : pointAxis(value as never, axis)}
            mixed={mixed}
            percentPlaceholder={def.percentDefault != null ? String(def.percentDefault) : ""}
            pxPlaceholder="0"
            onPart={(parts) => onAxis?.(axis, parts)}
          />
        </div>
      );
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {row("x")}
          {row("y")}
        </div>
      );
    }
  }
}

// ── Keyframe stack ─────────────────────────────────────────────────

function KeyframeStack({
  def,
  kfs,
  onEdit,
}: {
  def: PropDef;
  kfs: AnyKeyframe[];
  onEdit: (update: (current: unknown, node: Child) => unknown) => void;
}) {
  const seam = useSeam();
  const source = useContext(PlayheadContext);
  const { currentTime, seek } = useTimeline();
  const clockAt = (path: NodePath | null | undefined) =>
    source?.timeline && path ? nodeClock(seam, source.timeline, source.document, path, currentTime) : null;
  // Highlight + go-to follow the first selected node.
  const clock = clockAt(source?.primary);
  const active = activeKeyframeIndex(kfs, clock);

  const patch = (i: number, p: Parameters<typeof patchKeyframe>[2]) =>
    onEdit((cur) => patchKeyframe(cur as AnyKeyframe[], i, p));
  // A keyframe's value can't be unset: clearing a structured control leaves
  // its empty form.
  const kept = (v: unknown) =>
    v !== undefined ? v : def.kind === "distort" ? {} : def.kind === "inset" ? 0 : v;
  // Insert at the playhead, per node (each has its own clock). With no clock,
  // or a keyframe already at the playhead, fall back to appending. The new
  // keyframe copies its nearest neighbour; Shift takes the interpolated value
  // instead, so the motion through it is unchanged.
  const add = (interpolate: boolean) =>
    onEdit((cur, node) => {
      const list = cur as AnyKeyframe[];
      const at = clockAt(source?.pathOf.get(node));
      const value = at && interpolate ? interpolatedValue(list, at, def) : undefined;
      const inserted = at ? insertKeyframeAtPlayhead(list, at, value) : null;
      return inserted ? inserted.keyframes : addKeyframe(list);
    });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {kfs.map((kf, i) => (
        <div
          key={i}
          title={i === active ? "The playhead is on this keyframe" : undefined}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 4,
            background: i === active ? "#2b2614" : "#1c1c1c",
            border: `1px solid ${i === active ? "#e8c45a" : "#333"}`,
            borderRadius: 4,
            padding: 4,
          }}
        >
          <div style={{ width: 118, flexShrink: 0, display: "flex", flexDirection: "column", gap: 3 }}>
            <TimeInput value={kf[0]} onCommit={(t) => patch(i, { time: t })} />
            <button
              disabled={!clock || i === active}
              title="Move the playhead onto this keyframe"
              onClick={() => clock && seek(clock.toGlobal(keyframeMoment(kf[0], clock.duration)))}
              style={{
                ...fieldStyle,
                cursor: !clock || i === active ? "default" : "pointer",
                color: i === active ? "#e8c45a" : clock ? "#aaa" : "#555",
                padding: "2px 6px",
                fontSize: 10,
                textAlign: "left",
              }}
            >
              {i === active ? "◆ at playhead" : "→ go to"}
            </button>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <ValueControl
              def={def}
              value={kf[1]}
              mixed={false}
              onChange={(v) => patch(i, { value: kept(v) })}
              onAxis={(axis, parts) =>
                patch(i, {
                  value: withPointAxis(kf[1] as never, axis, mergeLength(pointAxis(kf[1] as never, axis), parts)),
                })
              }
              onLength={(parts) => patch(i, { value: mergeLength(kf[1], parts) })}
            />
          </div>
          <select
            value={kf[2] ?? "linear"}
            title="Easing of the segment arriving at this keyframe"
            onChange={(e) => patch(i, { easing: e.target.value === "linear" ? null : e.target.value })}
            style={{ ...fieldStyle, width: 74, flexShrink: 0 }}
          >
            {EASINGS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
            {kf[2] && !EASINGS.includes(kf[2]) && <option value={kf[2]}>{kf[2]}</option>}
          </select>
          <button
            title="Remove keyframe"
            onClick={() => onEdit((cur) => removeKeyframe(cur as AnyKeyframe[], i))}
            style={{ ...iconButtonStyle, marginTop: 2 }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        onClick={(e) => add(e.shiftKey)}
        title="Add a keyframe at the playhead (copies the nearest keyframe). Shift-click: use the interpolated value at the playhead."
        style={{
          ...fieldStyle,
          cursor: "pointer",
          color: "#aaa",
          textAlign: "left",
          padding: "3px 8px",
        }}
      >
        + keyframe
      </button>
    </div>
  );
}

/** A keyframe time: same percent + offset grammar as Length, so the same
 *  dual input — "%" of the node's span and "s" offset. */
function TimeInput({ value, onCommit }: { value: TimeExpr; onCommit: (t: TimeExpr) => void }) {
  const parts = splitLength(value);
  const commit = (patch: Partial<LengthParts>) => {
    const next = joinLength({
      percent: patch.percent !== undefined ? patch.percent : parts.percent,
      px: patch.px !== undefined ? patch.px : parts.px,
    });
    onCommit(next === undefined ? 0 : next);
  };
  return (
    <div style={{ display: "flex", gap: 3 }}>
      <NumberInput
        value={parts.percent ?? undefined}
        placeholder=""
        unit="%"
        compact
        onCommit={(n) => commit({ percent: n === undefined ? null : n })}
      />
      <NumberInput
        value={parts.px ?? undefined}
        placeholder="0"
        unit="s"
        compact
        onCommit={(n) => commit({ px: n === undefined ? null : n })}
      />
    </div>
  );
}

// ── Inputs ─────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  background: "#1a1a1a",
  border: "1px solid #444",
  borderRadius: 4,
  color: "#e0e0e0",
  padding: "3px 6px",
  fontSize: 11,
  fontFamily: "inherit",
  minWidth: 0,
  boxSizing: "border-box",
};

const iconButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#777",
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1,
  padding: "2px 4px",
  flexShrink: 0,
};

/** Percent and pixel inputs side by side. Each commits independently so
 *  the other part keeps whatever the author wrote. */
function LengthInput({
  value,
  mixed,
  percentPlaceholder,
  pxPlaceholder,
  onPart,
}: {
  value: unknown;
  mixed: boolean;
  percentPlaceholder: string;
  pxPlaceholder: string;
  onPart: (parts: Partial<LengthParts>) => void;
}) {
  const parts = splitLength(value as never);
  return (
    <div style={{ display: "flex", gap: 3, flex: 1 }}>
      <NumberInput
        value={mixed ? undefined : parts.percent ?? undefined}
        placeholder={mixed ? MIXED : percentPlaceholder}
        unit="%"
        onCommit={(n) => onPart({ percent: n === undefined ? null : n })}
      />
      <NumberInput
        value={mixed ? undefined : parts.px ?? undefined}
        placeholder={mixed ? MIXED : pxPlaceholder}
        unit="px"
        onCommit={(n) => onPart({ px: n === undefined ? null : n })}
      />
    </div>
  );
}

/** Text-backed number input: empty = unset. Commits on blur / Enter,
 *  Escape reverts; a non-number is rejected (reverted). */
/** A slider plus the exact number beside it. Dragging edits live as ONE undo
 *  step (the first tick pushes history, the rest coalesce into it);
 *  double-click resets to the default by unsetting the key. */
function SliderInput({
  value,
  mixed,
  range,
  fallback,
  placeholder,
  unit,
  onCommit,
}: {
  value: number | undefined;
  mixed: boolean;
  range: { min: number; max: number; step: number };
  /** Where the thumb rests when the key is unset. */
  fallback: number;
  placeholder: string;
  unit?: string;
  onCommit: (n: number | undefined, opts?: EditOptions) => void;
}) {
  const dragging = useRef(false);
  const shown = Math.min(range.max, Math.max(range.min, value ?? fallback));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={shown}
        onPointerDown={() => {
          dragging.current = false;
        }}
        onChange={(e) => {
          const n = Number(e.target.value);
          onCommit(n, { coalesce: dragging.current });
          dragging.current = true;
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onBlur={() => {
          dragging.current = false;
        }}
        onDoubleClick={() => onCommit(undefined)}
        title="Double-click to reset"
        style={{
          flex: 1,
          minWidth: 0,
          margin: 0,
          accentColor: "#5b8def",
          opacity: mixed || value == null ? 0.55 : 1,
        }}
      />
      <div style={{ width: 68, flexShrink: 0, display: "flex" }}>
        <NumberInput
          value={value}
          placeholder={placeholder}
          unit={unit}
          compact
          step={range.step}
          onCommit={(n) => onCommit(n)}
        />
      </div>
    </div>
  );
}

function NumberInput({
  value,
  placeholder,
  unit,
  compact,
  step: stepSize = 1,
  onCommit,
}: {
  value: number | undefined;
  placeholder: string;
  unit?: string;
  compact?: boolean;
  /** ↑/↓ nudge size (×10 with Shift). Default 1. */
  step?: number;
  onCommit: (n: number | undefined) => void;
}) {
  const text = formatNumber(value);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const commit = () => {
    const n = parseNumberInput(draft);
    if (n === null) {
      setDraft(text);
      return;
    }
    if (formatNumber(n) !== text) onCommit(n);
  };
  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            setDraft(text);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            const cur = parseNumberInput(draft);
            const base = typeof cur === "number" ? cur : Number(placeholder) || 0;
            const step = (e.shiftKey ? 10 : 1) * stepSize;
            const next = base + (e.key === "ArrowUp" ? step : -step);
            setDraft(formatNumber(next));
            onCommit(next);
            e.preventDefault();
          }
        }}
        style={{
          ...fieldStyle,
          width: "100%",
          paddingRight: unit ? (compact ? 16 : 22) : 6,
          fontFamily: "ui-monospace, monospace",
        }}
      />
      {unit && (
        <span
          style={{
            position: "absolute",
            right: 5,
            top: "50%",
            transform: "translateY(-50%)",
            color: "#666",
            fontSize: 10,
            pointerEvents: "none",
          }}
        >
          {unit}
        </span>
      )}
    </div>
  );
}

function TextInput({
  value,
  placeholder,
  mono,
  multiline,
  onCommit,
}: {
  value: string;
  placeholder: string;
  mono?: boolean;
  multiline?: boolean;
  onCommit: (s: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  const style: React.CSSProperties = {
    ...fieldStyle,
    width: "100%",
    ...(mono ? { fontFamily: "ui-monospace, monospace" } : {}),
  };
  if (multiline) {
    return (
      <textarea
        value={draft}
        placeholder={placeholder}
        rows={Math.min(6, Math.max(2, draft.split("\n").length))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(value);
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        style={{ ...style, resize: "vertical" }}
      />
    );
  }
  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={style}
    />
  );
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Free-text CSS colour with a swatch; the swatch opens the native picker
 *  (which only speaks 6-digit hex, so non-hex values just preview). */
function ColorInput({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (s: string) => void;
}) {
  const swatch = value || (placeholder !== MIXED && placeholder !== "none" ? placeholder : "");
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <label
        title="Pick"
        style={{
          width: 18,
          height: 18,
          flexShrink: 0,
          borderRadius: 3,
          border: "1px solid #555",
          background: swatch
            ? swatch
            : "repeating-conic-gradient(#444 0% 25%, #222 0% 50%) 0 0 / 8px 8px",
          cursor: "pointer",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <input
          type="color"
          value={HEX_RE.test(value) ? value : "#000000"}
          onChange={(e) => onCommit(e.target.value)}
          style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer" }}
        />
      </label>
      <TextInput value={value} placeholder={placeholder} mono onCommit={onCommit} />
    </div>
  );
}
