// Drive the "transcribe selected clips/audio" job:
//
//   1. Pick targets from the current selection (root child indices).
//   2. For each target, extract its [in, out] audio range as WAV (via
//      audioExtract) — or, for a composition, a mixed-down WAV — and POST it
//      to the generator server's /transcribe.
//   3. After each response, append one `data` node per phrase to the doc's
//      children, each heading its own run: `start` anchors the phrase's
//      source-time start on the target (`"<id>@<sec>"`) and `duration` is its
//      output length at the target's playback rate. The target is given an
//      `id` if it doesn't already have one so the anchor can resolve.
//
// One pre-snapshot via `history.pushPast` makes the whole batch a single
// undo step; intermediate updates use `history.replace` so the user sees
// progress without polluting the undo stack.

import {
  clipOut,
  formatStart,
} from "@seam/core";
import { useCallback, useRef, useState } from "react";
import type { Seam, Audio, Child, Clip, Composition, SeamFile } from "@seam/core";
import type { History } from "./useHistory.js";
import type { Platform } from "./platform/index.js";
import { extractAudioWav } from "./audioExtract.js";
import { mixCompositionAudio } from "./compositionAudioMix.js";
import { useSeam } from "./seamContext.js";

/** For a selected composition, which audio the mix covers (chosen via the
 *  modal that pops before the job runs). */
export type CompositionAudioMode = "first-run" | "all";

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

/** One transcribed phrase as the generator server returns it: times are
 *  seconds relative to the audio that was sent. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: Array<{ start: number; end: number; text: string }>;
}

/** What transcribing one node produced — for whoever turns it into nodes
 *  (the Captions extension). */
export interface TranscriptResult {
  /** Index of the transcribed node among the root children. */
  index: number;
  /** Add to a segment time to get the node's own source time (a clip's
   *  media time, a composition's inner-timeline time). */
  anchorBase: number;
  /** Source seconds per output second of the node. */
  rate: number;
  segments: TranscriptSegment[];
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
  /** Transcribe the selected root nodes WITHOUT touching the document:
   *  the segments per node, for an extension to write as it sees fit. Shows
   *  the same progress / errors as `run`. */
  transcribe: (
    document: SeamFile,
    selectedIndices: number[],
    compositionMode?: CompositionAudioMode
  ) => Promise<TranscriptResult[]>;
}

/** Targets are the selected clip/audio nodes (transcribed from their own
 *  [in,out] range) plus compositions (transcribed from a mixed-down WAV). */
type TargetChild = Clip | Audio | Composition;

interface Target {
  /** Index of the target node in the host's `children`. */
  index: number;
  child: TargetChild;
}

function isTranscribableTarget(c: Child): c is TargetChild {
  return c.type === "clip" || c.type === "audio" || c.type === "composition";
}

function selectionTargets(host: SeamFile, selectedIndices: number[]): Target[] {
  const hostChildren = host.children ?? [];
  const out: Target[] = [];
  for (const idx of selectedIndices) {
    const c = hostChildren[idx];
    if (c && isTranscribableTarget(c)) {
      out.push({ index: idx, child: c });
    }
  }
  return out;
}

/** Source seconds per output second of each root child, as resolved (so a
 *  `duration` stretch and `binItem` bodies are accounted for). Phrase
 *  durations are output seconds, whisper's are source seconds. */
