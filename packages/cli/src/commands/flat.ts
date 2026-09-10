import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compileSeamFile,
  flattenResolved,
  parseSeamFile,
  resolveComposition,
} from "@seam/core";

export interface FlatOptions {
  output?: string;
  pretty?: boolean;
}

interface FlatSourceEntry {
  type: "clip" | "audio" | "static";
  source: string;
  in: number;
  out: number;
  start: number;
  end: number;
}

export async function flatCommand(file: string, options: FlatOptions) {
  const filePath = resolve(file);

  const json = readFileSync(filePath, "utf-8");
  const result = parseSeamFile(json);
  if (!result.success) {
    console.error("Validation errors:");
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const { doc: compiled, errors: compileErrors } = compileSeamFile(result.data);
  if (compileErrors.length > 0) {
    console.error("Compile errors:");
    for (const err of compileErrors) {
      console.error(`  - ${err.source}: ${err.message}`);
    }
    process.exit(1);
  }

  const timeline = resolveComposition(compiled);
  const leaves = flattenResolved(timeline.children);

  const entries: FlatSourceEntry[] = [];
  for (const leaf of leaves) {
    if (leaf.type === "clip" || leaf.type === "audio") {
      entries.push({
        type: leaf.type,
        source: leaf.source,
        in: leaf.sourceIn,
        out: leaf.sourceOut,
        start: leaf.timelineStart,
        end: leaf.timelineEnd,
      });
    } else if (leaf.type === "static") {
      // Static has no trim window — the frozen frame time stands in for both.
      entries.push({
        type: "static",
        source: leaf.source,
        in: leaf.sourceTime,
        out: leaf.sourceTime,
        start: leaf.timelineStart,
        end: leaf.timelineEnd,
      });
    }
  }

  // Attachments resolve after all children, so restore chronological order.
  entries.sort((a, b) => a.start - b.start || a.end - b.end);

  const out = options.pretty !== false
    ? JSON.stringify(entries, null, 2)
    : JSON.stringify(entries);

  if (options.output) {
    writeFileSync(resolve(options.output), out);
  } else {
    process.stdout.write(out + "\n");
  }
}
