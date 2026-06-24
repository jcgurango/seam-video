/** Media kind, matching the web editor's classification. */
export type MediaKind = "video" | "audio" | "image" | "pmtiles";

/** Sort keys for the media browser — mirror @seam/editor's MediaBrowser. */
export type MediaSort = "date" | "added" | "used";

/** A media row as stored / returned by the API (sidecar metadata + identity). */
export interface MediaRecord {
  id: string;
  userId: string;
  filename: string;
  kind: MediaKind;
  contentType: string | null;
  size: number;
  addedAt: number;
  lastUsedAt: number | null;
  captureDate: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  probed: boolean;
  hasThumb: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A project row. */
export interface ProjectRecord {
  id: string;
  userId: string;
  name: string;
  size: number;
  lastModified: number;
  createdAt: number;
  updatedAt: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
