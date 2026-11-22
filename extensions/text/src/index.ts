// Text — a Seam extension.
//
// A `text` node is a DESIGNED piece of text: laid out on its own inner
// canvas (`contentWidth` / `contentHeight`, like a composition's) and placed
// by the ordinary spatial model. `text` is a plain string or an array of
// strings and styled runs for inline formatting; most style fields can be
// keyframed.
//
// This entry is PURE: the node type's definition, its types (merged into
// core's unions below) and the helpers other code needs to read a text node.
// Hosts that draw import `@seam/extension-text/render` — the same extension
// with its rasterizer attached, plus the layout engine itself
// (`layoutText` / `drawTextLayout`), which Captions reuses for its phrases.
//
// The extension imports only the public extension API (`@seam/core`).

import type {
  ExtensionNodeBase,
  FieldSpec,
  Keyframed,
  NodeTypeDef,
  ResolvedExtensionNode,
  SeamExtension,
  TextPadding,
} from "@seam/core";

// ── Types ───────────────────────────────────────────────────────────

/** Style fields available on the `text` node and on each inline run. */
export interface TextStyleFields {
  fontFamily?: string;
  fontSize?: Keyframed<number>;
  /** Any CSS colour; defaults to black. */
  color?: Keyframed<string>;
  /** Any CSS `font-weight` (e.g. "bold", "700"). */
  fontWeight?: string;
  /** CSS `font-style` ("italic" / "oblique" / "normal"). */
  fontStyle?: string;
  /** A single text-decoration line, drawn manually (canvas has none). */
  textDecoration?: "none" | "underline" | "overline" | "line-through";
  /** Vertical glyph stretch as a percentage string ("100%" = natural
   *  height), about the baseline; horizontal advance is unchanged. */
  letterHeight?: string;
  /** Drawn as a rect behind the run, per line on wrap. */
  backgroundColor?: Keyframed<string>;
  backgroundPadding?: Keyframed<TextPadding>;
  strokeColor?: Keyframed<string>;
  /** Stroke width in px, centred on the glyph edge (the visible outline is
   *  roughly half of it). */
  strokeWidth?: Keyframed<number>;
}

/** A styled run inside a `text` node's `text` array. */
export interface TextRun extends TextStyleFields {
  text: string;
}

/** Layout fields that live on the node only (not on runs). */
export interface TextLayoutFields {
  /** Line height in px; defaults to 1.2 × `fontSize`. */
  lineHeight?: Keyframed<number>;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "center" | "bottom";
  /** Inset of the layout box inside the inner canvas. */
  padding?: TextPadding;
  /**
   * `false` = a single line of text (old Flash's, or SVG's): lines break
   * only where you put a `\n`, and the node's inner canvas is no longer
   * `contentWidth` / `contentHeight` but the MEASURED size of the text plus
   * `padding`. From there it is an inner canvas like any other: `objectFit`
   * fits it into the parent, `size` / `origin` / `translation` place it.
   * Backgrounds and strokes hang past the glyphs — `padding` makes the room.
   * Default `true`: the text wraps inside its inner canvas.
   */
  wrap?: boolean;
}

/** A text node as authored. */
export interface TextNode extends ExtensionNodeBase<"text">, TextStyleFields, TextLayoutFields {
  text: string | (string | TextRun)[];
}

/** A text node after layout resolution: its own fields ride verbatim. */
export interface ResolvedText extends ResolvedExtensionNode<"text">, TextStyleFields, TextLayoutFields {
  text: string | (string | TextRun)[];
}

