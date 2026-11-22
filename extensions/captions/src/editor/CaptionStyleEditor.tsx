// The "Caption style" section of the Properties panel: the look of captions
// shown at a composition (`captionStyle`) — every textual property, the
// phrase rule, per-speaker overrides — plus presets.
//
// Presets live in the editor's storage (per installation). The composition
// only remembers the NAME of the preset it was styled from
// (`metadata.captionPreset`); the dropdown shows that name with a `*` while
// the composition's style differs from the stored one.
//
// An extension property editor (`EditorExtension.properties`): it sees the
// editor only through its props.

import React, { useEffect, useState } from "react";
import type { Child, EditorPropertyProps } from "@seam/core";
import { DEFAULT_CAPTION_STYLE, type CaptionStyle, type CaptionSurfaceStyle } from "../index.js";
import {
  formatBox,
  parseBox,
  presetNameOf,
  presetState,
  PRESETS_KEY,
  readPresets,
  tidyStyle,
  withStyle,
} from "../presets.js";

type Kind = "text" | "number" | "color" | "box" | readonly string[];

/** The style keys, in display order. An array kind is an enum. */
const FIELDS: ReadonlyArray<{ key: keyof CaptionStyle; label: string; kind: Kind }> = [
  { key: "fontFamily", label: "Font", kind: "text" },
  { key: "fontSize", label: "Size", kind: "number" },
  { key: "fontWeight", label: "Weight", kind: "text" },
  { key: "fontStyle", label: "Style", kind: ["normal", "italic"] },
  { key: "color", label: "Colour", kind: "color" },
  { key: "strokeColor", label: "Stroke", kind: "color" },
  { key: "strokeWidth", label: "Stroke width", kind: "number" },
  { key: "backgroundColor", label: "Background", kind: "color" },
  { key: "backgroundPadding", label: "Bg padding", kind: "box" },
  { key: "textDecoration", label: "Decoration", kind: ["none", "underline", "overline", "line-through"] },
  { key: "letterHeight", label: "Letter height", kind: "text" },
  { key: "lineHeight", label: "Line height", kind: "number" },
  { key: "textAlign", label: "Align", kind: ["left", "center", "right"] },
  { key: "verticalAlign", label: "Vertical", kind: ["top", "center", "bottom"] },
  { key: "padding", label: "Padding", kind: "box" },
];

const authoredStyle = (node: Child | undefined): CaptionSurfaceStyle | undefined =>
  (node as { captionStyle?: CaptionSurfaceStyle } | undefined)?.captionStyle ?? undefined;

