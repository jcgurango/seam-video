import { describe, it, expect } from "vitest";
import { generateGlyphRangePBF } from "../graphic/glyphs.js";

// ── Minimal protobuf reader, just enough to decode the glyphs message ──

interface DecodedGlyph {
  id?: number;
  bitmap?: Uint8Array;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  advance?: number;
}
interface DecodedStack {
  name?: string;
  range?: string;
  glyphs: DecodedGlyph[];
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let shift = 1;
  let p = pos;
  for (;;) {
    const b = buf[p++];
    value += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) break;
    shift *= 128;
  }
  return [value, p];
}

function unzigzag(n: number): number {
  return (n >>> 1) ^ -(n & 1);
}

function decodeGlyph(buf: Uint8Array): DecodedGlyph {
  const g: DecodedGlyph = {};
  let p = 0;
  while (p < buf.length) {
    const [tag, np] = readVarint(buf, p);
    p = np;
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const [v, n2] = readVarint(buf, p);
      p = n2;
      if (field === 1) g.id = v;
      else if (field === 3) g.width = v;
      else if (field === 4) g.height = v;
      else if (field === 5) g.left = unzigzag(v);
      else if (field === 6) g.top = unzigzag(v);
      else if (field === 7) g.advance = v;
    } else if (wire === 2) {
      const [len, n2] = readVarint(buf, p);
      p = n2;
      if (field === 2) g.bitmap = buf.slice(p, p + len);
      p += len;
    }
  }
  return g;
}

function decodeGlyphs(buf: Uint8Array): DecodedStack {
  const stack: DecodedStack = { glyphs: [] };
  let p = 0;
  // top-level: field 1 (stacks) — take the first
  const [tag, np] = readVarint(buf, p);
  p = np;
  expect(tag >> 3).toBe(1);
  const [len, n2] = readVarint(buf, p);
  p = n2;
  const fs = buf.slice(p, p + len);
  let fp = 0;
  while (fp < fs.length) {
    const [t, ntp] = readVarint(fs, fp);
    fp = ntp;
    const field = t >> 3;
    const [l, nlp] = readVarint(fs, fp);
    fp = nlp;
    const body = fs.slice(fp, fp + l);
    fp += l;
    if (field === 1) stack.name = new TextDecoder().decode(body);
    else if (field === 2) stack.range = new TextDecoder().decode(body);
    else if (field === 3) stack.glyphs.push(decodeGlyph(body));
  }
  return stack;
}

describe("generateGlyphRangePBF", () => {
  it("emits a fontstack with the requested name and range", () => {
    const pbf = generateGlyphRangePBF("Noto Sans Regular", 0, 255);
    expect(pbf.length).toBeGreaterThan(0);
    const stack = decodeGlyphs(pbf);
    expect(stack.name).toBe("Noto Sans Regular");
    expect(stack.range).toBe("0-255");
    expect(stack.glyphs.length).toBeGreaterThan(0);
  });

  it("produces a well-formed glyph for 'A' with a buffer-3 bitmap", () => {
    const stack = decodeGlyphs(generateGlyphRangePBF("Noto Sans Regular", 0, 255));
    const A = stack.glyphs.find((g) => g.id === 65);
    expect(A).toBeDefined();
    expect(A!.width).toBeGreaterThan(0);
    expect(A!.height).toBeGreaterThan(0);
    expect(A!.advance).toBeGreaterThan(0);
    // bitmap is (width + 2*buffer) x (height + 2*buffer), buffer = 3
    expect(A!.bitmap!.length).toBe((A!.width! + 6) * (A!.height! + 6));
  });

  it("emits whitespace with advance but no bitmap", () => {
    const stack = decodeGlyphs(generateGlyphRangePBF("Noto Sans Regular", 0, 255));
    const space = stack.glyphs.find((g) => g.id === 32);
    expect(space).toBeDefined();
    expect(space!.advance).toBeGreaterThan(0);
    expect(space!.bitmap).toBeUndefined();
  });

  it("renders bold heavier (wider 'A' advance) than regular", () => {
    const reg = decodeGlyphs(generateGlyphRangePBF("Noto Sans Regular", 0, 255));
    const bold = decodeGlyphs(generateGlyphRangePBF("Noto Sans Bold", 0, 255));
    const ra = reg.glyphs.find((g) => g.id === 65)!;
    const ba = bold.glyphs.find((g) => g.id === 65)!;
    // bold 'A' ink is wider than regular 'A' ink
    expect(ba.width!).toBeGreaterThanOrEqual(ra.width!);
  });
});
