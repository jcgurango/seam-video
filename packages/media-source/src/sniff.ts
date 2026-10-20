/**
 * Content sniffing for `static` sources. Both hosts decide how to decode a
 * static (SVG → vector rasterizer, raster → image decoder, anything else →
 * video freeze frame) from the file's **leading bytes**, never from its
 * name: a remote .seam's sources are `…/api/media/<id>/file?token=…` with no
 * extension at all, and a blob: URL has none either.
 */
export type StaticKind = "svg" | "raster" | "unknown";

/** How many leading bytes `sniffStaticKind` wants (an SVG may open with an
 *  XML prolog + DOCTYPE + comments before its `<svg` tag). */
export const SNIFF_BYTES = 1024;

const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  if (at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

const HEIF_BRANDS = ["avif", "avis", "heic", "heix", "hevc", "hevx", "mif1", "msf1"];

export function sniffStaticKind(head: Uint8Array): StaticKind {
  if (head.length >= 4 && head[0] === 0x89 && ascii(head, 1, "PNG")) return "raster";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "raster";
  if (ascii(head, 0, "GIF8")) return "raster";
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) return "raster";
  if (ascii(head, 0, "BM")) return "raster";
  if (ascii(head, 0, "II*\0") || ascii(head, 0, "MM\0*")) return "raster";
  if (ascii(head, 4, "ftyp")) {
    // ISO-BMFF: a still-image brand is a raster, any other (mp4/mov) is video.
    const brand = String.fromCharCode(...head.subarray(8, 12));
    return HEIF_BRANDS.includes(brand) ? "raster" : "unknown";
  }
  if (looksLikeSvg(head)) return "svg";
  return "unknown";
}

function looksLikeSvg(head: Uint8Array): boolean {
  let i = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3; // UTF-8 BOM
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x0a || head[i] === 0x0d || head[i] === 0x09)) i++;
  if (head[i] !== 0x3c /* < */) return false;
  // Any XML-ish document whose head mentions an <svg root.
  const text = String.fromCharCode(...head.subarray(i, Math.min(head.length, i + SNIFF_BYTES)));
  return /<svg[\s>]/i.test(text);
}
