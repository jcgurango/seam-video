// Drive the "transcribe selected clips/audio" job:
//
//   1. Pick targets from the current selection, or default to all clip/audio
//      children of the current view (no attachments).
//   2. For each target, extract its [in, out] audio range as WAV (via
//      audioExtract) and POST it to the generator server's /transcribe.
//   3. After each response, append a `data` attachment to the doc anchored
//      to the source clip's source-time `in`/`out`. The clip is given an
//      `id` if it doesn't already have one so the anchor can resolve.
//
// One pre-snapshot via `history.pushPast` makes the whole batch a single
// undo step; intermediate updates use `history.replace` so the user sees
// progress without polluting the undo stack.

import { useCallback, useRef, useState } from "react";
import type {
  Audio,
  Child,
  Clip,
  SeamFile,
  TimeAnchor,
} from "@seam/core";
import type { History } from "./useHistory.js";
import type { Platform } from "./platform/index.js";
import type { View } from "./views.js";
import { extractAudioWav } from "./audioExtract.js";

export interface TranscribeProgress {
  total: number;
  /** Index of the item currently being processed (0-based). */
  current: number;
  /** Phase within the current item — "extract" → "upload" → next. */
  phase: "extract" | "upload";
  label: string;
}

export interface UseTranscribeOptions {
  serverUrl: string;
  platform: Platform;
  basePath: string;
  history: History<SeamFile>;
}

export interface UseTranscribe {
  progress: TranscribeProgress | null;
  errors: string[];
  run: (
    document: SeamFile,
    view: View,
    selectedIndices: number[]
  ) => Promise<void>;
  cancel: () => void;
}

interface Target {
  /** Index into `targetCompositionDoc.children` of the clip/audio node. */
  index: number;
  child: Clip | Audio;
}

/**
 * Where the new data attachments are written. For root view this is the
 * document itself; for a composition view it's `doc.children[rootIndex]`.
 * Clip view isn't supported — the CC button is disabled there.
 */
function pickHostComposition(
  document: SeamFile,
  view: View
): { host: SeamFile | (Child & { type: "composition" }); supported: boolean } {
  if (view.type === "root") return { host: document, supported: true };
  if (view.type === "composition") {
    const child = document.children[view.rootIndex];
    if (child?.type === "composition") return { host: child, supported: true };
  }
  // clip view or stale view
  return { host: document, supported: false };
}

function defaultTargets(host: { children: Child[] }): Target[] {
  const out: Target[] = [];
  host.children.forEach((c, i) => {
    if (c.type === "clip" || c.type === "audio") out.push({ index: i, child: c });
  });
  return out;
}

function selectionTargets(
  host: { children: Child[]; attachments?: Child[] },
  selectedIndices: number[]
): Target[] {
  const childCount = host.children.length;
  const out: Target[] = [];
  for (const idx of selectedIndices) {
    if (idx < childCount) {
      const c = host.children[idx];
      if (c.type === "clip" || c.type === "audio") {
        out.push({ index: idx, child: c });
      }
    } else {
      const att = host.attachments?.[idx - childCount];
      if (att && (att.type === "clip" || att.type === "audio")) {
        out.push({ index: idx, child: att });
      }
    }
  }
  return out;
}

