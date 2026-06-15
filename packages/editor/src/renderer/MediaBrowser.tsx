import React, { useEffect, useMemo, useRef, useState } from "react";
import { Film, Music, Image as ImageIcon, Map as MapIcon } from "lucide-react";
import type { SeamFile } from "@seam/core";
import type { WebPlatform, MediaMeta } from "./platform/web.js";
import {
  buildItemFromSource,
  classifyByName,
  IMAGE_DEFAULT_DURATION_S,
  SOURCE_DRAG_MIME,
  type MediaKind,
} from "./useImport.js";
import {
  generateThumbnail,
  extractCaptureDate,
  probeDurationSeconds,
} from "./mediaThumbs.js";
import { collectClipSources } from "./exportHelpers.js";

interface MediaBrowserProps {
  platform: WebPlatform;
  /** Active document — drives the "In this project" filter. */
  currentDoc: SeamFile;
}

type SortKey = "date" | "added" | "used";

interface MediaItem {
  name: string;
  kind: MediaKind;
  addedAt: number;
  lastUsedAt?: number;
  captureDate?: number;
  duration?: number;
  /** null = no thumbnail (audio/pmtiles or not generated yet → icon). */
  thumbUrl: string | null;
}

/** Default fallback duration (s) for a drag when probing didn't yield one. */
const FALLBACK_DURATION_S = 5;

function dragDuration(item: MediaItem): number {
  if (item.kind === "image" || item.kind === "pmtiles")
    return IMAGE_DEFAULT_DURATION_S;
  return item.duration ?? FALLBACK_DURATION_S;
}

