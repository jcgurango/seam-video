import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Film,
  Music,
  Image as ImageIcon,
  Map as MapIcon,
  Download,
  Trash2,
  Cloud,
  UploadCloud,
  DownloadCloud,
  RefreshCw,
} from "lucide-react";
import type { SeamFile } from "@seam/core";
import type { WebPlatform, MediaMeta } from "./platform/web.js";
import type { CloudMedia } from "./cloud/CloudClient.js";
import { useCloud } from "./cloud/useCloud.js";
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
  /** Active document — drives the "In this project" filter (inspector only). */
  currentDoc?: SeamFile;
  /** "inspector" (default): draggable tiles that drop onto the timeline.
   *  "main": the web landing grid — tiles aren't draggable and gain per-item
   *  Download/Delete actions on hover. */
  variant?: "inspector" | "main";
}

type SortKey = "date" | "added" | "used";

/** Where a media item lives relative to the user's local OPFS + Seam Cloud. */
type Location = "local" | "cloud" | "both";

interface MediaItem {
  name: string;
  kind: MediaKind;
  addedAt: number;
  lastUsedAt?: number;
  captureDate?: number;
  duration?: number;
  /** null = no thumbnail (audio/pmtiles or not generated yet → icon). */
  thumbUrl: string | null;
  /** local: OPFS only · cloud: Seam Cloud only · both: present in each. */
  location: Location;
  /** Seam Cloud id (set when location is cloud/both) — for thumb/stream/download. */
  cloudId?: string;
  /** Cloud content hash (for download dedup checks). */
  contentHash?: string | null;
  size?: number;
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

/** Build a (thumbnail-only) media item from a cloud record not held locally. */
function cloudMediaToItem(
  cm: CloudMedia,
  cloud: { mediaThumbUrl(id: string): string } | null,
): MediaItem {
  return {
    name: cm.filename,
    kind: cm.kind,
    addedAt: cm.addedAt,
    lastUsedAt: cm.lastUsedAt ?? undefined,
    captureDate: cm.captureDate ?? undefined,
    duration: cm.duration ?? undefined,
    thumbUrl: cm.hasThumb && cloud ? cloud.mediaThumbUrl(cm.id) : null,
    location: "cloud",
    cloudId: cm.id,
    contentHash: cm.contentHash,
    size: cm.size,
  };
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Top-left badge marking a tile's relationship to Seam Cloud. */
function LocationBadge({ location }: { location: Location }) {
  const cloudOnly = location === "cloud";
  return (
    <div
      title={cloudOnly ? "In Seam Cloud (not downloaded)" : "Synced with Seam Cloud"}
      style={{
        position: "absolute",
        top: 4,
        left: 4,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        borderRadius: 4,
        background: "rgba(0,0,0,0.6)",
        color: cloudOnly ? "#6aa8e0" : "#5ec98a",
      }}
    >
      <Cloud size={12} />
    </div>
  );
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
export default function MediaBrowser({
  platform,
  currentDoc,
  variant = "inspector",
}: MediaBrowserProps) {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [sort, setSort] = useState<SortKey>("added");
  const [inProjectOnly, setInProjectOnly] = useState(false);
  const [query, setQuery] = useState("");
  // Tile whose action overlay is currently shown (main variant only).
  const [hovered, setHovered] = useState<string | null>(null);

  // Cloud upload/download bookkeeping (main variant).
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<{ done: number; total: number } | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);

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
          location: "local",
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
    // reloadKey re-scans local clips after a cloud download adds one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, reloadKey]);

  const patchItem = (name: string, patch: Partial<MediaItem>) => {
    setItems((prev) =>
      prev
        ? prev.map((it) => (it.name === name ? { ...it, ...patch } : it))
        : prev,
    );
  };

  const usedSources = useMemo(
    () => new Set(currentDoc ? collectClipSources(currentDoc) : []),
    [currentDoc],
  );

  // Seam Cloud assets (if connected) shown side-by-side with local media.
  const cloud = (platform as WebPlatform).cloud ?? null;
  const cloudState = useCloud(cloud);

  // Merge local + cloud by filename. Local always wins (its tile is the
  // draggable, fully-probed one), gaining a "both" marker when the cloud also
  // has it; cloud-only files become thumbnail-only tiles flagged "cloud".
  const merged = useMemo(() => {
    if (!items) return null;
    const cloudMedia = cloudState?.media ?? [];
    const cloudByName = new Map(cloudMedia.map((m) => [m.filename, m]));
    const out: MediaItem[] = items.map((it) => {
      const cm = cloudByName.get(it.name);
      return cm
        ? { ...it, location: "both", cloudId: cm.id, contentHash: cm.contentHash }
        : { ...it, location: "local" };
    });
    const localNames = new Set(items.map((i) => i.name));
    for (const cm of cloudMedia) {
      if (localNames.has(cm.filename)) continue;
      out.push(cloudMediaToItem(cm, cloud));
    }
    return out;
  }, [items, cloudState, cloud]);

  const shown = useMemo(() => {
    if (!merged) return null;
    const q = query.trim().toLowerCase();
    const filtered = merged.filter(
      (it) =>
        (!inProjectOnly || usedSources.has(it.name)) &&
        (q === "" || it.name.toLowerCase().includes(q)),
    );
    return [...filtered].sort((a, b) => sortValue(b, sort) - sortValue(a, sort));
  }, [merged, inProjectOnly, usedSources, sort, query]);

  const handleDragStart = (item: MediaItem, e: React.DragEvent) => {
    const child = buildItemFromSource(item.kind, item.name, dragDuration(item));
    e.dataTransfer.setData(SOURCE_DRAG_MIME, JSON.stringify([child]));
    e.dataTransfer.effectAllowed = "copy";
  };

  const handleDragEnd = (item: MediaItem, e: React.DragEvent) => {
    // Landed on a valid drop target (the timeline) → bump "last used".
    if (e.dataTransfer.dropEffect === "none") return;
    // Cloud-only items have no local meta to stamp (they stream from the
    // cloud via resolveSource's fallback); skip the local bookkeeping.
    if (item.location === "cloud") return;
    void platform.markClipUsed(item.name);
    patchItem(item.name, { lastUsedAt: Date.now() });
  };

  const handleDownload = (item: MediaItem) => {
    void platform.downloadClip(item.name);
  };

  const wp = platform as WebPlatform;

  // Deleting a local copy that's also in Seam Cloud is safe(ish) — the cloud
  // keeps the file, so it just reverts to a cloud-only tile (re-downloadable).
  // Deleting a local-only file gets its own flow later, so it's disabled here.
  const handleDelete = async (item: MediaItem) => {
    if (item.location !== "both") return;
    setBusyName(item.name);
    setNotice(null);
    try {
      await wp.deleteClip(item.name);
      setReloadKey((k) => k + 1); // re-scan local → tile becomes cloud-only
    } catch (err) {
      setNotice(`Delete failed for "${item.name}": ${errMessage(err)}`);
    } finally {
      setBusyName(null);
    }
  };

  const cloudAuthed = !!cloud && cloudState?.status === "authed";

  const handleUpload = async (item: MediaItem) => {
    if (!cloud) return;
    setBusyName(item.name);
    setNotice(null);
    try {
      const res = await wp.uploadClipToCloud(item.name);
      if (res.kind === "conflict") {
        setNotice(`Couldn't upload "${item.name}": ${res.message}`);
      }
      await cloud.refreshMedia();
    } catch (err) {
      setNotice(`Upload failed for "${item.name}": ${errMessage(err)}`);
    } finally {
      setBusyName(null);
    }
  };

  const handleCloudDownload = async (item: MediaItem) => {
    if (!cloud || !item.cloudId) return;
    setBusyName(item.name);
    setNotice(null);
    try {
      await wp.downloadClipFromCloud(item.cloudId, item.name, item.contentHash ?? null);
      setReloadKey((k) => k + 1); // re-scan local clips so the new file appears
    } catch (err) {
      setNotice(`Download failed for "${item.name}": ${errMessage(err)}`);
    } finally {
      setBusyName(null);
    }
  };

  const handleSyncAll = async () => {
    if (!cloud) return;
    setNotice(null);
    setSyncing({ done: 0, total: 0 });
    try {
      const summary = await wp.syncAllToCloud((done, total) =>
        setSyncing({ done, total })
      );
      const parts: string[] = [];
      if (summary.uploaded) parts.push(`${summary.uploaded} uploaded`);
      const present = summary.alreadyPresent + summary.skipped;
      if (present) parts.push(`${present} already synced`);
      let msg = parts.join(", ") || "Nothing to upload.";
      if (summary.conflicts.length) {
        msg += ` · ${summary.conflicts.length} need renaming: ${summary.conflicts
          .map((c) => c.name)
          .join(", ")}`;
      }
      setNotice(msg);
    } catch (err) {
      setNotice(`Sync failed: ${errMessage(err)}`);
    } finally {
      setSyncing(null);
    }
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
          {variant === "inspector" && (
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
          )}
          {variant === "main" && cloudAuthed && (
            <div
              style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}
            >
              <button
                onClick={() => void cloud!.refreshMedia()}
                disabled={cloudState?.refreshing}
                title="Refresh cloud list"
                style={{
                  display: "flex",
                  alignItems: "center",
                  background: "#2e2e2e",
                  border: "1px solid #3a3a3a",
                  color: "#e0e0e0",
                  padding: "6px 8px",
                  borderRadius: 6,
                  cursor: cloudState?.refreshing ? "default" : "pointer",
                  opacity: cloudState?.refreshing ? 0.6 : 1,
                }}
              >
                <RefreshCw size={15} />
              </button>
              <button
                onClick={handleSyncAll}
                disabled={!!syncing}
                title="Upload all local media to Seam Cloud"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: "#2e2e2e",
                  border: "1px solid #3a3a3a",
                  color: "#e0e0e0",
                  padding: "6px 12px",
                  borderRadius: 6,
                  cursor: syncing ? "default" : "pointer",
                  fontSize: 13,
                  opacity: syncing ? 0.6 : 1,
                }}
              >
                <UploadCloud size={15} />
                {syncing
                  ? `Syncing ${syncing.done}/${syncing.total}…`
                  : "Sync to Cloud"}
              </button>
            </div>
          )}
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name…"
          style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }}
        />
        {notice && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              fontSize: 12,
              color: "#ddd",
              background: "#222",
              border: "1px solid #3a3a3a",
              borderRadius: 6,
              padding: "6px 10px",
            }}
          >
            <span style={{ flex: 1 }}>{notice}</span>
            <button
              onClick={() => setNotice(null)}
              style={{
                background: "none",
                border: "none",
                color: "#888",
                cursor: "pointer",
                padding: 0,
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        )}
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
                draggable={variant === "inspector"}
                onDragStart={(e) => handleDragStart(item, e)}
                onDragEnd={(e) => handleDragEnd(item, e)}
                onMouseEnter={() => setHovered(item.name)}
                onMouseLeave={() => setHovered((h) => (h === item.name ? null : h))}
                title={`${item.name}\n${formatDate(sortValue(item, sort))}`}
                style={{
                  cursor: variant === "inspector" ? "grab" : "default",
                  userSelect: "none",
                }}
              >
                <div
                  style={{
                    position: "relative",
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
                  {item.location !== "local" && (
                    <LocationBadge location={item.location} />
                  )}
                  {variant === "main" && hovered === item.name && (
                    <div
                      style={{
                        position: "absolute",
                        top: 4,
                        right: 4,
                        display: "flex",
                        gap: 4,
                      }}
                    >
                      {cloudAuthed && item.location === "local" && (
                        <TileAction
                          title="Upload to Seam Cloud"
                          onClick={() => handleUpload(item)}
                          disabled={busyName === item.name}
                        >
                          <UploadCloud size={14} />
                        </TileAction>
                      )}
                      {cloudAuthed && item.location === "cloud" && (
                        <TileAction
                          title="Download from Seam Cloud"
                          onClick={() => handleCloudDownload(item)}
                          disabled={busyName === item.name}
                        >
                          <DownloadCloud size={14} />
                        </TileAction>
                      )}
                      {item.location !== "cloud" && (
                        <>
                          <TileAction
                            title="Download"
                            onClick={() => handleDownload(item)}
                          >
                            <Download size={14} />
                          </TileAction>
                          <TileAction
                            title={
                              item.location === "both"
                                ? "Delete local copy (kept in Seam Cloud)"
                                : "Local-only delete coming soon"
                            }
                            danger
                            disabled={
                              item.location !== "both" || busyName === item.name
                            }
                            onClick={() => void handleDelete(item)}
                          >
                            <Trash2 size={14} />
                          </TileAction>
                        </>
                      )}
                    </div>
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

/** Small overlay button on a media tile (upload / download / delete). */
function TileAction({
  title,
  onClick,
  danger,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      draggable={false}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      style={{
        background: "rgba(0, 0, 0, 0.65)",
        border: "none",
        color: "#ddd",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        padding: 4,
        borderRadius: 4,
        display: "flex",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.color = danger ? "#ff6b6b" : "#fff")
      }
      onMouseLeave={(e) => (e.currentTarget.style.color = "#ddd")}
    >
      {children}
    </button>
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
