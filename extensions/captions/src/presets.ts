// Caption style presets — the pure half. A preset is a whole surface style
// (look, phrase rule, speaker overrides) under a name. Presets belong to the
// editor installation (its `EditorStorage`), not to a document: a composition
// only remembers WHICH preset it was styled from, as `metadata.captionPreset`,
// so the editor can say whether the two have drifted apart.

import type { CaptionSurfaceStyle } from "./index.js";

/** Storage key of the preset table (`{ [name]: CaptionSurfaceStyle }`). */
export const PRESETS_KEY = "presets";
/** Metadata key naming the preset a composition's style came from. */
export const PRESET_METADATA_KEY = "captionPreset";

export type PresetTable = Record<string, CaptionSurfaceStyle>;

/** Whatever storage holds, as a preset table (anything else → empty). */
export function readPresets(stored: unknown): PresetTable {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const out: PresetTable = {};
  for (const [name, style] of Object.entries(stored)) {
    if (style && typeof style === "object" && !Array.isArray(style)) out[name] = style as CaptionSurfaceStyle;
  }
  return out;
}

/** A style with nothing left to say dropped: `undefined` values, speakers
 *  with no overrides, an empty `speakers`. */
export function tidyStyle(style: CaptionSurfaceStyle): CaptionSurfaceStyle {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined) continue;
    if (key === "speakers") {
      const speakers: Record<string, unknown> = {};
      for (const [name, override] of Object.entries(value as object)) {
        const kept = Object.fromEntries(Object.entries(override as object).filter(([, v]) => v !== undefined));
        speakers[name] = kept;
      }
      if (Object.keys(speakers).length > 0) out.speakers = speakers;
      continue;
    }
    out[key] = value;
  }
  return out as CaptionSurfaceStyle;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Whether two styles say the same thing (key order and `undefined`s aside). */
export function sameStyle(a: CaptionSurfaceStyle | undefined, b: CaptionSurfaceStyle | undefined): boolean {
  return JSON.stringify(canonical(tidyStyle(a ?? {}))) === JSON.stringify(canonical(tidyStyle(b ?? {})));
}

/** How a composition's style stands against the preset it names. */
export function presetState(
  presets: PresetTable,
  name: string | undefined,
  style: CaptionSurfaceStyle | undefined,
): "none" | "clean" | "modified" | "missing" {
  if (name == null) return "none";
  if (!(name in presets)) return "missing";
  return sameStyle(presets[name], style) ? "clean" : "modified";
}

type Styled = { captionStyle?: CaptionSurfaceStyle; metadata?: Record<string, unknown> };

/** `node` with its caption style and remembered preset name set. An
 *  `undefined` style removes `captionStyle` (the composition defines none);
 *  an EMPTY one stays — "defined, nothing overridden yet". An `undefined`
 *  name removes the key; an emptied `metadata` goes too. */
export function withStyle<T extends object>(
  node: T,
  style: CaptionSurfaceStyle | undefined,
  preset: string | undefined,
): T {
  const { captionStyle: _style, metadata, ...rest } = node as T & Styled;
  const { [PRESET_METADATA_KEY]: _name, ...otherMeta } = metadata ?? {};
  const nextMeta = preset != null ? { ...otherMeta, [PRESET_METADATA_KEY]: preset } : otherMeta;
  return {
    ...rest,
    ...(style !== undefined ? { captionStyle: tidyStyle(style) } : {}),
    ...(Object.keys(nextMeta).length > 0 ? { metadata: nextMeta } : {}),
  } as T;
}

/** The preset a node says its style came from. */
export function presetNameOf(node: object): string | undefined {
  const name = (node as Styled).metadata?.[PRESET_METADATA_KEY];
  return typeof name === "string" ? name : undefined;
}

/** Text ⇄ a box shorthand (`padding`): `"200"`, `"610, 100"`, or four values. */
export function parseBox(text: string): number | [number, number] | [number, number, number, number] | undefined | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (nums.length === 1) return nums[0];
  if (nums.length === 2) return [nums[0], nums[1]];
  if (nums.length === 4) return [nums[0], nums[1], nums[2], nums[3]];
  return null;
}

export function formatBox(value: unknown): string {
  if (value == null) return "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}
