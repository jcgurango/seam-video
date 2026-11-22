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

/** What an extension adds to the editor. */
export interface EditorExtension {
  /** The extension's name (matches its `SeamExtension.name`). */
  readonly name: string;
  readonly commands?: readonly EditorCommand[];
}
