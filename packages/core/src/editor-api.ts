// The editor side of the extension contract — TYPES ONLY.
//
// An extension's `./editor` entry exports an `EditorExtension`: what it adds
// to the editing application, as opposed to the document format and
// rendering (`SeamExtension`). The editor passes each command a context
// built from its own state; an extension never imports the editor.
//
// These live in core so an extension package depends on nothing but
// `@seam/core`. They grow only when an extension needs more — see
// docs/extensions.md.

import type { Child, SeamFile } from "./types.js";
import type { ResolvedChild } from "./resolved-types.js";
import type { Seam } from "./seam.js";

/** One transcribed phrase, as the transcription service returns it: times
 *  are seconds relative to the audio that was sent. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: Array<{ start: number; end: number; text: string }>;
}

/** What transcribing one node produced. */
export interface Transcript {
  /** Path key of the transcribed node. */
  key: string;
  /** Add to a segment time to get the node's own source time (a clip's
   *  media time, a composition's inner-timeline time). */
  anchorBase: number;
  /** Source seconds per output second of the node. */
  rate: number;
  segments: TranscriptSegment[];
}

/** Document edits an extension command can perform. Every function is pure:
 *  it takes a document and returns the next one. Nodes are addressed by path
 *  key (`"children.3.children.1"`; `""` = the root). */
export interface EditorTools {
  /** Replace the node at `key` with `update`'s result. */
  updateNode(doc: SeamFile, key: string, update: (node: Child) => Child): SeamFile;
  /** Append `nodes` to the `children` of the composition at `containerKey`.
   *  Give each a `start` so it heads its own run and disturbs nothing. */
  appendChildren(doc: SeamFile, containerKey: string, nodes: Child[]): SeamFile;
  /** Path key of the container holding the node at `key`. */
  parentKey(key: string): string;
  /** Remove the nodes at `keys` (run-aware: a removed run head hands its
   *  placement to its successor; nodes anchored to a removed id go too). */
  removeNodes(doc: SeamFile, keys: readonly string[]): SeamFile;
  /** Where each child of the composition at `containerKey` plays, in that
   *  composition's own inner time — 1:1 with its authored `children`
   *  (un-windowed, nothing cropped). Null when it doesn't resolve. */
  childSpans(doc: SeamFile, containerKey: string): ReadonlyArray<{ start: number; end: number }> | null;
  /** An id that collides with nothing in the document. */
  freshId(doc: SeamFile, base: string): string;
  /** Keep only `ranges` (composition inner time) of the composition at `key`,
   *  in place: split + delete at scale. Anchors to kept moments follow their
   *  piece; nodes anchored to cut-out moments are removed. */
  keepRanges(
    doc: SeamFile,
    key: string,
    ranges: ReadonlyArray<{ start: number; end: number }>,
  ): { ok: true; doc: SeamFile; pieces: string[] } | { ok: false; error: string };
}

/** What the editor lends an extension. */
export interface EditorServices {
  /** Transcribe the selected root-level clip / audio / composition nodes
   *  through the editor's generator-server (or Seam Cloud) connection. The
   *  editor shows its own progress and errors; the document is not touched —
   *  the caller decides what the transcripts become. */
  transcribe(): Promise<Transcript[]>;
}

/** The editor's state at the moment a command runs. */
export interface EditorCommandContext {
  readonly seam: Seam;
  readonly document: SeamFile;
  /** Path keys of the selected nodes, primary first. */
  readonly selection: readonly string[];
  /** The authored node at `key`, or null. */
  node(key: string): Child | null;
  /** The node at `key` resolved on its own (bins inflated, scripts off, its
   *  own window applied), or null when it can't be. */
  resolve(key: string): ResolvedChild | null;
  /** Commit `next` as one undo step, optionally changing the selection. */
  edit(next: SeamFile, opts?: { select?: string[] }): void;
  /** Show messages to the user (errors, "nothing to do"). */
  notify(messages: string[]): void;
  readonly tools: EditorTools;
  readonly services: EditorServices;
}

