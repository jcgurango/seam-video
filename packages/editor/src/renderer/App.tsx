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
import { useHistory } from "./useHistory.js";

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

function resolveDoc(doc: SeamFile): ResolvedTimeline {
  const temporal = resolveComposition(doc);
  return resolveSpatial(temporal, 1920, 1080);
}

export default function App() {
  const history = useHistory<SeamFile>(EMPTY_DOCUMENT);
  const document = history.current;

  const [filePath, setFilePath] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<ResolvedTimeline | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [isMobile, setIsMobile] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;

  // Re-resolve whenever document changes
  useEffect(() => {
    try {
      setTimeline(resolveDoc(document));
      setErrors([]);
    } catch (err) {
      setErrors([String(err)]);
    }
  }, [document]);

  const updateTitle = useCallback((fp: string | null) => {
    window.seamApi.setTitle(
      fp ? `Seam Editor — ${fp}` : "Seam Editor — Untitled"
    );
  }, []);

  const loadDocument = useCallback(
    (doc: SeamFile, fp: string | null) => {
      history.reset(doc);
      setFilePath(fp);
      setErrors([]);
      setSelectedIndex(null);
      updateTitle(fp);
    },
    [history, updateTitle]
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

  const updateDocument = useCallback(
    (doc: SeamFile) => {
      history.push(doc);
      setSelectedIndex(null);
    },
    [history]
  );

  // ── Undo / Redo ────────────────────────────────────────────────

  const handleUndo = useCallback(() => {
    const prev = history.undo();
    if (prev != null) setSelectedIndex(null);
  }, [history]);

  const handleRedo = useCallback(() => {
    const next = history.redo();
    if (next != null) setSelectedIndex(null);
  }, [history]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (mod && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        handleRedo();
      } else if (mod && e.key === "y") {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleUndo, handleRedo]);

  // ── Save helpers ────────────────────────────────────────────────

  const saveToFile = useCallback(
    async (fp: string) => {
      const doc = remapSourcesToRelative(history.current, dirname(fp));
      history.replace(doc);
      const json = JSON.stringify(doc, null, 2);
      await window.seamApi.writeFile(fp, json);
      setFilePath(fp);
      updateTitle(fp);
    },
    [history, updateTitle]
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
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
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
