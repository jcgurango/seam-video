// Captions — a Seam extension.
//
// A caption is WHAT WAS SAID AND WHEN. It is not text: how it looks is
// decided globally, at a surface, not on the node. (Text is a designed
// element; the two share layout code, not a primitive.)
//
//   caption   a phrase. Its `children` are `word`s in a run, so retiming a
//             word is ordinary timeline editing; its length is theirs unless
//             `duration` is authored. Without words it carries `text`.
//   word      one word: `text` + `duration` (+ `offset` = the pause before it).
//
// One node type serves as the transcript of footage and as the on-screen
// caption alike. Neither has any visual presence where it sits. Captions
// BUBBLE, the way audio does: they are collected up the tree — time mapped
// through every composition window — to the nearest composition whose
// `captions` field says to stop:
//
//   captions: "pass"   (default) continue upward
//             "off"    stop here; draw nothing
//             "show"   stop here and draw them with this composition's
//                      `captionStyle`
//
// The root composition behaves as "show" unless it says otherwise.
//
// Stage A (this file): the node types, the routing field and the style
// validate and resolve. Collecting, deriving display phrases and rendering
// come next — see docs/extensions.md.
//
// The extension imports only the public extension API (`@seam/core`).

import type {
  Child,
  FieldSpec,
  NodeTypeDef,
  NonVisualExtensionNodeBase,
  ResolvedChild,
  ResolvedExtensionNode,
  SeamExtension,
} from "@seam/core";

// ── Types ───────────────────────────────────────────────────────────

/** How captions look. Every key optional; plain values (not animatable).
 *  Mirrors the `text` node's style and layout fields. */
export interface CaptionStyle {
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: "none" | "underline" | "overline" | "line-through";
  /** Vertical glyph stretch, e.g. `"120%"`. */
  letterHeight?: string;
  backgroundColor?: string;
  backgroundPadding?: number | [number, number] | [number, number, number, number];
  strokeColor?: string;
  strokeWidth?: number;
  lineHeight?: number;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "center" | "bottom";
  /** Inset of the caption's layout box inside the surface. */
  padding?: number | [number, number] | [number, number, number, number];
}

/** The style a surface holds: the default look, the rule that derives
 *  display phrases, and per-speaker overrides. */
export interface CaptionSurfaceStyle extends CaptionStyle {
  /** A caption longer than this many characters is split at word
   *  boundaries. Unset = never split. */
  maxChars?: number;
  /** Overrides by a caption's `speaker`. */
  speakers?: Record<string, CaptionStyle>;
}

/** Where captions bubbling up through a composition go. */
export type CaptionRouting = "pass" | "off" | "show";

/** One word of a caption. `offset` is the pause before it. */
export interface WordNode extends NonVisualExtensionNodeBase<"word"> {
  text: string;
  duration: number;
}

/** A phrase: what was said and when. */
export interface CaptionNode extends NonVisualExtensionNodeBase<"caption"> {
  /** The phrase, when it has no `word` children (with words, they are the text). */
  text?: string;
  /** Who is speaking — picks `captionStyle.speakers[speaker]` at the surface. */
  speaker?: string;
  /** A small per-caption exception to the surface's style. */
  style?: CaptionStyle;
  children?: Child[];
}

export interface ResolvedWord extends ResolvedExtensionNode<"word"> {
  text: string;
}

export interface ResolvedCaption extends ResolvedExtensionNode<"caption"> {
  text?: string;
  speaker?: string;
  style?: CaptionStyle;
  children: ResolvedChild[];
}

