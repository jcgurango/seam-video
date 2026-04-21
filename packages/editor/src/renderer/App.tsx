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
import ProjectPicker from "./ProjectPicker.js";
import ProjectBrowser from "./ProjectBrowser.js";
import WebTopBar from "./WebTopBar.js";
import ExportProgressOverlay from "./ExportProgressOverlay.js";
import type { ExportProgress } from "./platform/types.js";
import { dirname, relative, isAbsolute } from "./pathUtils.js";
import { useHistory } from "./useHistory.js";
import {
  getViewDocument,
  timeOnEnter,
  translateTimeOnExit,
  type View,
} from "./views.js";
import { probeSourceDuration } from "./probeSource.js";
import type { Platform } from "./platform/index.js";
import { WebPlatform } from "./platform/index.js";

interface AppProps {
  platform: Platform;
}

const EMPTY_DOCUMENT: SeamFile = { type: "composition", children: [] };
const ROOT_VIEW: View = { type: "root" };

function basenameWithoutExt(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const file = i < 0 ? p : p.slice(i + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

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

function collectClipSources(doc: SeamFile, out: string[] = []): string[] {
  for (const child of doc.children) {
    if (child.type === "clip") out.push(child.source);
    else if (
      (child.type === "composition" || child.type === "overlay") &&
      child.children
    ) {
      collectClipSources(child as unknown as SeamFile, out);
    }
  }
  return out;
}

function resolveDoc(doc: SeamFile): ResolvedTimeline {
  const temporal = resolveComposition(doc);
  return resolveSpatial(temporal, 1920, 1080);
}

export default function App({ platform }: AppProps) {
  const history = useHistory<SeamFile>(EMPTY_DOCUMENT);
  const document = history.current;

  const [filePath, setFilePath] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [isMobile, setIsMobile] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [view, setView] = useState<View>(ROOT_VIEW);
  const [initialTime, setInitialTime] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saveAsPromptOpen, setSaveAsPromptOpen] = useState(false);
  // On web we start on the project browser; a project must be picked/created
  // before the editor is shown. On Electron we always show the editor.
  const [showBrowser, setShowBrowser] = useState(platform.kind === "web");
  const [exportProgress, setExportProgress] =
    useState<ExportProgress | null>(null);

  // Web platform UI bridges (project picker / save-as prompt)
  const openPickerRef = useRef<
    ((result: { filePath: string; json: string } | null) => void) | null
  >(null);
  const savePromptRef = useRef<((path: string | null) => void) | null>(null);

  // Register UI bridges with the web platform
  useEffect(() => {
    if (platform.kind === "web") {
      const webPlatform = platform as WebPlatform;
      webPlatform.setOpenProjectHandler(
        () =>
          new Promise((resolve) => {
            openPickerRef.current = resolve;
            setPickerOpen(true);
          })
      );
      webPlatform.setPickSavePathHandler(
        () =>
          new Promise((resolve) => {
            savePromptRef.current = resolve;
            setSaveAsPromptOpen(true);
          })
      );
    }
  }, [platform]);

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
  const loadDocumentRef = useRef<
    (doc: SeamFile, fp: string | null) => Promise<void>
  >(async () => {});
  const openFromJsonRef = useRef<(json: string, fp: string) => Promise<void>>(
    async () => {}
  );

  const updateTitle = useCallback(
    (fp: string | null) => {
      platform.setTitle(
        fp ? `Seam Editor — ${fp}` : "Seam Editor — Untitled"
      );
    },
    [platform]
  );

  const loadDocument = useCallback(
    async (doc: SeamFile, fp: string | null) => {
      // On web, warm up the blob URL cache for every referenced clip *before*
      // we commit the document to state. Otherwise <Timeline>'s setTimeline
      // runs synchronously and resolveSource returns raw filenames → mediabunny
      // fetches the SPA fallback HTML and fails.
      if (platform.kind === "web") {
        const wp = platform as WebPlatform;
        wp.clearBlobUrlCache();
        await wp.preloadBlobUrls(collectClipSources(doc));
      }
      history.reset(doc);
      setFilePath(fp);
      setErrors([]);
      setSelectedIndex(null);
      setView(ROOT_VIEW);
      setInitialTime(0);
      updateTitle(fp);
    },
    [history, updateTitle, platform]
  );

  const openFromJson = useCallback(
    async (json: string, fp: string) => {
      const result = parseSeamFile(json);
      if (!result.success) {
        setErrors(result.errors);
        return;
      }
      await loadDocument(result.data, fp);
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
        const initT = timeOnEnter(
          document,
          rootTimeline,
          rootIndex,
          currentParentTime
        );
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
      let doc = history.current;
      // Electron: rewrite absolute paths to relative to the .seam file's dir
      if (platform.kind === "electron") {
        doc = remapSourcesToRelative(doc, dirname(fp));
        history.replace(doc);
      }
      const json = JSON.stringify(doc, null, 2);
      await platform.writeFile(fp, json);
      setFilePath(fp);
      updateTitle(fp);
    },
    [history, updateTitle, platform]
  );

  const handleSave = useCallback(async () => {
    if (filePathRef.current) {
      await saveToFile(filePathRef.current);
    } else {
      const fp = await platform.pickSavePath();
      if (fp) await saveToFile(fp);
    }
  }, [saveToFile, platform]);

  const handleSaveAs = useCallback(async () => {
    const fp = await platform.pickSavePath();
    if (fp) await saveToFile(fp);
  }, [saveToFile, platform]);

  const handleExport = useCallback(async () => {
    const fp = filePathRef.current;
    const defaultName = fp
      ? basenameWithoutExt(fp)
      : "untitled";
    const basePath = fp ? dirname(fp) : "";
    setExportProgress({ phase: "read", progress: 0 });
    try {
      await platform.exportProject(
        history.current,
        basePath,
        defaultName,
        (p) => setExportProgress(p)
      );
    } catch (err) {
      setErrors([String(err)]);
    } finally {
      setExportProgress(null);
    }
  }, [history, platform]);

  const handleImport = useCallback(
    async (file: File) => {
      if (!platform.importProject) return;
      try {
        const result = await platform.importProject(file);
        if (result) {
          openFromJsonRef.current(result.json, result.filePath);
          setShowBrowser(false);
        }
      } catch (err) {
        setErrors([String(err)]);
      }
    },
    [platform]
  );

  handleSaveRef.current = handleSave;
  handleSaveAsRef.current = handleSaveAs;
  loadDocumentRef.current = loadDocument;
  openFromJsonRef.current = openFromJson;

  // Export hooks: Electron's File menu + web Cmd+E shortcut
  useEffect(() => {
    const platformAny = platform as {
      onExportRequested?: (cb: () => void) => void;
      setExportHandler?: (cb: () => void) => void;
    };
    platformAny.onExportRequested?.(() => handleExport());
    platformAny.setExportHandler?.(() => handleExport());
  }, [platform, handleExport]);

  // ── Init + menu / action wiring ────────────────────────────────

  useEffect(() => {
    if (platform.isMobileLayout) {
      platform.isMobileLayout().then(setIsMobile);
    }

    platform.getInitial().then((data) => {
      if (data) {
        openFromJsonRef.current(data.json, data.filePath);
      } else {
        loadDocumentRef.current(EMPTY_DOCUMENT, null);
      }
    });

    platform.onAction("new", () => {
      loadDocumentRef.current({ type: "composition", children: [] }, null);
      setShowBrowser(false);
    });

    platform.onAction("open", async () => {
      const result = await platform.openProject();
      if (!result) return;
      if ("error" in result) {
        setErrors([result.error]);
        return;
      }
      openFromJsonRef.current(result.json, result.filePath);
      setShowBrowser(false);
    });

    platform.onAction("save", () => handleSaveRef.current());
    platform.onAction("save-as", () => handleSaveAsRef.current());
  }, [platform]); // eslint-disable-line react-hooks/exhaustive-deps

  const basePath = filePath ? dirname(filePath) : "";

  const viewKey =
    view.type === "root" ? "root" : `clip-${view.rootIndex}`;

  const handleOpenFromBrowser = useCallback(
    (fp: string, json: string) => {
      openFromJsonRef.current(json, fp);
      setShowBrowser(false);
    },
    []
  );

  const handleNewFromBrowser = useCallback(() => {
    loadDocumentRef.current({ type: "composition", children: [] }, null);
    setShowBrowser(false);
  }, []);

  // WebTopBar handlers that also exit the browser if we're in it
  const topBarNew = useCallback(() => {
    loadDocumentRef.current({ type: "composition", children: [] }, null);
    setShowBrowser(false);
  }, []);

  const topBarOpen = useCallback(async () => {
    const result = await platform.openProject();
    if (!result) return;
    if ("error" in result) {
      setErrors([result.error]);
      return;
    }
    openFromJsonRef.current(result.json, result.filePath);
    setShowBrowser(false);
  }, [platform]);

  const topBarBrowseProjects = useCallback(() => {
    setShowBrowser(true);
  }, []);

  const renderMain = () => {
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

    if (showBrowser && platform.kind === "web") {
      return (
        <ProjectBrowser
          platform={platform as WebPlatform}
          onOpen={handleOpenFromBrowser}
          onNew={handleNewFromBrowser}
        />
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
          platform={platform}
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
          platform={platform}
        />
      </Timeline>
    );
  };

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {platform.kind === "web" && (
        <WebTopBar
          onNew={topBarNew}
          onOpen={topBarOpen}
          onSave={handleSave}
          onSaveAs={handleSaveAs}
          onExport={handleExport}
          onImport={handleImport}
          onBrowseProjects={topBarBrowseProjects}
          canSave={!showBrowser}
        />
      )}

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {renderMain()}
      </div>

      {/* Web-only UI: project picker + save-as prompt */}
      {pickerOpen && platform.kind === "web" && (
        <ProjectPicker
          platform={platform as WebPlatform}
          mode="open"
          onClose={() => {
            setPickerOpen(false);
            openPickerRef.current?.(null);
            openPickerRef.current = null;
          }}
          onResolve={(result) => {
            setPickerOpen(false);
            openPickerRef.current?.(result);
            openPickerRef.current = null;
          }}
        />
      )}
      {saveAsPromptOpen && platform.kind === "web" && (
        <ProjectPicker
          platform={platform as WebPlatform}
          mode="save-as"
          onClose={() => {
            setSaveAsPromptOpen(false);
            savePromptRef.current?.(null);
            savePromptRef.current = null;
          }}
          onSavePath={(path) => {
            setSaveAsPromptOpen(false);
            savePromptRef.current?.(path);
            savePromptRef.current = null;
          }}
        />
      )}

      {exportProgress && <ExportProgressOverlay progress={exportProgress} />}
    </div>
  );
}
