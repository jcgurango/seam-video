import type { SeamFile, Child } from "@seam/core";

/** Basename (last segment of a path). Works for both / and \ separators. */
export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}

export interface ExportPlan {
  /** Rewritten document: clip.source fields are flat basenames. */
  document: SeamFile;
  /**
   * Map from the *original* source (as it appeared in the input document)
   * to the name it should have inside the exported zip. Unique.
   */
  entries: Array<{ originalSource: string; exportName: string }>;
}

/**
 * Walk the document and flatten every clip.source to a basename suitable for
 * a flat zip, renaming on basename collisions.
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

  const rewriteChildren = (children: Child[]): Child[] =>
    children.map((child) => {
      if (child.type === "clip") {
        return { ...child, source: pickExportName(child.source) };
      }
      if (child.type === "composition" || child.type === "overlay") {
        return {
          ...child,
          children: rewriteChildren(child.children),
        } as typeof child;
      }
      return child;
    });

  const document: SeamFile = {
    ...doc,
    children: rewriteChildren(doc.children),
  };

  const entries: Array<{ originalSource: string; exportName: string }> = [];
  for (const [originalSource, exportName] of sourceToExport) {
    entries.push({ originalSource, exportName });
  }

  return { document, entries };
}
