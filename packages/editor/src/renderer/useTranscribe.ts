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
  Composition,
  SeamFile,
  TimeAnchor,
} from "@seam/core";
import type { History } from "./useHistory.js";
import type { Platform } from "./platform/index.js";
import { extractAudioWav } from "./audioExtract.js";
import { mixCompositionAudio } from "./compositionAudioMix.js";

/** For a selected composition, which audio the mix covers (chosen via the
 *  modal that pops before the job runs). */
export type CompositionAudioMode = "children" | "children-and-attachments";

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
  /** Bearer token to send (when `serverUrl` is the authenticated Seam Cloud
   *  generator proxy). Omitted for a direct generator connection. */
  authToken?: string;
  platform: Platform;
  basePath: string;
  history: History<SeamFile>;
}

export interface UseTranscribe {
  progress: TranscribeProgress | null;
  errors: string[];
  run: (
    document: SeamFile,
    selectedIndices: number[],
    compositionMode?: CompositionAudioMode
  ) => Promise<void>;
  cancel: () => void;
}

/** Targets are the selected clip/audio nodes (transcribed from their own
 *  [in,out] range) plus compositions (transcribed from a mixed-down WAV). */
type TargetChild = Clip | Audio | Composition;

interface Target {
  /** Index into the host's selection-encoding (children first, then
   *  attachments) of the target node. */
  index: number;
  child: TargetChild;
}

function isTranscribableTarget(c: Child): c is TargetChild {
  return c.type === "clip" || c.type === "audio" || c.type === "composition";
}

function selectionTargets(
  host: { children?: Child[]; attachments?: Child[] },
  selectedIndices: number[]
): Target[] {
  const hostChildren = host.children ?? [];
  const childCount = hostChildren.length;
  const out: Target[] = [];
  for (const idx of selectedIndices) {
    const c =
      idx < childCount
        ? hostChildren[idx]
        : host.attachments?.[idx - childCount];
    if (c && isTranscribableTarget(c)) {
      out.push({ index: idx, child: c });
    }
  }
  return out;
}

/** Progress label for a target: clip/audio show their source basename;
 *  compositions show their id (or a generic fallback). */
function targetLabel(child: TargetChild, i: number): string {
  if (child.type === "composition") {
    return child.id ? `composition "${child.id}"` : `composition ${i + 1}`;
  }
  return child.source.split(/[\\/]/).pop() ?? `item ${i + 1}`;
}