function playbackRates(seam: Seam, doc: SeamFile): (number | undefined)[] {
  try {
    const resolved = seam.resolveComposition(
      seam.compileSeamFile(doc, { runScripts: false }).doc,
      { uncropped: true },
    );
    return resolved.children.map((rc) =>
      (rc.type === "clip" || rc.type === "audio" || rc.type === "composition") &&
      rc.speed > 0
        ? rc.speed
        : undefined,
    );
  } catch {
    return [];
  }
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
function freshId(host: SeamFile, prefix: string): string {
  const taken = new Set<string>();
  for (const c of host.children ?? []) if (c.id) taken.add(c.id);
  for (let n = 1; ; n++) {
    const candidate = `${prefix}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Replace the child at `index` (same slot, same placement). */
function replaceTarget(host: SeamFile, index: number, replacement: Child): SeamFile {
  const newChildren = (host.children ?? []).slice();
  newChildren[index] = replacement;
  return { ...host, children: newChildren };
}

/** Append `node` (which carries its own `start`, so it heads a new run and
 *  disturbs nothing) to the end of the host's children. */
function withAppendedChild(host: SeamFile, node: Child): SeamFile {
  return { ...host, children: [...(host.children ?? []), node] };
}

export function useTranscribe(opts: UseTranscribeOptions): UseTranscribe {
  const seam = useSeam();
  const { serverUrl, history } = opts;
  const [progress, setProgress] = useState<TranscribeProgress | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const cancelRef = useRef(false);
  const url = serverUrl.replace(/\/+$/, "") + "/transcribe";

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  /** Produce the audio for one target and have the generator server
   *  transcribe it. Resolves to whisper's segments (times relative to the
   *  extracted audio) and `anchorBase`, the source-time offset that maps them
   *  into the target's own source space. Null when cancelled or there was
   *  nothing to transcribe. Throws on a server error. */
  const fetchSegments = useCallback(
    async (
      target: Target,
      labelBase: string,
      compositionMode: CompositionAudioMode,
      document: SeamFile,
      accumulatedErrors: string[],
      setPhase: (phase: "extract" | "upload") => void,
    ): Promise<{ segments: TranscriptSegment[]; anchorBase: number } | null> => {
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
        wav = await mixCompositionAudio(seam, target.child, {
          firstRunOnly: compositionMode === "first-run",
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
          return null;
        }
      } else {
        const sourceUrl = opts.platform.resolveSource(
          target.child.source,
          opts.basePath
        );
        // Always transcribe the range FORWARD (speech played backwards
        // isn't transcribable), even for a reversed clip (`out < in`);
        // phrases anchor in source time, so they still land on the right
        // content moments.
        const out = clipOut(target.child);
        const lo = Math.min(target.child.in, out);
        wav = await extractAudioWav(sourceUrl, lo, Math.max(target.child.in, out));
        anchorBase = lo;
      }
      if (cancelRef.current || !wav) return null;

      setPhase("upload");

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

      if (cancelRef.current) return null;
      return { segments: json, anchorBase };
    },
    [seam, url, opts.authToken, opts.platform, opts.basePath],
  );

  const run = useCallback(
    async (
      document: SeamFile,
      selectedIndices: number[],
      compositionMode: CompositionAudioMode = "first-run"
    ) => {
      cancelRef.current = false;
      setErrors([]);

      // Transcription targets the selected root-level nodes. There's no
      // auto/all mode anymore — the caller gates the button on a selection.
      const targets = selectionTargets(document, selectedIndices);
      const rates = playbackRates(seam, document);

      if (targets.length === 0) {
        setErrors(["Select a clip, audio, or composition to transcribe."]);
        return;
      }

      // Snapshot the doc once for undo. Subsequent updates use replace().
      history.pushPast(document);

      let workingDoc = document;
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
          anchorId = freshId(workingDoc, "cc");
          workingDoc = replaceTarget(workingDoc, target.index, {
            ...target.child,
            id: anchorId,
          });
          history.replace(workingDoc);
        }

        try {
          const fetched = await fetchSegments(target, labelBase, compositionMode, document, accumulatedErrors, (phase) =>
            setProgress({ total: targets.length, current: i, phase, label: labelBase }),
          );
          if (cancelRef.current) break;
          if (!fetched) continue;
          const { segments: json, anchorBase } = fetched;

          // Append one data node per whisper segment, anchored to the
          // segment's source-time start on the target (clip source time, or
          // composition inner-timeline time — both reached by adding
          // `anchorBase` to the mix-relative whisper timestamps) and lasting
          // the segment's length at the target's playback rate.
          //
          // Inside `data`, word times are normalised to *phrase-local*
          // seconds (0 = phrase start) and `duration` is the phrase's
          // intrinsic length. Keeping the words in their own coordinate
          // space means consumers don't need to know which clip the
          // phrase is anchored to — the placement is a separate concern
          // handled by `start`/`duration`.
          const rate = rates[target.index] ?? 1;
          for (const seg of json) {
            if (cancelRef.current) break;
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
              start: formatStart({
                kind: "node",
                id: anchorId,
                point: { kind: "source", value: anchorBase + seg.start },
              }),
              duration: (seg.end - seg.start) / rate,
            };
            workingDoc = withAppendedChild(workingDoc, dataNode);
          }
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
    [serverUrl, opts.authToken, opts.platform, opts.basePath, history, fetchSegments]
  );

  const transcribe = useCallback(
    async (
      document: SeamFile,
      selectedIndices: number[],
      compositionMode: CompositionAudioMode = "first-run",
    ): Promise<TranscriptResult[]> => {
      cancelRef.current = false;
      setErrors([]);
      const targets = selectionTargets(document, selectedIndices);
      if (targets.length === 0) {
        setErrors(["Select a clip, audio, or composition to transcribe."]);
        return [];
      }
      const rates = playbackRates(seam, document);
      const accumulatedErrors: string[] = [];
      const results: TranscriptResult[] = [];
      for (let i = 0; i < targets.length; i++) {
        if (cancelRef.current) break;
        const target = targets[i];
        const labelBase = targetLabel(target.child, i);
        const setPhase = (phase: "extract" | "upload") =>
          setProgress({ total: targets.length, current: i, phase, label: labelBase });
        setPhase("extract");
        try {
          const fetched = await fetchSegments(target, labelBase, compositionMode, document, accumulatedErrors, setPhase);
          if (cancelRef.current) break;
          if (!fetched) continue;
          results.push({
            index: target.index,
            anchorBase: fetched.anchorBase,
            rate: rates[target.index] ?? 1,
            segments: fetched.segments,
          });
        } catch (err) {
          accumulatedErrors.push(`${labelBase}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      setProgress(null);
      if (accumulatedErrors.length > 0) setErrors(accumulatedErrors);
      return results;
    },
    [seam, fetchSegments],
  );

  return { progress, errors, run, cancel, transcribe };
}
