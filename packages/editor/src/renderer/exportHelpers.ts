import { compileSeamFile } from "@seam/core";
import type { SeamFile, Child, Composition } from "@seam/core";
import { basename, isAbsolute, relative } from "./pathUtils.js";
import { isMediaSource } from "./mediaSource.js";
import { mapGraphicImageSources } from "./graphicSources.js";

type Obj = Record<string, unknown>;

/**
 * Immutably map every media-source path in a document — clip/audio/static
 * `source` fields and graphic `Image` `src`s — through `fn`. Recurses
 * compositions' `children`, `attachments`, AND `bin` entry bodies (a clip
 * living only inside a bin entry is media too). The single walk behind
 * export planning, relative remapping, and import-time source rewriting.
 */
export function mapDocumentSources(
  doc: SeamFile,
  fn: (src: string) => string
): SeamFile {
  const walkChild = (child: Child): Child => {
    if (isMediaSource(child)) {
      return { ...child, source: fn(child.source) };
    }
    if (child.type === "graphic") {
      return mapGraphicImageSources(child as Obj, fn) as Child;
    }
    if (child.type === "composition") {
      return walkComp(child) as Child;
    }
    return child;
  };
  const walkComp = <T extends Composition>(comp: T): T => ({
    ...comp,
    ...(comp.children ? { children: comp.children.map(walkChild) } : {}),
    ...(comp.attachments ? { attachments: comp.attachments.map(walkChild) } : {}),
    ...(comp.bin
      ? {
          bin: comp.bin.map((entry) => ({
            ...entry,
            children: entry.children.map(walkChild),
            ...(entry.attachments
              ? { attachments: entry.attachments.map(walkChild) }
              : {}),
          })),
        }
      : {}),
  });
  return walkComp(doc);
}

export interface ExportPlan {
  /** Rewritten document: media-source fields are flat basenames. */
  document: SeamFile;
  /**
   * Map from the *original* source (as it appeared in the input document)
   * to the name it should have in the exported bundle. Unique.
   */
  entries: Array<{ originalSource: string; exportName: string }>;
}

/**
 * Walk the document and flatten every media-source field to a basename
 * suitable for a flat export folder, renaming on basename collisions.
 */
export function buildExportPlan(doc: SeamFile): ExportPlan {
  const sourceToExport = new Map<string, string>();
  const usedNames = new Set<string>();

  const pickExportName = (originalSource: string): string => {
    const existing = sourceToExport.get(originalSource);
    if (existing) return existing;

    const base = basename(originalSource);
    let candidate = base;
    if (usedNames.has(candidate)) {
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      let i = 1;
      while (usedNames.has(`${stem}-${i}${ext}`)) i++;
      candidate = `${stem}-${i}${ext}`;
    }
    usedNames.add(candidate);
    sourceToExport.set(originalSource, candidate);
    return candidate;
  };

  const document = mapDocumentSources(doc, pickExportName);

  const entries: Array<{ originalSource: string; exportName: string }> = [];
  for (const [originalSource, exportName] of sourceToExport) {
    entries.push({ originalSource, exportName });
  }

  return { document, entries };
}

/**
 * Rewrite absolute media-source paths to relative-to-baseDir paths.
 * Used by the Electron save flow so a saved .seam file refers to its
 * clips/etc. by paths relative to where the file lives. Compositions
 * recurse; non-media nodes pass through unchanged.
 */
export function remapSourcesToRelative(doc: SeamFile, baseDir: string): SeamFile {
  const toRelative = (absPath: string): string => {
    const rel = relative(baseDir, absPath);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
    return absPath;
  };

  return mapDocumentSources(doc, (src) =>
    isAbsolute(src) ? toRelative(src) : src
  );
}

/**
 * Walk the document and collect every media-source path. Compiles the
 * doc first so `binItem` references get spliced with their bin body —
 * otherwise clips that only appear inside a bin entry never reach the
 * walker. Compile failures fall back to the raw doc; whatever was
 * resolvable still carries through. Used by the web platform to warm
 * up its blob URL cache before mounting a document.
 */
export function collectClipSources(doc: SeamFile, out: string[] = []): string[] {
  let resolved: SeamFile;
  try {
    resolved = compileSeamFile(doc).doc;
  } catch {
    resolved = doc;
  }

  mapDocumentSources(resolved, (src) => {
    out.push(src);
    return src;
  });
  return out;
}
