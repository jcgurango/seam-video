import React, { useState, useEffect, useCallback, useRef } from "react";
import { Timeline } from "@seam/preview";
import {
  parseSeamFile,
  resolveComposition,
  resolveSpatial,
} from "@seam/core";
import type { ResolvedTimeline, SeamFile } from "@seam/core";
import ControlsBar from "./ControlsBar.js";
import TimelinePanel from "./TimelinePanel.js";
import { dirname, relative, isAbsolute } from "./pathUtils.js";

declare global {
  interface Window {
    seamApi: {
      onMenuNew: (cb: () => void) => void;
      onMenuOpen: (cb: () => void) => void;
      onMenuSave: (cb: () => void) => void;
      onMenuSaveAs: (cb: () => void) => void;
      getInitialFile: () => Promise<{
        filePath: string;
        json: string;
      } | null>;
      writeFile: (
        filePath: string,
        json: string
      ) => Promise<{ success: boolean } | { error: string }>;
      showOpenDialog: () => Promise<
        { filePath: string; json: string } | { error: string } | null
      >;
      showSaveDialog: () => Promise<string | null>;
      setTitle: (title: string) => void;
      getMobileEmulation: () => Promise<boolean>;
      getPathForFile: (file: File) => string;
    };
  }
}

const EMPTY_DOCUMENT: SeamFile = { type: "composition", children: [] };

function toRelative(absPath: string, baseDir: string): string {
  const rel = relative(baseDir, absPath);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return absPath;
}

function remapSourcesToRelative(doc: SeamFile, baseDir: string): SeamFile {
  return {
    ...doc,
    children: doc.children.map((child) => {
      if (child.type === "clip" && isAbsolute(child.source)) {
        return { ...child, source: toRelative(child.source, baseDir) };
      }
      if (
        (child.type === "composition" || child.type === "overlay") &&
        child.children
      ) {
        return remapSourcesToRelative(
          child as unknown as SeamFile,
          baseDir
        ) as unknown as typeof child;
      }
      return child;
    }),
  };
}

function resolve(doc: SeamFile): ResolvedTimeline {
  const temporal = resolveComposition(doc);
  return resolveSpatial(temporal, 1920, 1080);
}

export default function App() {
  const [document, setDocument] = useState<SeamFile>(EMPTY_DOCUMENT);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<ResolvedTimeline | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [isMobile, setIsMobile] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  // Keep refs for menu callbacks
  const docRef = useRef(document);
  docRef.current = document;
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;

  const updateTitle = useCallback((fp: string | null) => {
    window.seamApi.setTitle(
      fp ? `Seam Editor — ${fp}` : "Seam Editor — Untitled"
    );
  }, []);

  const loadDocument = useCallback(
    (doc: SeamFile, fp: string | null) => {
      setDocument(doc);
      setFilePath(fp);
      setErrors([]);
      updateTitle(fp);
      try {
        setTimeline(resolve(doc));
      } catch (err) {
        setErrors([String(err)]);
      }
    },
    [updateTitle]
  );

  const openFromJson = useCallback(
    (json: string, fp: string) => {
      const result = parseSeamFile(json);
      if (result.success) {
        loadDocument(result.data, fp);
      } else {
        setErrors(result.errors);
      }
    },
    [loadDocument]
  );

  // Resolve whenever document changes
  const updateDocument = useCallback((doc: SeamFile) => {
    setDocument(doc);
    setSelectedIndex(null);
    try {
      setTimeline(resolve(doc));
      setErrors([]);
    } catch (err) {
      setErrors([String(err)]);
    }
  }, []);

  // ── Save helpers ────────────────────────────────────────────────

  const saveToFile = useCallback(
    async (fp: string) => {
      const doc = remapSourcesToRelative(docRef.current, dirname(fp));
      setDocument(doc);
      const json = JSON.stringify(doc, null, 2);
      await window.seamApi.writeFile(fp, json);
      setFilePath(fp);
      updateTitle(fp);
      // Re-resolve with remapped paths
      try {
        setTimeline(resolve(doc));
      } catch (err) {
        setErrors([String(err)]);
      }
    },
    [updateTitle]
  );

  const handleSave = useCallback(async () => {
    if (filePathRef.current) {
      await saveToFile(filePathRef.current);
    } else {
      const fp = await window.seamApi.showSaveDialog();
      if (fp) await saveToFile(fp);
    }
  }, [saveToFile]);

  const handleSaveAs = useCallback(async () => {
    const fp = await window.seamApi.showSaveDialog();
    if (fp) await saveToFile(fp);
  }, [saveToFile]);

  // ── Init + menu wiring ─────────────────────────────────────────

  useEffect(() => {
    window.seamApi.getMobileEmulation().then(setIsMobile);

    window.seamApi.getInitialFile().then((data) => {
      if (data) {
        openFromJson(data.json, data.filePath);
      } else {
        loadDocument(EMPTY_DOCUMENT, null);
      }
    });

    window.seamApi.onMenuNew(() => {
      loadDocument({ type: "composition", children: [] }, null);
    });

    window.seamApi.onMenuOpen(async () => {
      const result = await window.seamApi.showOpenDialog();
      if (!result) return;
      if ("error" in result) {
        setErrors([result.error]);
        return;
      }
      openFromJson(result.json, result.filePath);
    });

    window.seamApi.onMenuSave(() => {
      handleSave();
    });

    window.seamApi.onMenuSaveAs(() => {
      handleSaveAs();
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const basePath = filePath ? dirname(filePath) : "";

  if (errors.length > 0) {
    return (
      <div style={{ padding: 20, color: "#ff6b6b", fontFamily: "monospace" }}>
        <h2>Validation Errors</h2>
        <ul>
          {errors.map((err, i) => (
            <li key={i}>{err}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (!timeline) {
    return (
      <div
        style={{
          padding: 20,
          color: "#999",
          fontFamily: "sans-serif",
          textAlign: "center",
          marginTop: 100,
        }}
      >
        Loading...
      </div>
    );
  }

  return (
    <Timeline timeline={timeline} basePath={basePath} preserveTime>
      <ControlsBar
        document={document}
        filePath={filePath}
        selectedIndex={selectedIndex}
        onSelect={setSelectedIndex}
        onDocumentChange={updateDocument}
      />
      <TimelinePanel
        timeline={timeline}
        document={document}
        filePath={filePath}
        isMobile={isMobile}
        selectedIndex={selectedIndex}
        onSelect={setSelectedIndex}
        onDocumentChange={updateDocument}
      />
    </Timeline>
  );
}
