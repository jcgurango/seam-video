// Mounts an extension's view (`EditorExtension.views`) in the editor's left
// pane and hands it what the contract in `@seam/core`'s `editor-api.ts`
// promises: the command context, its target, preview / close, and the
// player.
//
// Lives INSIDE `<Timeline>` so it can reach the transport. The playhead
// changes every tick; the view must not re-render with it, so the player it
// gets is a stable object reading through refs, and the component is
// memoized.

import React, { memo, useMemo, useRef, type ComponentType } from "react";
import { useTimeline } from "@seam/preview";
import type {
  EditorCommandContext,
  EditorPlayer,
  EditorView,
  EditorViewProps,
  ResolvedTimeline,
  SeamFile,
} from "@seam/core";
import { parsePath } from "./nodePath.js";
import { globalSpanOf } from "./resolveLocal.js";

export interface ExtensionViewHostProps {
  view: EditorView;
  target: string;
  context: EditorCommandContext;
  /** What the player + timeline show right now (the view's preview, or the
   *  real document) and its `uncropped`, scripts-off resolution. */
  shownDocument: SeamFile;
  shownTimeline: ResolvedTimeline;
  onPreview: (doc: SeamFile | null) => void;
  onClose: () => void;
}

export default function ExtensionViewHost({
  view,
  target,
  context,
  shownDocument,
  shownTimeline,
  onPreview,
  onClose,
}: ExtensionViewHostProps) {
  const { currentTime, seek } = useTimeline();

  // Latest values, read on demand by the stable `player` below.
  const live = useRef({ currentTime, seek, shownDocument, shownTimeline, seam: context.seam });
  live.current = { currentTime, seek, shownDocument, shownTimeline, seam: context.seam };

  const player = useMemo<EditorPlayer>(
    () => ({
      time: () => live.current.currentTime,
      seek: (t) => live.current.seek(Math.max(0, t)),
      spanOf: (key) => {
        if (key === "") return null;
        const { seam, shownTimeline: resolved, shownDocument: doc } = live.current;
        try {
          return globalSpanOf(seam, resolved, doc, parsePath(key));
        } catch {
          return null;
        }
      },
    }),
    [],
  );

  // Memoized per view, so the per-tick re-render of this host stops here.
  const Component = useMemo(
    () => memo(view.component as ComponentType<EditorViewProps>),
    [view],
  );

  return (
    <Component
      context={context}
      target={target}
      preview={onPreview}
      close={onClose}
      player={player}
    />
  );
}