function sortValue(item: MediaItem, key: SortKey): number {
  if (key === "added") return item.addedAt;
  if (key === "used") return item.lastUsedAt ?? 0;
  return item.captureDate ?? item.addedAt; // "date"
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function KindIcon({ kind }: { kind: MediaKind }) {
  const common = { size: 28, color: "#777" } as const;
  if (kind === "audio") return <Music {...common} />;
  if (kind === "pmtiles") return <MapIcon {...common} />;
  if (kind === "video") return <Film {...common} />;
  return <ImageIcon {...common} />;
}

/**
 * Web media bin: a grid of everything in OPFS clips/. Thumbnails (image
 * downscale / video first frame) and capture-date/duration metadata are
 * generated once and cached by the platform; subsequent opens are instant.
 * Tiles drag onto the timeline (the timeline's drop handler builds the node
 * from the `application/x-seam-source` payload). Rendered as a section of the
 * inspector accordion, so the timeline stays visible to drop onto.
 */
export default function MediaBrowser({ platform, currentDoc }: MediaBrowserProps) {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [sort, setSort] = useState<SortKey>("added");
  const [inProjectOnly, setInProjectOnly] = useState(false);
  const [query, setQuery] = useState("");

  // Track blob URLs we mint so we can revoke them on unmount.
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const mintedUrls: string[] = [];
    urlsRef.current = mintedUrls;

    (async () => {
      const clips = await platform.listClips();
      const index = await platform.getMediaIndex();

      // Seed the grid immediately (names + icons), addedAt backfilled from the
      // OPFS write time when the index has no entry yet.
      const seed: MediaItem[] = [];
      for (const c of clips) {
        const kind = classifyByName(c.name);
        if (!kind) continue; // skip non-media files
        const meta = index[c.name] as MediaMeta | undefined;
        seed.push({
          name: c.name,
          kind,
          addedAt: meta?.addedAt ?? c.lastModified,
          lastUsedAt: meta?.lastUsedAt,
          captureDate: meta?.captureDate,
          duration: meta?.duration,
          thumbUrl: null,
        });
      }
      if (cancelled) return;
      setItems(seed);

      // Progressive, one-time enrichment: generate + cache thumbnail and probe
      // capture date / duration for any clip not yet `probed`. Update the tile
      // as each resolves so the grid fills in.
      for (const item of seed) {
        if (cancelled) return;
        const meta = index[item.name] as MediaMeta | undefined;

        if (meta?.probed) {
          const url = await platform.readThumbnailUrl(item.name);
          if (cancelled) return;
          if (url) {
            mintedUrls.push(url);
            patchItem(item.name, { thumbUrl: url });
          }
          continue;
        }

        try {
          const file = await platform.getClipFile(item.name);
          const [thumb, captureDate, duration] = await Promise.all([
            generateThumbnail(file, item.kind),
            extractCaptureDate(file, item.kind),
            probeDurationSeconds(file, item.kind),
          ]);
          if (cancelled) return;

          const patch: Partial<MediaMeta> = {
            kind: item.kind,
            addedAt: item.addedAt,
            captureDate,
            duration,
            probed: true,
          };
          let url: string | null = null;
          if (thumb) {
            await platform.writeThumbnail(item.name, thumb.blob);
            patch.width = thumb.width;
            patch.height = thumb.height;
            url = URL.createObjectURL(thumb.blob);
            mintedUrls.push(url);
          }
          await platform.updateMediaMeta(item.name, patch);
          if (cancelled) return;
          patchItem(item.name, { captureDate, duration, thumbUrl: url });
        } catch (err) {
          console.warn(`MediaBrowser: enrich failed for ${item.name}`, err);
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const u of mintedUrls) URL.revokeObjectURL(u);
    };
    // Rebuild only when the platform changes (i.e. essentially never). New
    // imports while open aren't auto-reflected — acceptable for this pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  const patchItem = (name: string, patch: Partial<MediaItem>) => {
    setItems((prev) =>
      prev
        ? prev.map((it) => (it.name === name ? { ...it, ...patch } : it))
        : prev,
    );
  };

  const usedSources = useMemo(
    () => new Set(collectClipSources(currentDoc)),
    [currentDoc],
  );

  const shown = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    const filtered = items.filter(
      (it) =>
        (!inProjectOnly || usedSources.has(it.name)) &&
        (q === "" || it.name.toLowerCase().includes(q)),
    );
    return [...filtered].sort((a, b) => sortValue(b, sort) - sortValue(a, sort));
  }, [items, inProjectOnly, usedSources, sort, query]);

  const handleDragStart = (item: MediaItem, e: React.DragEvent) => {
    const child = buildItemFromSource(item.kind, item.name, dragDuration(item));
    e.dataTransfer.setData(SOURCE_DRAG_MIME, JSON.stringify([child]));
    e.dataTransfer.effectAllowed = "copy";
  };

  const handleDragEnd = (item: MediaItem, e: React.DragEvent) => {
    // Landed on a valid drop target (the timeline) → bump "last used".
    if (e.dataTransfer.dropEffect === "none") return;
    void platform.markClipUsed(item.name);
    patchItem(item.name, { lastUsedAt: Date.now() });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid #2a2a2a",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, color: "#aaa" }}>
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              style={selectStyle}
            >
              <option value="date">Date</option>
              <option value="added">Date Added</option>
              <option value="used">Last Used</option>
            </select>
          </label>
          <label
            style={{ display: "flex", alignItems: "center", gap: 6, color: "#aaa", cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={inProjectOnly}
              onChange={(e) => setInProjectOnly(e.target.checked)}
            />
            In this project
          </label>
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name…"
          style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 10 }}>
        {shown === null ? (
          <div style={{ color: "#888", padding: 12 }}>Loading…</div>
        ) : shown.length === 0 ? (
          <div style={{ color: "#888", padding: 12 }}>
            {query.trim()
              ? "No media matches your filter."
              : inProjectOnly
                ? "No media used in this project."
                : "No media yet."}
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
              gap: 10,
            }}
          >
            {shown.map((item) => (
              <div
                key={item.name}
                draggable
                onDragStart={(e) => handleDragStart(item, e)}
                onDragEnd={(e) => handleDragEnd(item, e)}
                title={`${item.name}\n${formatDate(sortValue(item, sort))}`}
                style={{ cursor: "grab", userSelect: "none" }}
              >
                <div
                  style={{
                    aspectRatio: "1 / 1",
                    background: "#161616",
                    border: "1px solid #2e2e2e",
                    borderRadius: 4,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                  }}
                >
                  {item.thumbUrl ? (
                    <img
                      src={item.thumbUrl}
                      alt={item.name}
                      draggable={false}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <KindIcon kind={item.kind} />
                  )}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "#bbb",
                    marginTop: 4,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {item.name}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: "#1a1a1a",
  border: "1px solid #444",
  borderRadius: 4,
  color: "#e0e0e0",
  padding: "3px 6px",
  fontSize: 12,
  fontFamily: "inherit",
};
