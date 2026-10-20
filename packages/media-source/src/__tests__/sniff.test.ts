import { describe, it, expect } from "vitest";
import { sniffStaticKind } from "../sniff.js";

const bytes = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

describe("sniffStaticKind", () => {
  it("recognises raster magic numbers", () => {
    expect(sniffStaticKind(bytes("\x89PNG\r\n\x1a\n"))).toBe("raster");
    expect(sniffStaticKind(bytes("\xff\xd8\xff\xe0JFIF"))).toBe("raster");
    expect(sniffStaticKind(bytes("GIF89a"))).toBe("raster");
    expect(sniffStaticKind(bytes("RIFF\0\0\0\0WEBPVP8 "))).toBe("raster");
    expect(sniffStaticKind(bytes("\0\0\0\x1cftypavif"))).toBe("raster");
  });

  it("recognises SVG by content, with or without a prolog, regardless of name", () => {
    expect(sniffStaticKind(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBe("svg");
    expect(sniffStaticKind(bytes('\xef\xbb\xbf<?xml version="1.0"?>\n<!-- c -->\n<svg>'))).toBe("svg");
    expect(sniffStaticKind(bytes("<html><body>svg</body></html>"))).toBe("unknown");
  });

  it("leaves video containers unknown", () => {
    expect(sniffStaticKind(bytes("\0\0\0\x20ftypisom"))).toBe("unknown");
    expect(sniffStaticKind(bytes("\x1aE\xdf\xa3"))).toBe("unknown"); // mkv/webm
    expect(sniffStaticKind(new Uint8Array(0))).toBe("unknown");
  });
});
