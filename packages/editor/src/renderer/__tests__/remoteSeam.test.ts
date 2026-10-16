import { describe, it, expect } from "vitest";
import type { SeamFile } from "@seam/core";
import {
  toRemoteDocument,
  fromRemoteDocument,
  parseCloudMediaUrl,
  remoteExportFilename,
  localProjectFilename,
} from "../remoteSeam.js";

const BASE = "https://cloud.example.com";
const urlOf = (id: string) => `${BASE}/api/media/${id}/file?token=abc%3D`;

const doc: SeamFile = {
  type: "composition",
  bin: [
    {
      id: "intro",
      children: [{ type: "clip", source: "intro.mp4", in: 0, out: 2 }],
    },
  ],
  children: [
    { type: "clip", source: "a.mp4", in: 0, out: 5 },
    {
      type: "composition",
      children: [{ type: "audio", source: "voice.wav", in: 0, out: 3 }],
    },
    { type: "clip", source: "https://elsewhere.test/x.mp4", in: 0, out: 1 },
    { type: "clip", source: "blob:http://app/123", in: 0, out: 1 },
  ],
  attachments: [
    { type: "static", source: "logo.png", duration: 2, start: { anchor: "x" } },
  ],
} as SeamFile;

const sourcesOf = (d: SeamFile): string[] => {
  const out: string[] = [];
  const walk = (c: any) => {
    if (c.source) out.push(c.source);
    c.children?.forEach(walk);
    c.attachments?.forEach(walk);
    c.bin?.forEach(walk);
  };
  walk(d);
  return out;
};

describe("toRemoteDocument", () => {
  it("rewrites every cloud-backed source (incl. bin bodies) and passes remote/blob through", () => {
    const ids: Record<string, string> = {
      "a.mp4": "A",
      "voice.wav": "V",
      "logo.png": "L",
      "intro.mp4": "I",
    };
    const { document, unresolved } = toRemoteDocument(doc, (n) =>
      ids[n] ? urlOf(ids[n]) : null
    );
    expect(unresolved).toEqual([]);
    expect(sourcesOf(document)).toEqual([
      urlOf("A"),
      urlOf("V"),
      "https://elsewhere.test/x.mp4",
      "blob:http://app/123",
      urlOf("L"),
      urlOf("I"),
    ]);
    // Immutable: the input is untouched.
    expect(sourcesOf(doc)).toContain("a.mp4");
  });

  it("reports sources the cloud doesn't have, once each, and leaves them alone", () => {
    const twice: SeamFile = {
      type: "composition",
      children: [
        { type: "clip", source: "missing.mp4", in: 0, out: 1 },
        { type: "clip", source: "missing.mp4", in: 1, out: 2 },
        { type: "clip", source: "a.mp4", in: 0, out: 1 },
      ],
    } as SeamFile;
    const { document, unresolved } = toRemoteDocument(twice, (n) =>
      n === "a.mp4" ? urlOf("A") : null
    );
    expect(unresolved).toEqual(["missing.mp4"]);
    expect(sourcesOf(document)).toEqual(["missing.mp4", "missing.mp4", urlOf("A")]);
  });
});

describe("fromRemoteDocument", () => {
  it("maps recognised cloud URLs back to filenames and keeps foreign URLs", () => {
    const remote = toRemoteDocument(doc, (n) => urlOf(`id:${n}`)).document;
    const { document, kept } = fromRemoteDocument(remote, (url) => {
      const id = parseCloudMediaUrl(url, BASE);
      return id?.startsWith("id:") ? id.slice(3) : null;
    });
    expect(sourcesOf(document)).toEqual(sourcesOf(doc));
    expect(kept).toEqual(["https://elsewhere.test/x.mp4"]);
  });
});

describe("parseCloudMediaUrl", () => {
  it("extracts the id with or without a query, tolerating a trailing slash on the base", () => {
    expect(parseCloudMediaUrl(urlOf("m1"), BASE)).toBe("m1");
    expect(parseCloudMediaUrl(`${BASE}/api/media/m1/file`, `${BASE}/`)).toBe("m1");
  });
  it("rejects other clouds, other routes, and non-URLs", () => {
    expect(parseCloudMediaUrl(urlOf("m1"), "https://other.example.com")).toBeNull();
    expect(parseCloudMediaUrl(`${BASE}/api/media/m1/thumb`, BASE)).toBeNull();
    expect(parseCloudMediaUrl(`${BASE}/api/media/m1`, BASE)).toBeNull();
    expect(parseCloudMediaUrl("a.mp4", BASE)).toBeNull();
    // A base that is a string-prefix of another host must not match.
    expect(parseCloudMediaUrl(`${BASE}.evil/api/media/m1/file`, BASE)).toBeNull();
  });
});

describe("filenames", () => {
  it("round-trips the -remote suffix", () => {
    expect(remoteExportFilename("intro")).toBe("intro-remote.seam");
    expect(localProjectFilename("intro-remote.seam")).toBe("intro.seam");
    expect(localProjectFilename("intro.seam")).toBe("intro.seam");
    expect(localProjectFilename("intro")).toBe("intro.seam");
    expect(localProjectFilename("-remote.seam")).toBe("-remote.seam");
  });
});