export default function CaptionStyleEditor({ nodes, update, storage }: EditorPropertyProps) {
  // The first node is the one shown; an edit lands on every selected one.
  const node = nodes[0];
  const authored = authoredStyle(node);
  const style = authored ?? {};
  const presetName = node ? presetNameOf(node) : undefined;
  const presets = readPresets(storage.get(PRESETS_KEY));
  const state = presetState(presets, presetName, style);

  const [naming, setNaming] = useState<string | null>(null);
  const [newSpeaker, setNewSpeaker] = useState("");

  /** Write a style to every selected composition, keeping (or changing) the
   *  remembered preset name. */
  const commit = (next: CaptionSurfaceStyle, preset: string | undefined = presetName) =>
    update((n) => withStyle(n, next, preset));

  const setKey = (key: string, value: unknown) => commit({ ...style, [key]: value } as CaptionSurfaceStyle);

  const speakers = style.speakers ?? {};
  const setSpeaker = (name: string, override: CaptionStyle | null) => {
    const next = { ...speakers };
    if (override == null) delete next[name];
    else next[name] = override;
    commit({ ...style, speakers: next });
  };

  const savePreset = (name: string) => {
    storage.set(PRESETS_KEY, { ...presets, [name]: tidyStyle(style) });
    if (name !== presetName) commit(style, name);
  };

  // No style defined here: nothing to show but the way to define one.
  if (authored === undefined) {
    return (
      <div style={{ ...ROW, fontSize: 12 }}>
        <span style={{ flex: 1, color: "#777", fontSize: 11 }}>None defined — captions use the default style.</span>
        <button
          style={BTN}
          title="Give this composition a caption style of its own (starts from the default)"
          onClick={() => commit({})}
        >
          Define style
        </button>
      </div>
    );
  }

  return (
    <div style={{ fontSize: 12 }}>
      {/* ── Presets ── */}
      <div style={ROW}>
        <select
          style={{ ...INPUT, flex: 1, minWidth: 0 }}
          value={presetName ?? ""}
          title={
            state === "modified"
              ? "This composition's style differs from the saved preset"
              : state === "missing"
                ? "This preset is not saved in this editor"
                : "Caption style preset"
          }
          onChange={(e) => {
            const name = e.target.value;
            if (name === "") commit(style, undefined);
            else if (name in presets) commit(presets[name], name);
          }}
        >
          <option value="">(no preset)</option>
          {presetName != null && !(presetName in presets) && (
            <option value={presetName}>{presetName} * (not saved here)</option>
          )}
          {Object.keys(presets)
            .sort()
            .map((name) => (
              <option key={name} value={name}>
                {name}
                {name === presetName && state === "modified" ? " *" : ""}
              </option>
            ))}
        </select>
        <button
          style={presetName != null && state !== "clean" ? BTN : BTN_OFF}
          disabled={presetName == null || state === "clean"}
          title={presetName != null ? `Save this style to the preset "${presetName}"` : "Pick or create a preset first"}
          onClick={() => presetName != null && savePreset(presetName)}
        >
          Save
        </button>
        <button style={BTN} title="Save this style as a new preset" onClick={() => setNaming(presetName ?? "")}>
          Save as
        </button>
        <button
          style={presetName != null && presetName in presets ? BTN : BTN_OFF}
          disabled={presetName == null || !(presetName in presets)}
          title={presetName != null ? `Delete the preset "${presetName}" from this editor` : "No preset selected"}
          onClick={() => {
            if (presetName == null || !(presetName in presets)) return;
            const ok = window.confirm(
              `Delete the caption style preset "${presetName}"?\n\nThis composition keeps its current style. The preset can't be recovered.`,
            );
            if (!ok) return;
            const { [presetName]: _gone, ...rest } = presets;
            storage.set(PRESETS_KEY, rest);
            // The name no longer points at anything — forget it here.
            commit(style, undefined);
          }}
        >
          Delete
        </button>
      </div>
      {naming != null && (
        <form
          style={ROW}
          onSubmit={(e) => {
            e.preventDefault();
            const name = naming.trim();
            if (name === "") return;
            savePreset(name);
            setNaming(null);
          }}
        >
          <input
            autoFocus
            style={{ ...INPUT, flex: 1, minWidth: 0 }}
            placeholder="Preset name"
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setNaming(null)}
          />
          <button type="submit" style={naming.trim() === "" ? BTN_OFF : BTN} disabled={naming.trim() === ""}>
            {naming.trim() in presets ? "Overwrite" : "Create"}
          </button>
          <button type="button" style={BTN} onClick={() => setNaming(null)}>
            Cancel
          </button>
        </form>
      )}

      {/* ── The look ── */}
      <StyleFields value={style} inherited={DEFAULT_CAPTION_STYLE} onChange={setKey} />
      <Field label="Max chars" title="A caption longer than this is split at word boundaries. Empty = never split.">
        <Commit
          value={style.maxChars != null ? String(style.maxChars) : ""}
          placeholder="no limit"
          onCommit={(text) => {
            if (text === "") return setKey("maxChars", undefined);
            const n = Number(text);
            if (Number.isInteger(n) && n > 0) setKey("maxChars", n);
          }}
        />
      </Field>

      {/* ── Speakers ── */}
      <div style={SUBHEAD}>Speakers</div>
      {Object.keys(speakers).length === 0 && (
        <div style={{ color: "#777", fontSize: 11, marginBottom: 4 }}>
          Overrides for captions whose <code>speaker</code> matches a name.
        </div>
      )}
      {Object.entries(speakers).map(([name, override]) => (
        <details key={name} style={{ marginBottom: 4 }}>
          <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              <span style={{ ...SWATCH, background: override.color ?? style.color ?? DEFAULT_CAPTION_STYLE.color }} />{" "}
              {name}
              <span style={{ color: "#777" }}>
                {" "}
                · {Object.keys(override).length} override{Object.keys(override).length === 1 ? "" : "s"}
              </span>
            </span>
            <button
              style={{ ...BTN, padding: "0 6px" }}
              title={`Remove the overrides for "${name}"`}
              onClick={(e) => {
                e.preventDefault();
                setSpeaker(name, null);
              }}
            >
              ×
            </button>
          </summary>
          <div style={{ paddingLeft: 10, borderLeft: "1px solid #333", marginTop: 4 }}>
            <StyleFields
              value={override}
              inherited={{ ...DEFAULT_CAPTION_STYLE, ...style }}
              onChange={(key, value) => {
                const next = { ...override, [key]: value } as Record<string, unknown>;
                if (value === undefined) delete next[key];
                setSpeaker(name, next as CaptionStyle);
              }}
            />
          </div>
        </details>
      ))}
      <form
        style={ROW}
        onSubmit={(e) => {
          e.preventDefault();
          const name = newSpeaker.trim();
          if (name === "" || name in speakers) return;
          setSpeaker(name, {});
          setNewSpeaker("");
        }}
      >
        <input
          style={{ ...INPUT, flex: 1, minWidth: 0 }}
          placeholder="Speaker name"
          value={newSpeaker}
          onChange={(e) => setNewSpeaker(e.target.value)}
        />
        <button
          type="submit"
          style={newSpeaker.trim() === "" || newSpeaker.trim() in speakers ? BTN_OFF : BTN}
          disabled={newSpeaker.trim() === "" || newSpeaker.trim() in speakers}
        >
          Add speaker
        </button>
      </form>
      <div style={{ ...ROW, justifyContent: "flex-end", marginTop: 8 }}>
        <button
          style={BTN}
          title="Remove this composition's caption style (and its preset name): back to none defined"
          onClick={() => update((n) => withStyle(n, undefined, undefined))}
        >
          Remove style
        </button>
      </div>
    </div>
  );
}

