import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import {
  getViewDocument,
  timeOnEnter,
  translateTimeOnExit,
  type View,
} from "./views.js";
import { probeSourceDuration } from "./probeSource.js";

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
const ROOT_VIEW: View = { type: "root" };

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
  const [errors, setErrors] = useState<string[]>([]);
  const [isMobile, setIsMobile] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [view, setView] = useState<View>(ROOT_VIEW);
  const [initialTime, setInitialTime] = useState(0);

  // Resolve root (always based on real document). View timeline is derived.
  const rootTimeline = useMemo<ResolvedTimeline | null>(() => {
    try {
      return resolveDoc(document);
    } catch {
      return null;
    }
  }, [document]);

  const viewTimeline = useMemo<ResolvedTimeline | null>(() => {
    if (!rootTimeline) return null;
    if (view.type === "root") return rootTimeline;
    try {
      return resolveDoc(getViewDocument(document, view));
    } catch {
      return null;
    }
  }, [document, view, rootTimeline]);

  // Update errors when resolution fails
  useEffect(() => {
    try {
      resolveDoc(document);
      setErrors([]);
    } catch (err) {
      setErrors([String(err)]);
    }
  }, [document]);

  // Guard: if the clip we're viewing no longer exists, bounce to root
  useEffect(() => {
    if (view.type === "clip") {
      const target = document.children[view.rootIndex];
      if (!target || target.type !== "clip") {
        setView(ROOT_VIEW);
        setInitialTime(0);
      }
    }
  }, [document, view]);

  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;

  const handleSaveRef = useRef<() => void>(() => {});
  const handleSaveAsRef = useRef<() => void>(() => {});
  const loadDocumentRef = useRef<(doc: SeamFile, fp: string | null) => void>(
    () => {}
  );
  const openFromJsonRef = useRef<(json: string, fp: string) => void>(() => {});

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
      setView(ROOT_VIEW);
      setInitialTime(0);
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

  // ── View navigation ────────────────────────────────────────────

  const handleEnterClip = useCallback(
    async (rootIndex: number, currentParentTime: number) => {
      if (!rootTimeline) return;
      const target = document.children[rootIndex];
      if (!target || target.type !== "clip") return;
      const basePath = filePathRef.current
        ? dirname(filePathRef.current)
        : "";
      try {
        const sourceDuration = await probeSourceDuration(
          target.source,
          basePath
        );
        const initT = timeOnEnter(document, rootTimeline, rootIndex, currentParentTime);
        setInitialTime(initT);
        setView({ type: "clip", rootIndex, sourceDuration });
      } catch (err) {
        setErrors([String(err)]);
      }
    },
    [document, rootTimeline]
  );

  const handleExit = useCallback(
    (viewTime: number) => {
      if (!rootTimeline) return;
      const t = translateTimeOnExit(document, rootTimeline, view, viewTime);
      setInitialTime(t);
      setView(ROOT_VIEW);
    },
    [document, rootTimeline, view]
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

  handleSaveRef.current = handleSave;
  handleSaveAsRef.current = handleSaveAs;
  loadDocumentRef.current = loadDocument;
  openFromJsonRef.current = openFromJson;

  // ── Init + menu wiring ─────────────────────────────────────────

  useEffect(() => {
    window.seamApi.getMobileEmulation().then(setIsMobile);

    window.seamApi.getInitialFile().then((data) => {
      if (data) {
        openFromJsonRef.current(data.json, data.filePath);
      } else {
        loadDocumentRef.current(EMPTY_DOCUMENT, null);
      }
    });

    window.seamApi.onMenuNew(() => {
      loadDocumentRef.current({ type: "composition", children: [] }, null);
    });

    window.seamApi.onMenuOpen(async () => {
      const result = await window.seamApi.showOpenDialog();
      if (!result) return;
      if ("error" in result) {
        setErrors([result.error]);
        return;
      }
      openFromJsonRef.current(result.json, result.filePath);
    });

    window.seamApi.onMenuSave(() => handleSaveRef.current());
    window.seamApi.onMenuSaveAs(() => handleSaveAsRef.current());
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

  if (!viewTimeline) {
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

  // Remount Timeline on view change so initialTime takes effect
  const viewKey =
    view.type === "root" ? "root" : `clip-${view.rootIndex}`;

  return (
    <Timeline
      key={viewKey}
      timeline={viewTimeline}
      basePath={basePath}
      preserveTime
      initialTime={initialTime}
    >
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
        view={view}
        onExit={handleExit}
      />
      <TimelinePanel
        timeline={viewTimeline}
        document={document}
        filePath={filePath}
        isMobile={isMobile}
        selectedIndex={selectedIndex}
        onSelect={setSelectedIndex}
        onDocumentChange={updateDocument}
        view={view}
        onEnterClip={handleEnterClip}
        history={history}
      />
    </Timeline>
  );
}
