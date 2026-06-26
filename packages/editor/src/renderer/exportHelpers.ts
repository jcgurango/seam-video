import { compileSeamFile } from "@seam/core";
import type { SeamFile, Child } from "@seam/core";
import { basename, isAbsolute, relative } from "./pathUtils.js";
import { isMediaSource } from "./mediaSource.js";
import { mapGraphicImageSources } from "./graphicSources.js";

type Obj = Record<string, unknown>;

export interface ExportPlan {
  /** Rewritten document: media-source fields are flat basenames. */
  document: SeamFile;
  /**
   * Map from the *original* source (as it appeared in the input document)
   * to the name it should have inside the exported zip. Unique.
   */
  entries: Array<{ originalSource: string; exportName: string }>;
}

/**
 * Walk the document and flatten every media-source field to a basename
 * suitable for a flat zip, renaming on basename collisions.
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

  const rewriteChild = (child: Child): Child => {
    if (isMediaSource(child)) {
      return { ...child, source: pickExportName(child.source) };
    }
    if (child.type === "graphic") {
      return mapGraphicImageSources(child as Obj, pickExportName) as Child;
    }
    if (child.type === "composition") {
      return {
        ...child,
        ...(child.children ? { children: rewriteChildren(child.children) } : {}),
        ...(child.attachments
          ? { attachments: rewriteChildren(child.attachments) }
          : {}),
      };
    }
    return child;
  };

  const rewriteChildren = (children: Child[]): Child[] => children.map(rewriteChild);

  const document: SeamFile = {
    ...doc,
    ...(doc.children ? { children: rewriteChildren(doc.children) } : {}),
    ...(doc.attachments ? { attachments: rewriteChildren(doc.attachments) } : {}),
  };

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

  const walk = (child: Child): Child => {
    if (isMediaSource(child) && isAbsolute(child.source)) {
      return { ...child, source: toRelative(child.source) };
    }
    if (child.type === "graphic") {
      return mapGraphicImageSources(child as Obj, (src) =>
        isAbsolute(src) ? toRelative(src) : src,
      ) as Child;
    }
    if (child.type === "composition") {
      return {
        ...child,
        ...(child.children ? { children: child.children.map(walk) } : {}),
        ...(child.attachments ? { attachments: child.attachments.map(walk) } : {}),
      };
    }
    return child;
  };
  return {
    ...doc,
    ...(doc.children ? { children: doc.children.map(walk) } : {}),
    ...(doc.attachments ? { attachments: doc.attachments.map(walk) } : {}),
  };
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

  const visit = (child: Child) => {
    if (isMediaSource(child)) {
      out.push(child.source);
    } else if (child.type === "graphic") {
      // Graphic Image `src`s are file-backed media too — collect them (for
      // blob-URL preload / export bundling) without altering the node.
      mapGraphicImageSources(child as Obj, (src) => {
        out.push(src);
        return src;
      });
    } else if (child.type === "composition") {
      child.children?.forEach(visit);
      if (child.attachments) child.attachments.forEach(visit);
    }
  };
  resolved.children?.forEach(visit);
  if (resolved.attachments) resolved.attachments.forEach(visit);
  return out;
}
