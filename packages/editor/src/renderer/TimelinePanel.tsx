import React, { useRef, useMemo, useCallback, useState, useEffect } from "react";
import { useTimeline } from "@seam/preview";
import { flattenResolved } from "@seam/core";
import type { ResolvedTimeline, ResolvedClip } from "@seam/core";

interface TimelinePanelProps {
  timeline: ResolvedTimeline;
  isMobile: boolean;
}

const ROW_HEIGHT = 32;
const ROW_GAP = 2;
const RULER_HEIGHT = 24;
const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 1000;
const DEFAULT_PX_PER_SEC = 100;

/** Assign each clip to a row so overlapping clips stack vertically. */
function layoutRows(clips: ResolvedClip[]): { clip: ResolvedClip; row: number }[] {
  const sorted = [...clips].sort((a, b) => a.timelineStart - b.timelineStart);
  const rowEnds: number[] = [];
  return sorted.map((clip) => {
    let row = rowEnds.findIndex((end) => end <= clip.timelineStart);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(clip.timelineEnd);
    } else {
      rowEnds[row] = clip.timelineEnd;
    }
    return { clip, row };
  });
}

/** Format seconds as m:ss.t */
function formatTime(s: number): string {
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toFixed(1).padStart(4, "0")}`;
}

/** Pick a nice ruler interval for the given scale. */
function rulerInterval(pxPerSec: number): number {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
  for (const c of candidates) {
    if (c * pxPerSec >= 60) return c;
  }
  return 60;
}

// ── Desktop mode ─────────────────────────────────────────────────────

function DesktopTimeline({ timeline }: TimelinePanelProps) {
  const { currentTime, totalDuration, isPlaying, seek } = useTimeline();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);

  const clips = useMemo(() => {
    const flat = flattenResolved(timeline.children);
    return flat.filter((c): c is ResolvedClip => c.type === "clip");
  }, [timeline]);

  const rows = useMemo(() => layoutRows(clips), [clips]);
  const rowCount = rows.length > 0 ? Math.max(...rows.map((r) => r.row)) + 1 : 1;

  const contentWidth = Math.max(totalDuration * pxPerSec + 200, 200);
  const contentHeight = RULER_HEIGHT + rowCount * (ROW_HEIGHT + ROW_GAP) + ROW_GAP;

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        setPxPerSec((prev) =>
          Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, prev * factor))
        );
      }
    },
    []
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const container = scrollRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left + container.scrollLeft;
      const time = Math.max(0, Math.min(x / pxPerSec, totalDuration));
      seek(time);

      const onMove = (me: PointerEvent) => {
        const mx = me.clientX - rect.left + container.scrollLeft;
        const mt = Math.max(0, Math.min(mx / pxPerSec, totalDuration));
        seek(mt);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [pxPerSec, totalDuration, seek]
  );

  // Auto-scroll to keep playhead centered (only while playing)
  useEffect(() => {
    if (!isPlaying) return;
    const container = scrollRef.current;
    if (!container) return;
    const playheadX = currentTime * pxPerSec;
    container.scrollLeft = playheadX - container.clientWidth / 2;
  }, [currentTime, pxPerSec, isPlaying]);

  const interval = rulerInterval(pxPerSec);
  const rulerTicks: number[] = [];
  for (let t = 0; t <= totalDuration + interval; t += interval) {
    rulerTicks.push(t);
  }

  const playheadX = currentTime * pxPerSec;

  return (
    <div
      ref={scrollRef}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      style={{
        flex: 1,
        overflow: "auto",
        position: "relative",
        cursor: "crosshair",
      }}
    >
      <div style={{ width: contentWidth, height: contentHeight, position: "relative" }}>
        <RulerLayer pxPerSec={pxPerSec} ticks={rulerTicks} />
        <ClipLayer rows={rows} pxPerSec={pxPerSec} />
        <Playhead x={playheadX} height={contentHeight} />
      </div>
    </div>
  );
}

// ── Mobile mode ──────────────────────────────────────────────────────
// Playhead is fixed at center. Scroll position drives time when paused;
// playback drives scroll position when playing. Native scroll gives us
// momentum and rubber-banding for free.

function MobileTimeline({ timeline }: TimelinePanelProps) {
  const { currentTime, totalDuration, isPlaying, seek } = useTimeline();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [padding, setPadding] = useState(0);
  // Tracks whether we're programmatically setting scrollLeft so we can
  // ignore the resulting scroll event.
  const programmaticScroll = useRef(false);

  const clips = useMemo(() => {
    const flat = flattenResolved(timeline.children);
    return flat.filter((c): c is ResolvedClip => c.type === "clip");
  }, [timeline]);

  const rows = useMemo(() => layoutRows(clips), [clips]);
  const rowCount = rows.length > 0 ? Math.max(...rows.map((r) => r.row)) + 1 : 1;

  // Half-viewport padding on each side so t=0 and t=end can center
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const measure = () => setPadding(container.clientWidth / 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const contentWidth = padding + totalDuration * pxPerSec + padding;
  const contentHeight = RULER_HEIGHT + rowCount * (ROW_HEIGHT + ROW_GAP) + ROW_GAP;

  // When playing, drive scroll from currentTime
  useEffect(() => {
    if (!isPlaying) return;
    const container = scrollRef.current;
    if (!container) return;
    programmaticScroll.current = true;
    container.scrollLeft = currentTime * pxPerSec;
  }, [currentTime, pxPerSec, isPlaying]);

  // When paused, derive time from scroll position
  const handleScroll = useCallback(() => {
    if (programmaticScroll.current) {
      programmaticScroll.current = false;
      return;
    }
    if (isPlaying) return;
    const container = scrollRef.current;
    if (!container) return;
    const time = Math.max(
      0,
      Math.min(container.scrollLeft / pxPerSec, totalDuration)
    );
    seek(time);
  }, [isPlaying, pxPerSec, totalDuration, seek]);

  // Pinch-to-zoom
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        setPxPerSec((prev) =>
          Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, prev * factor))
        );
      }
    },
    []
  );

  // Sync scroll position when zoom changes (keep same time centered)
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    programmaticScroll.current = true;
    container.scrollLeft = currentTime * pxPerSec;
  }, [pxPerSec]); // eslint-disable-line react-hooks/exhaustive-deps

  const interval = rulerInterval(pxPerSec);
  const rulerTicks: number[] = [];
  for (let t = 0; t <= totalDuration + interval; t += interval) {
    rulerTicks.push(t);
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      style={{
        flex: 1,
        overflow: "auto",
        position: "relative",
      }}
    >
      {/* Fixed playhead overlay */}
      <div
        style={{
          position: "sticky",
          left: 0,
          width: "100%",
          height: 0,
          zIndex: 4,
          pointerEvents: "none",
        }}
      >
        <Playhead x={padding} height={contentHeight} />
      </div>

      <div style={{ width: contentWidth, height: contentHeight, position: "relative" }}>
        {/* Offset all content by padding so t=0 starts at center */}
        <div style={{ position: "absolute", left: padding, top: 0, right: padding }}>
          <RulerLayer pxPerSec={pxPerSec} ticks={rulerTicks} />
          <ClipLayer rows={rows} pxPerSec={pxPerSec} />
        </div>
      </div>
    </div>
  );
}

// ── Shared sub-components ────────────────────────────────────────────

function RulerLayer({ pxPerSec, ticks }: { pxPerSec: number; ticks: number[] }) {
  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        height: RULER_HEIGHT,
        background: "#252525",
        borderBottom: "1px solid #333",
        zIndex: 2,
      }}
    >
      {ticks.map((t) => (
        <div
          key={t}
          style={{
            position: "absolute",
            left: t * pxPerSec,
            top: 0,
            height: RULER_HEIGHT,
            borderLeft: "1px solid #555",
            paddingLeft: 4,
            fontSize: 10,
            color: "#888",
            lineHeight: `${RULER_HEIGHT}px`,
            whiteSpace: "nowrap",
          }}
        >
          {formatTime(t)}
        </div>
      ))}
    </div>
  );
}

function ClipLayer({
  rows,
  pxPerSec,
}: {
  rows: { clip: ResolvedClip; row: number }[];
  pxPerSec: number;
}) {
  return (
    <>
      {rows.map(({ clip, row }, i) => {
        const left = clip.timelineStart * pxPerSec;
        const width = Math.max(
          (clip.timelineEnd - clip.timelineStart) * pxPerSec,
          2
        );
        const top = RULER_HEIGHT + ROW_GAP + row * (ROW_HEIGHT + ROW_GAP);
        const label = clip.source.split("/").pop() ?? clip.source;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left,
              top,
              width,
              height: ROW_HEIGHT,
              background: "#3a6ea5",
              borderRadius: 3,
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              paddingLeft: 6,
              paddingRight: 6,
              fontSize: 11,
              color: "#fff",
              whiteSpace: "nowrap",
              boxSizing: "border-box",
              border: "1px solid #4a8ed0",
            }}
            title={`${clip.source} [${clip.sourceIn.toFixed(2)}–${clip.sourceOut.toFixed(2)}]`}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {label}
            </span>
          </div>
        );
      })}
    </>
  );
}

function Playhead({ x, height }: { x: number; height: number }) {
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: x,
          top: 0,
          width: 1,
          height,
          background: "#ff4444",
          zIndex: 3,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: x - 5,
          top: 0,
          width: 0,
          height: 0,
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderTop: "7px solid #ff4444",
          zIndex: 3,
          pointerEvents: "none",
        }}
      />
    </>
  );
}

// ── Root component ───────────────────────────────────────────────────

export default function TimelinePanel({ timeline, isMobile }: TimelinePanelProps) {

  return (
    <div
      style={{
        background: "#1e1e1e",
        borderTop: "1px solid #333",
        display: "flex",
        flexDirection: "column",
        minHeight: 120,
        maxHeight: 300,
        userSelect: "none",
      }}
    >
      {isMobile ? (
        <MobileTimeline timeline={timeline} />
      ) : (
        <DesktopTimeline timeline={timeline} />
      )}
    </div>
  );
}