declare module "@seam/core" {
  interface ExtensionNodeTypes {
    caption: CaptionNode;
    word: WordNode;
  }
  interface ResolvedExtensionNodeTypes {
    caption: ResolvedCaption;
    word: ResolvedWord;
  }
  interface CompositionExtensionFields {
    /** Where captions bubbling up through this composition go. Default
     *  `"pass"`; the root behaves as `"show"`. */
    captions?: CaptionRouting;
    /** How captions shown at this composition look. */
    captionStyle?: CaptionSurfaceStyle;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** A caption's phrase: its words joined, else its own `text`. Works on an
 *  authored or a resolved caption. */
export function captionText(caption: {
  text?: string;
  children?: readonly { type: string }[];
}): string {
  const words = (caption.children ?? []).filter((c) => c.type === "word") as unknown as {
    text: string;
  }[];
  if (words.length > 0) return words.map((w) => w.text).join(" ");
  return caption.text ?? "";
}

// ── The definition ──────────────────────────────────────────────────

const GROUP = "Captions";

/** The style keys shared by a surface and a per-caption override, as a
 *  schema shape built with core's Zod. */
function styleShape(z: Parameters<Extract<FieldSpec, { type: "custom" }>["schema"]>[0]) {
  const padding = z.union([
    z.number().nonnegative(),
    z.tuple([z.number().nonnegative(), z.number().nonnegative()]),
    z.tuple([
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
    ]),
  ]);
  return {
    fontFamily: z.string().min(1).optional(),
    fontSize: z.number().positive().optional(),
    color: z.string().optional(),
    fontWeight: z.string().optional(),
    fontStyle: z.string().optional(),
    textDecoration: z.enum(["none", "underline", "overline", "line-through"]).optional(),
    letterHeight: z
      .string()
      .regex(/^-?\d+(?:\.\d+)?%$/, "Must be a percentage string (e.g. '120%')")
      .optional(),
    backgroundColor: z.string().optional(),
    backgroundPadding: padding.optional(),
    strokeColor: z.string().optional(),
    strokeWidth: z.number().nonnegative().optional(),
    lineHeight: z.number().nonnegative().optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    verticalAlign: z.enum(["top", "center", "bottom"]).optional(),
    padding: padding.optional(),
  };
}

/** `word`: one word of a caption. */
export const wordNode: NodeTypeDef = {
  type: "word",
  visual: false,
  fields: [{ key: "text", type: "string", required: true, label: "Word", group: GROUP }],
  editor: { color: "#8a6a2a", border: "#c49a3a" },
};

/** `caption`: a phrase whose children are its words. */
export const captionNode: NodeTypeDef = {
  type: "caption",
  visual: false,
  children: ["word"],
  span: "children",
  fields: [
    {
      key: "text", type: "string", label: "Text", group: GROUP,
      hint: "The phrase, when the caption has no word children.",
    },
    {
      key: "speaker", type: "string", label: "Speaker", group: GROUP,
      hint: "Picks the surface's per-speaker style.",
    },
    {
      // A small per-caption exception to the surface's style. Structured →
      // JSON panel.
      key: "style", type: "custom",
      schema: (z) => z.object(styleShape(z)).strict(),
    },
  ],
  editor: { color: "#7a5a3a", border: "#a47a52" },
};

const compositionFields: FieldSpec[] = [
  {
    key: "captions", nodes: "composition", type: "enum",
    options: ["pass", "off", "show"], default: "pass",
    label: "Captions", group: GROUP,
    hint: "Captions inside this composition: pass = continue upward (the root shows them); off = stop here, draw nothing; show = draw them here with this composition's caption style.",
  },
  {
    // The look of captions shown at this composition. Structured → JSON panel.
    key: "captionStyle", nodes: "composition", type: "custom",
    schema: (z) =>
      z.object({
        ...styleShape(z),
        maxChars: z.number().int().positive().optional(),
        speakers: z.record(z.string().min(1), z.object(styleShape(z)).strict()).optional(),
      }).strict(),
  },
];

/** The Captions extension. */
export const captions: SeamExtension = {
  name: "captions",
  fields: compositionFields,
  // `word` first: `caption` names it as its only child type.
  nodes: [wordNode, captionNode],
};

export default captions;