/** Pick a fresh id that doesn't already collide with anything in the host. */
function freshId(
  host: { children: Child[]; attachments?: Child[] },
  prefix: string
): string {
  const taken = new Set<string>();
  for (const c of host.children) if (c.id) taken.add(c.id);
  for (const a of host.attachments ?? []) if (a.id) taken.add(a.id);
  for (let n = 1; ; n++) {
    const candidate = `${prefix}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Insert `replacement` at the same logical position the original target
 * occupies. `index` is in the host's selection-encoding (children first,
 * then attachments).
 */
function replaceTarget(
  host: SeamFile | (Child & { type: "composition" }),
  index: number,
  replacement: Child
): SeamFile | (Child & { type: "composition" }) {
  const childCount = host.children.length;
  if (index < childCount) {
    const newChildren = host.children.slice();
    newChildren[index] = replacement;
    return { ...host, children: newChildren };
  }
  const attIdx = index - childCount;
  const newAttachments = (host.attachments ?? []).slice();
  newAttachments[attIdx] = replacement;
  return { ...host, attachments: newAttachments };
}

function withAppendedAttachment(
  host: SeamFile | (Child & { type: "composition" }),
  attachment: Child
): SeamFile | (Child & { type: "composition" }) {
  return { ...host, attachments: [...(host.attachments ?? []), attachment] };
}

function withReplacedHost(
  document: SeamFile,
  view: View,
  newHost: SeamFile | (Child & { type: "composition" })
): SeamFile {
  if (view.type === "root") return newHost as SeamFile;
  if (view.type === "composition") {
    const newChildren = document.children.slice();
    newChildren[view.rootIndex] = newHost as Child;
    return { ...document, children: newChildren };
  }
  return document;
}

export function useTranscribe(opts: UseTranscribeOptions): UseTranscribe {
  const { serverUrl, history } = opts;
  const [progress, setProgress] = useState<TranscribeProgress | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const cancelRef = useRef(false);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const run = useCallback(
    async (document: SeamFile, view: View, selectedIndices: number[]) => {
      cancelRef.current = false;
      setErrors([]);

      const { host, supported } = pickHostComposition(document, view);
      if (!supported) {
        setErrors(["Transcription isn't supported in clip view; exit to root or a composition first."]);
        return;
      }

      const targets =
        selectedIndices.length > 0
          ? selectionTargets(host, selectedIndices)
          : defaultTargets(host);

      if (targets.length === 0) {
        setErrors(["No clip or audio targets to transcribe."]);
        return;
      }

      // Snapshot the doc once for undo. Subsequent updates use replace().
      history.pushPast(document);

      let workingDoc = document;
      let workingHost = host;
      const url = serverUrl.replace(/\/+$/, "") + "/transcribe";
      const accumulatedErrors: string[] = [];

      for (let i = 0; i < targets.length; i++) {
        if (cancelRef.current) break;

        const target = targets[i];
        const labelBase =
          target.child.source.split(/[\\/]/).pop() ?? `item ${i + 1}`;

        setProgress({
          total: targets.length,
          current: i,
          phase: "extract",
          label: labelBase,
        });

        // Make sure the clip has an id so the data node can anchor to it.
        let anchorId = target.child.id;
        let updatedTarget = target.child;
        if (!anchorId) {
          anchorId = freshId(workingHost, "cc");
          updatedTarget = { ...target.child, id: anchorId };
          workingHost = replaceTarget(
            workingHost,
            target.index,
            updatedTarget
          ) as typeof workingHost;
          workingDoc = withReplacedHost(workingDoc, view, workingHost);
          history.replace(workingDoc);
        }

        try {
          const sourceUrl = opts.platform.resolveSource(
            target.child.source,
            opts.basePath
          );
          const wav = await extractAudioWav(
            sourceUrl,
            target.child.in,
            target.child.out
          );
          if (cancelRef.current) break;

          setProgress({
            total: targets.length,
            current: i,
            phase: "upload",
            label: labelBase,
          });

          const form = new FormData();
          form.append("file", wav, "audio.wav");
          const res = await fetch(url, { method: "POST", body: form });
          if (!res.ok) {
            const detail = await res.text().catch(() => res.statusText);
            throw new Error(
              `Generator server returned ${res.status}: ${detail.slice(0, 200)}`
            );
          }
          const json = (await res.json()) as Array<{
            start: number;
            end: number;
            text: string;
            words?: Array<{ start: number; end: number; text: string }>;
          }>;

          if (cancelRef.current) break;

          // Append one data attachment per whisper segment, anchored to the
          // segment's source-time bounds on the clip. The whisper response
          // timestamps are relative to the audio we sent (which started at
          // `target.child.in` in source time), so we just shift by clip.in.
          for (const seg of json) {
            if (cancelRef.current) break;
            const start: TimeAnchor = {
              anchor: anchorId,
              timeSource: "source",
              anchorPoint: target.child.in + seg.start,
            };
            const end: TimeAnchor = {
              anchor: anchorId,
              timeSource: "source",
              anchorPoint: target.child.in + seg.end,
            };
            const dataNode: Child = {
              type: "data",
              data: { text: seg.text, words: seg.words ?? [] },
              tags: ["transcription", "whisper"],
              start,
              end,
            };
            workingHost = withAppendedAttachment(
              workingHost,
              dataNode
            ) as typeof workingHost;
          }
          workingDoc = withReplacedHost(workingDoc, view, workingHost);
          history.replace(workingDoc);
        } catch (err) {
          accumulatedErrors.push(
            `${labelBase}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      setProgress(null);
      if (accumulatedErrors.length > 0) setErrors(accumulatedErrors);
    },
    [serverUrl, opts.platform, opts.basePath, history]
  );

  return { progress, errors, run, cancel };
}