declare module "@seam/core" {
  interface ExtensionNodeTypes {
    text: TextNode;
  }
  interface ResolvedExtensionNodeTypes {
    text: ResolvedText;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** `text` as a uniform list of runs. */
export function normalizeTextRuns(text: string | readonly (string | TextRun)[]): TextRun[] {
  if (typeof text === "string") return [{ text }];
  return text.map((item) => (typeof item === "string" ? { text: item } : item));
}

/** The node's characters, runs joined — for labels and search. */
export function plainText(text: string | readonly (string | TextRun)[] | undefined): string {
  if (text == null) return "";
  return normalizeTextRuns(text)
    .map((r) => r.text)
    .join("");
}

// ── Definition ──────────────────────────────────────────────────────

const GROUP = "Text";

/** Run-level style, as a Zod shape (also the node's own style fields that
 *  have no plain field kind). */
const paddingSchema = (z: Parameters<Extract<FieldSpec, { type: "custom" }>["schema"]>[0]) =>
  z.union([
    z.number().nonnegative(),
    z.tuple([z.number().nonnegative(), z.number().nonnegative()]),
    z.tuple([
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
    ]),
  ]);

/** `"120%"`. */
const PERCENT = "^\\d+(\\.\\d+)?%$";

const fields: FieldSpec[] = [
  {
    // A string, or strings and styled runs. Edited through the extension's
    // own Properties section.
    key: "text", type: "custom", required: true,
    schema: (z, h) => {
      const run = z
        .object({
          text: z.string(),
          fontFamily: z.string().min(1).optional(),
          fontSize: h.keyframed(z.number().positive()).optional(),
          color: h.keyframed(z.string()).optional(),
          fontWeight: z.string().optional(),
          fontStyle: z.string().optional(),
          textDecoration: z.enum(["none", "underline", "overline", "line-through"]).optional(),
          letterHeight: z.string().regex(new RegExp(PERCENT)).optional(),
          backgroundColor: h.keyframed(z.string()).optional(),
          backgroundPadding: h.keyframed(paddingSchema(z)).optional(),
          strokeColor: h.keyframed(z.string()).optional(),
          strokeWidth: h.keyframed(z.number().nonnegative()).optional(),
        })
        .strict();
      return z.union([z.string(), z.array(z.union([z.string(), run]))]);
    },
  },
  { key: "fontFamily", type: "string", default: "Liberation Sans", label: "Font", group: GROUP },
  {
    key: "fontSize", type: "number", min: 0, exclusiveMin: true, default: 16, unit: "px",
    animatable: true, label: "Font size", group: GROUP,
  },
  { key: "color", type: "color", default: "black", animatable: true, label: "Color", group: GROUP },
  { key: "fontWeight", type: "string", default: "normal", label: "Weight", group: GROUP },
  {
    key: "fontStyle", type: "string", default: "normal", label: "Style", group: GROUP,
    hint: "CSS font-style: normal, italic or oblique.",
  },
  {
    key: "textDecoration", type: "enum", options: ["none", "underline", "overline", "line-through"],
    default: "none", label: "Decoration", group: GROUP,
  },
  {
    key: "letterHeight", type: "string", pattern: PERCENT, default: "100%", label: "Letter height", group: GROUP,
    hint: "Vertical glyph stretch about the baseline.",
  },
  {
    key: "lineHeight", type: "number", min: 0, unit: "px", animatable: true,
    label: "Line height", group: GROUP, hint: "Defaults to 1.2 × the font size.",
  },
  { key: "textAlign", type: "enum", options: ["left", "center", "right"], default: "center", label: "Align", group: GROUP },
  {
    key: "verticalAlign", type: "enum", options: ["top", "center", "bottom"], default: "top",
    label: "Vertical align", group: GROUP,
  },
  {
    key: "wrap", type: "boolean", default: true, label: "Wrap", group: GROUP,
    hint: "Off: lines break only at your own line breaks, and the node is as big as its text (plus padding) instead of its content width / height.",
  },
  // number | [v, h] | [t, r, b, l] — edited in the extension's Properties section.
  { key: "padding", type: "custom", schema: (z) => paddingSchema(z) },
  { key: "backgroundColor", type: "color", animatable: true, label: "Background", group: GROUP },
  { key: "backgroundPadding", type: "custom", schema: (z, h) => h.keyframed(paddingSchema(z)) },
  { key: "strokeColor", type: "color", default: "black", animatable: true, label: "Stroke", group: GROUP },
  {
    key: "strokeWidth", type: "number", min: 0, default: 0, unit: "px", animatable: true,
    label: "Stroke width", group: GROUP,
  },
];

/** `text`: a designed piece of text on its own inner canvas. */
export const textNode: NodeTypeDef = {
  type: "text",
  fields,
  draws: true,
  // Text that does not wrap is as big as what it says: its rasterizer
  // measures the inner canvas each frame.
  measured: (node) => node.wrap === false,
  validate: (node) =>
    node.wrap === false && (node.contentWidth != null || node.contentHeight != null)
      ? "A text node with 'wrap: false' is sized by its text: remove 'contentWidth' / 'contentHeight'"
      : undefined,
  editor: {
    color: "#a04060",
    border: "#c45582",
    // A one-line preview of the text.
    blockLabel: (node) => {
      const flat = plainText(node.text as TextNode["text"] | undefined).replace(/\s+/g, " ").trim();
      return flat === "" ? undefined : flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
    },
    // The "Text" tile in the editor's New panel.
    palette: { label: "Text", glyph: "T", create: () => ({ type: "text", duration: 1, text: "Sample Text" }) },
  },
};

/** The Text extension, pure (validate / resolve). Hosts that render register
 *  `text` from `@seam/extension-text/render`. */
export const text: SeamExtension = {
  name: "text",
  nodes: [textNode],
};

export default text;
