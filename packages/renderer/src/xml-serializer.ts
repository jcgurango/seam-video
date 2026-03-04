import type { MltDocument } from "./mlt-builder.js";
import { isEntry, isBlank } from "./mlt-builder.js";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function serializeToXml(doc: MltDocument): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push(`<mlt>`);
  lines.push(`  <profile frame_rate_num="${doc.fps}" frame_rate_den="1" width="${doc.width}" height="${doc.height}" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${doc.width}" display_aspect_den="${doc.height}" progressive="1" />`);

  for (const producer of doc.producers) {
    lines.push(`  <producer id="${escapeXml(producer.id)}">`);
    lines.push(`    <property name="resource">${escapeXml(producer.resource)}</property>`);
    lines.push(`  </producer>`);
  }

  lines.push(`  <playlist id="playlist0">`);
  for (const item of doc.playlist) {
    if (isEntry(item)) {
      lines.push(`    <entry producer="${escapeXml(item.producer)}" in="${item.inFrame}" out="${item.outFrame}" />`);
    } else if (isBlank(item)) {
      lines.push(`    <blank length="${item.length}" />`);
    }
  }
  lines.push(`  </playlist>`);

  lines.push(`  <tractor id="tractor0" out="${doc.totalFrames - 1}">`);
  lines.push(`    <track producer="playlist0" />`);
  lines.push(`  </tractor>`);

  lines.push(`</mlt>`);
  return lines.join("\n") + "\n";
}