/** Pick a fresh id that doesn't already collide with anything in the host. */
function freshId(
  host: { children?: Child[]; attachments?: Child[] },
  prefix: string
): string {
  const taken = new Set<string>();
  for (const c of host.children ?? []) if (c.id) taken.add(c.id);
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
  const hostChildren = host.children ?? [];
  const childCount = hostChildren.length;
  if (index < childCount) {
    const newChildren = hostChildren.slice();
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

export function useTranscribe(opts: UseTranscribeOptions): UseTranscribe {
  const { serverUrl, history } = opts;
  const [progress, setProgress] = useState<TranscribeProgress | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const cancelRef = useRef(false);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const run = useCallback(
    async (
      document: SeamFile,
      selectedIndices: number[],
      compositionMode: CompositionAudioMode = "children"
    ) => {
      cancelRef.current = false;
      setErrors([]);

      // Transcription targets the selected root-level nodes. There's no
      // auto/all mode anymore — the caller gates the button on a selection.
      const host = document;
      const targets = selectionTargets(host, selectedIndices);

      if (targets.length === 0) {
        setErrors(["Select a clip, audio, or composition to transcribe."]);
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
        const labelBase = targetLabel(target.child, i);

        setProgress({
          total: targets.length,
          current: i,
          phase: "extract",
          label: labelBase,
        });

        // Make sure the node has an id so the data node can anchor to it.
        let anchorId = target.child.id;
        if (!anchorId) {
          anchorId = freshId(workingHost, "cc");
          workingHost = replaceTarget(workingHost, target.index, {
            ...target.child,
            id: anchorId,
          }) as typeof workingHost;
          workingDoc = workingHost as SeamFile;
          history.replace(workingDoc);
        }

        try {
          // Produce the WAV to transcribe, and the source-time offset to add
          // to whisper's (mix-relative) segment times so the data anchors land
          // in the target's source space:
          //  - clip/audio: extract the [in,out] range; whisper t is relative
          //    to `in`, so anchorBase = in.
          //  - composition: mix the inner timeline from t=0 (resolveComposition
          //    ignores the comp's own window when it's the root), so whisper t
          //    is the comp's source time directly — anchorBase = 0.
          let wav: Blob | null;
          let anchorBase: number;
          if (target.child.type === "composition") {
            wav = await mixCompositionAudio(target.child, {
              includeAttachments:
                compositionMode === "children-and-attachments",
              // Root-level target → the document IS its enclosing scope, so
              // its bin/macros are what binItem/`$$` references resolve against.
              rootBin: document.bin,
              rootMacros: document.macros,
              resolveSource: (s) =>
                opts.platform.resolveSource(s, opts.basePath),
              onLeafError: (src, err) =>
                accumulatedErrors.push(
                  `${labelBase} / ${src}: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                ),
              onCompileError: (message) =>
                accumulatedErrors.push(`${labelBase}: ${message}`),
            });
            anchorBase = 0;
            if (wav == null) {
              accumulatedErrors.push(
                `${labelBase}: composition has no transcribable audio`
              );
              continue;
            }
          } else {
            const sourceUrl = opts.platform.resolveSource(
              target.child.source,
              opts.basePath
            );
            wav = await extractAudioWav(
              sourceUrl,
              target.child.in,
              target.child.out
            );
            anchorBase = target.child.in;
          }
          if (cancelRef.current) break;

          setProgress({
            total: targets.length,
            current: i,
            phase: "upload",
            label: labelBase,
          });

          const form = new FormData();
          form.append("file", wav, "audio.wav");
          const res = await fetch(url, {
            method: "POST",
            body: form,
            headers: opts.authToken
              ? { Authorization: `Bearer ${opts.authToken}` }
              : undefined,
          });
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
          // segment's source-time bounds on the target (clip source time, or
          // composition inner-timeline time — both reached by adding
          // `anchorBase` to the mix-relative whisper timestamps).
          //
          // Inside `data`, word times are normalised to *phrase-local*
          // seconds (0 = phrase start) and `duration` is the phrase's
          // intrinsic length. Keeping the words in their own coordinate
          // space means consumers don't need to know which clip the
          // phrase is anchored to — the anchor placement is a separate
          // concern handled by `start`/`end`.
          for (const seg of json) {
            if (cancelRef.current) break;
            const start: TimeAnchor = {
              anchor: anchorId,
              timeSource: "source",
              anchorPoint: anchorBase + seg.start,
            };
            const end: TimeAnchor = {
              anchor: anchorId,
              timeSource: "source",
              anchorPoint: anchorBase + seg.end,
            };
            const phraseStart = seg.start;
            const words = (seg.words ?? []).map((w) => ({
              text: w.text,
              start: Math.max(0, w.start - phraseStart),
              end: Math.max(0, w.end - phraseStart),
            }));
            const dataNode: Child = {
              type: "data",
              data: {
                text: seg.text,
                words,
                duration: seg.end - seg.start,
              },
              tags: ["transcription", "whisper"],
              start,
              end,
            };
            workingHost = withAppendedAttachment(
              workingHost,
              dataNode
            ) as typeof workingHost;
          }
          workingDoc = workingHost as SeamFile;
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
    [serverUrl, opts.authToken, opts.platform, opts.basePath, history]
  );

  return { progress, errors, run, cancel };
}