/** A toolbar action. */
export interface EditorCommand {
  /** Unique across the editor's extensions. */
  readonly id: string;
  /** Short text shown on the button. */
  readonly label: string;
  /** Tooltip. */
  readonly title: string;
  /** Greyed out when false. Called on every render — keep it cheap. */
  enabled?(ctx: EditorCommandContext): boolean;
  run(ctx: EditorCommandContext): void | Promise<void>;
}

/** The preview player, as a view sees it. All times are GLOBAL output
 *  seconds of the document being shown (the view's preview, when it set
 *  one). */
export interface EditorPlayer {
  /** Where the playhead is now. Read on demand — a view is not re-rendered
   *  per tick. */
  time(): number;
  seek(time: number): void;
  /** Where the node at `key` plays in the document being shown, or null
   *  (not on the timeline, bin-rooted, unresolvable). */
  spanOf(key: string): { start: number; end: number } | null;
}

/** What the editor hands a view component. */
export interface EditorViewProps {
  /** The editor's state right now — the same context commands get. Its
   *  `document` is always the REAL document, never the view's preview. */
  readonly context: EditorCommandContext;
  /** Path key of the node the view was opened on (the primary selection at
   *  that moment). */
  readonly target: string;
  /** Show `doc` in the player and on the timeline instead of the real
   *  document, without touching history — a live preview of what the view
   *  is about to do. `null` goes back to the real one. The timeline is
   *  read-only while a view is open either way. */
  preview(doc: SeamFile | null): void;
  /** Leave the view (drops any preview). Commit with `context.edit` first. */
  close(): void;
  readonly player: EditorPlayer;
}

/**
 * A mode of the editor an extension owns: while open, its component takes
 * the editor's left pane, and the player + timeline show the real document
 * (or the view's `preview`) read-only. The editor closes it when the
 * document changes underneath (undo, or the view's own `context.edit`).
 */
export interface EditorView {
  /** Unique across the editor's extensions. */
  readonly id: string;
  /** Short text shown on the toolbar button that opens it. */
  readonly label: string;
  /** Tooltip. */
  readonly title: string;
  /** Whether it can open on the current selection. Called on every render. */
  enabled?(ctx: EditorCommandContext): boolean;
  /** A React function component taking `EditorViewProps`. Typed without
   *  React so core stays free of it: any `(props) => JSX.Element` fits. The
   *  extension's `./editor` entry is the one place it may depend on React
   *  (a peer dependency — the editor supplies the instance). */
  readonly component: (props: EditorViewProps) => unknown;
}

/** A small persistent store the editor lends an extension, kept with the
 *  editor's own settings (so: per installation, not in the document). Scoped
 *  to the extension — keys never collide across extensions. Values must be
 *  JSON. */
export interface EditorStorage {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** What the editor hands a property editor component. */
export interface EditorPropertyProps {
  readonly seam: Seam;
  /** The nodes being edited (the root document when nothing is selected).
   *  Every one carries the editor's `field`. */
  readonly nodes: readonly Child[];
  /** Apply `change` to each of those nodes as ONE undo step (validated; an
   *  invalid result is refused and shown as the panel's error). With
   *  `coalesce` it replaces the current history entry instead — the later
   *  ticks of a drag. */
  update(change: (node: Child) => Child, opts?: { coalesce?: boolean }): void;
  /** The extension's persistent store. The component re-renders when it
   *  changes. */
  readonly storage: EditorStorage;
}

/**
 * A section of the Properties panel an extension owns — the UI for a
 * structured (`custom`) field, which gets no generated row. Shown, under
 * `label`, whenever every selected node carries `field`.
 */
export interface EditorPropertyEditor {
  /** Key of the field it edits (a contributed field or a node type's own). */
  readonly field: string;
  /** Section heading. */
  readonly label: string;
  /** A React function component taking `EditorPropertyProps` (typed without
   *  React, like a view's). */
  readonly component: (props: EditorPropertyProps) => unknown;
}

/** What an extension adds to the editor. */
export interface EditorExtension {
  /** The extension's name (matches its `SeamExtension.name`). */
  readonly name: string;
  readonly commands?: readonly EditorCommand[];
  readonly views?: readonly EditorView[];
  readonly properties?: readonly EditorPropertyEditor[];
}