/** One row per style key. An empty control = the key is not set, and shows
 *  what it inherits as its placeholder. */
function StyleFields({
  value,
  inherited,
  onChange,
}: {
  value: CaptionStyle;
  inherited: CaptionStyle;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <>
      {FIELDS.map(({ key, label, kind }) => {
        const current = value[key];
        const fallback = inherited[key];
        if (Array.isArray(kind)) {
          return (
            <Field key={key} label={label}>
              <select
                style={{ ...INPUT, flex: 1, minWidth: 0, color: current == null ? "#777" : "#ddd" }}
                value={current == null ? "" : String(current)}
                onChange={(e) => onChange(key, e.target.value === "" ? undefined : e.target.value)}
              >
                <option value="">{fallback != null ? `(${String(fallback)})` : "(default)"}</option>
                {(kind as readonly string[]).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
          );
        }
        const shown = kind === "box" ? formatBox(current) : current == null ? "" : String(current);
        const placeholder = kind === "box" ? formatBox(fallback) : fallback == null ? "" : String(fallback);
        return (
          <Field key={key} label={label}>
            {kind === "color" && (
              <span style={{ ...SWATCH, background: String(current ?? fallback ?? "transparent") }} />
            )}
            <Commit
              value={shown}
              placeholder={placeholder}
              onCommit={(text) => {
                if (text === "") return onChange(key, undefined);
                if (kind === "number") {
                  const n = Number(text);
                  if (Number.isFinite(n)) onChange(key, n);
                } else if (kind === "box") {
                  const box = parseBox(text);
                  if (box !== null) onChange(key, box);
                } else {
                  onChange(key, text);
                }
              }}
            />
          </Field>
        );
      })}
    </>
  );
}

function Field({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <label style={ROW} title={title}>
      <span style={{ width: 84, flexShrink: 0, color: "#aaa" }}>{label}</span>
      {children}
    </label>
  );
}

/** A text box that commits on blur / Enter and reverts on Escape. An entry
 *  the caller doesn't accept simply snaps back to the authored value. */
function Commit({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const text = draft.trim();
    if (text !== value) onCommit(text);
    setDraft(value);
  };
  return (
    <input
      style={{ ...INPUT, flex: 1, minWidth: 0 }}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}

const ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 };
const INPUT: React.CSSProperties = {
  background: "#111",
  color: "#ddd",
  border: "1px solid #333",
  borderRadius: 3,
  padding: "3px 6px",
  fontSize: 12,
  fontFamily: "inherit",
};
const BTN: React.CSSProperties = {
  background: "#2a2a2a",
  color: "#ddd",
  border: "1px solid #444",
  borderRadius: 3,
  padding: "3px 8px",
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
const BTN_OFF: React.CSSProperties = { ...BTN, opacity: 0.35, cursor: "default" };
const SUBHEAD: React.CSSProperties = { color: "#999", fontSize: 11, fontWeight: 600, margin: "8px 0 4px" };
const SWATCH: React.CSSProperties = {
  display: "inline-block",
  width: 14,
  height: 14,
  flexShrink: 0,
  borderRadius: 3,
  border: "1px solid #555",
  verticalAlign: "middle",
};
