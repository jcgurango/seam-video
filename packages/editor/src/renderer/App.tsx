import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Timeline, VideoCanvas } from "@seam/preview";
import {
  parseSeamFile,
  resolveComposition,
  resolveSpatial,
  validate as validateSeamFile,
} from "@seam/core";
import type { Child, ResolvedTimeline, SeamFile } from "@seam/core";
import ControlsBar from "./ControlsBar.js";
import TimelinePanel from "./TimelinePanel.js";
import InspectorTabs from "./InspectorTabs.js";
import ProjectPicker from "./ProjectPicker.js";
import ProjectBrowser from "./ProjectBrowser.js";
import WebTopBar from "./WebTopBar.js";
import SettingsDialog from "./SettingsDialog.js";
import { useSettings } from "./useSettings.js";
import { useTranscribe } from "./useTranscribe.js";
import TranscribeProgressOverlay from "./TranscribeProgressOverlay.js";
import ExportProgressOverlay from "./ExportProgressOverlay.js";
import {
  editTarget as scriptEditTarget,
  findScript,
  safeWithUpdatedOriginal,
} from "./nodeScript.js";
import type { Composition } from "@seam/core";
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
  const walk = (child: import("@seam/core").Child): import("@seam/core").Child => {
    if (
      (child.type === "clip" || child.type === "audio") &&
      isAbsolute(child.source)
    ) {
      return { ...child, source: toRelative(child.source, baseDir) };
    }
    if (child.type === "composition") {
      return {
        ...child,
        children: child.children.map(walk),
        ...(child.attachments
          ? { attachments: child.attachments.map(walk) }
          : {}),
      };
    }
    return child;
  };
  return {
    ...doc,
    children: doc.children.map(walk),
    ...(doc.attachments ? { attachments: doc.attachments.map(walk) } : {}),
  };
}

function collectClipSources(doc: SeamFile, out: string[] = []): string[] {
  const visit = (child: import("@seam/core").Child) => {
    if (child.type === "clip" || child.type === "audio") {
      out.push(child.source);
    } else if (child.type === "composition") {
      child.children.forEach(visit);
      if (child.attachments) child.attachments.forEach(visit);
    }
  };
  doc.children.forEach(visit);
  if (doc.attachments) doc.attachments.forEach(visit);
  return out;
}

function resolveDoc(doc: SeamFile): ResolvedTimeline {
  const temporal = resolveComposition(doc);
  return resolveSpatial(temporal, doc.contentWidth ?? 1080, doc.contentHeight ?? 1920);
}

function SelectionBar({
  count,
  onDeselect,
}: {
  count: number;
  onDeselect: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 16px",
        background: "#2a2a2a",
        borderTop: "1px solid #333",
        color: "#ddd",
        fontSize: 13,
      }}
    >
      <span>
        {count} {count === 1 ? "item" : "items"} selected
      </span>
      <button
        onClick={onDeselect}
        style={{
          background: "none",
          border: "1px solid #555",
          color: "#fff",
          borderRadius: 4,
          padding: "6px 12px",
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        Deselect all
      </button>
    </div>
  );
}

export default function App({ platform }: AppProps) {
  // Drop pushes that don't change the document JSON. Mutations
  // (timeline drags, script re-runs, JSON saves that round-trip to the
  // same shape) otherwise hand back a fresh reference, which would
  // re-memoize playerTimeline, fire <Timeline>'s setTimeline effect,
  // re-prime media, and steal Monaco's cursor focus.
  const history = useHistory<SeamFile>(EMPTY_DOCUMENT, {
    isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  const document = history.current;
  // Editor-surface root: when the root composition has a node-script
  // attached, this is the pre-script `original` so the timeline panel,
  // selection, JSON tab, etc. all operate on the source-of-truth shape.
  // The on-disk `document` retains the rendered body + script attachment.
  const editorDoc = useMemo<SeamFile>(
    () => scriptEditTarget(document) as SeamFile,
    [document]
  );

  const [filePath, setFilePath] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [isMobile, setIsMobile] = useState(false);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [view, setView] = useState<View>(ROOT_VIEW);
  const [initialTime, setInitialTime] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saveAsPromptOpen, setSaveAsPromptOpen] = useState(false);
  // On web we start on the project browser; a project must be picked/created
  // before the editor is shown. On Electron we always show the editor.
  const [showBrowser, setShowBrowser] = useState(platform.kind === "web");
  const [exportProgress, setExportProgress] =
    useState<ExportProgress | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { settings, updateSettings, resetSettings } = useSettings();

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

  // The view's effective document (i.e. what the timeline panel shows).
  // For root it's the editor-surface document; for nested views it's the
  // subtree being drilled into. `getViewDocument` operates on the editor
  // surface so nested compositions with their own scripts get the same
  // unwrap treatment automatically.
  const viewDocument = useMemo<SeamFile>(() => {
    const base =
      view.type === "root" ? editorDoc : getViewDocument(editorDoc, view);
    return scriptEditTarget(base) as SeamFile;
  }, [editorDoc, view]);

  // Two distinct resolved timelines:
  //   - `editorTimeline` is what the timeline panel renders (and what the
  //     inspector reads). It comes from the editor surface (= `original`
  //     when a script is attached), so the blocks the user sees match
  //     the source-of-truth shape they can actually edit.
  //   - `playerTimeline` is what the preview canvas plays. It comes from
  //     the on-disk document (post-script rendered body), so the user
  //     sees what'll actually export.
  //
  // Both axes share the playhead clock, so scrubbing the panel moves the
  // preview. If a script changes the doc's duration the two won't line
  // up perfectly — that's a known trade-off of using scripts.
  const editorTimeline = useMemo<ResolvedTimeline | null>(() => {
    try {
      return resolveDoc(viewDocument);
    } catch {
      return null;
    }
  }, [viewDocument]);

  const playerTimeline = useMemo<ResolvedTimeline | null>(() => {
    if (!rootTimeline) return null;
    if (view.type === "root") return rootTimeline;
    try {
      return resolveDoc(getViewDocument(document, view));
    } catch {
      return null;
    }
  }, [view, rootTimeline, document]);

  useEffect(() => {
    try {
      resolveDoc(document);
      setErrors([]);
    } catch (err) {
      setErrors([String(err)]);
    }
  }, [document]);

  // Guard: if the child we're viewing no longer exists (or changed type),
  // bounce to root.
  useEffect(() => {
    if (view.type === "clip") {
      const target = document.children[view.rootIndex];
      if (!target || target.type !== "clip") {
        setView(ROOT_VIEW);
        setInitialTime(0);
      }
    } else if (view.type === "composition") {
      const target = document.children[view.rootIndex];
      if (!target || target.type !== "composition") {
        setView(ROOT_VIEW);
        setInitialTime(0);
      }
    }
  }, [document, view]);

  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;

  const handleSaveRef = useRef<() => void>(() => { });
  const handleSaveAsRef = useRef<() => void>(() => { });
  const loadDocumentRef = useRef<
    (doc: SeamFile, fp: string | null) => Promise<void>
  >(async () => { });
  const openFromJsonRef = useRef<(json: string, fp: string) => Promise<void>>(
    async () => { }
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
      setSelectedIndices([]);
      setMultiSelectMode(false);
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

  // Track the most recent script execution error so the Script tab can
  // surface it. Mutations that bump `original` always succeed at the
  // doc-state level (we keep the last-good rendered body); only the
  // script's last-run status is reflected here.
  const [scriptError, setScriptError] = useState<string | null>(null);

  const updateDocument = useCallback(
    (surfaceDoc: SeamFile) => {
      // The incoming doc is the *editor surface*. If the on-disk root
      // has a script attached, re-run it against this new `original` and
      // store the rendered body alongside the bumped script payload.
      const { comp, error } = safeWithUpdatedOriginal(
        document as Composition,
        surfaceDoc as Composition
      );
      setScriptError(error);
      history.push(comp as SeamFile);
      setSelectedIndices([]);
      setMultiSelectMode(false);
    },
    [history, document]
  );

  // The "node" the JSON tab is editing — the root editor-surface doc at
  // root view, otherwise the child being drilled into. Compositions get
  // an extra script-edit-target unwrap so nested scripts also surface
  // their `original` instead of the rendered body.
  const jsonNode = useMemo<unknown>(() => {
    let node: unknown =
      view.type === "root" ? editorDoc : editorDoc.children[view.rootIndex];
    if (
      node &&
      typeof node === "object" &&
      (node as { type?: string }).type === "composition"
    ) {
      node = scriptEditTarget(node as Composition);
    }
    return node;
  }, [editorDoc, view]);

  // Translate the current selection into a JSON path inside `jsonNode`.
  // Selection indices are encoded as: [0, children.length) → child,
  // [children.length, total) → attachment. In clip view the JSON node is the
  // clip itself (no children/attachments), so jumping doesn't apply.
  const jsonJumpPath = useMemo<string | null>(() => {
    if (selectedIndices.length !== 1) return null;
    if (view.type === "clip") return null;
    const idx = selectedIndices[0];
    const childCount = viewDocument.children.length;
    if (idx < childCount) return `children.${idx}`;
    return `attachments.${idx - childCount}`;
  }, [selectedIndices, view, viewDocument]);

  // The composition the Script tab targets. Root view → on-disk root
  // composition (so the Script tab sees the existing wrapper, if any).
  // Composition view → the targeted child. Clip view → null (panel is
  // disabled).
  const scriptComposition = useMemo<Composition | null>(() => {
    if (view.type === "root") return document as Composition;
    if (view.type === "composition") {
      const target = document.children[view.rootIndex];
      return target?.type === "composition" ? (target as Composition) : null;
    }
    return null;
  }, [document, view]);

  const handleScriptApply = useCallback(
    (next: Composition): string[] | null => {
      // Splice the new composition back into the on-disk document at the
      // current view's position. We push directly (bypassing the root
      // script re-wrap path of `updateDocument`) because enable/disable
      // and scriptSrc edits already manage the script attachment shape
      // for us — re-wrapping here would double-apply.
      let newDoc: SeamFile;
      if (view.type === "root") {
        newDoc = next as SeamFile;
      } else if (view.type === "composition") {
        const idx = view.rootIndex;
        const newChildren = document.children.slice();
        newChildren[idx] = next;
        newDoc = { ...document, children: newChildren };
      } else {
        return ["Scripts can only be attached to compositions."];
      }
      try {
        resolveDoc(newDoc);
      } catch (err) {
        return [String(err)];
      }
      // Reset script-error UI: this apply call already validated.
      setScriptError(null);
      history.push(newDoc);
      setSelectedIndices([]);
      setMultiSelectMode(false);
      return null;
    },
    [document, view, history]
  );

  const handleJsonNodeSave = useCallback(
    (next: unknown): string[] | null => {
      // Build the proposed editor-surface document. JSON edits target the
      // editor surface (which is `editorDoc` — script-unwrapped), so we
      // splice into editorDoc rather than the on-disk document.
      let proposedSurface: unknown;
      if (view.type === "root") {
        proposedSurface = next;
      } else {
        const idx = view.rootIndex;
        if (!editorDoc.children[idx]) {
          return ["View target no longer exists in the document."];
        }
        const newChildren = editorDoc.children.slice();
        newChildren[idx] = next as Child;
        proposedSurface = { ...editorDoc, children: newChildren };
      }

      const result = validateSeamFile(proposedSurface);
      if (!result.success) return result.errors;

      // Re-wrap through the root script (no-op if the document has none).
      // safeWithUpdatedOriginal preserves the rendered body on script
      // errors, so we still need to validate the resolver runs against
      // the final compiled form before pushing.
      const wrapped = safeWithUpdatedOriginal(
        document as Composition,
        result.data as Composition
      );
      try {
        resolveDoc(wrapped.comp as SeamFile);
      } catch (err) {
        return [String(err)];
      }

      setScriptError(wrapped.error);
      history.push(wrapped.comp as SeamFile);
      setSelectedIndices([]);
      setMultiSelectMode(false);
      return null;
    },
    [document, editorDoc, view, history]
  );

  const onSelectionChange = useCallback((next: number[]) => {
    setSelectedIndices(next);
    if (next.length === 0) setMultiSelectMode(false);
  }, []);

  const onMultiSelectStart = useCallback((index: number) => {
    setMultiSelectMode(true);
    setSelectedIndices((prev) =>
      prev.includes(index) ? prev : [...prev, index]
    );
  }, []);

  // ── View navigation ────────────────────────────────────────────

  const handleEnterChild = useCallback(
    async (rootIndex: number, currentParentTime: number) => {
      if (!rootTimeline) return;
      const target = document.children[rootIndex];
      if (!target) return;

      if (target.type === "clip") {
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
        return;
      }

      if (target.type === "composition") {
        const initT = timeOnEnter(
          document,
          rootTimeline,
          rootIndex,
          currentParentTime
        );
        setInitialTime(initT);
        setView({ type: "composition", rootIndex });
      }
      // Other types (empty, ref) aren't enterable yet.
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
    if (prev != null) {
      setSelectedIndices([]);
      setMultiSelectMode(false);
    }
  }, [history]);

  const handleRedo = useCallback(() => {
    const next = history.redo();
    if (next != null) {
      setSelectedIndices([]);
      setMultiSelectMode(false);
    }
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
    platform.onAction("settings", () => setSettingsOpen(true));
  }, [platform]); // eslint-disable-line react-hooks/exhaustive-deps

  const basePath = filePath ? dirname(filePath) : "";

  // Transcription job: feeds the generator server one clip at a time and
  // appends a `data` attachment per response. Disabled in clip view (the
  // hook reports an error if you try anyway).
  const transcriber = useTranscribe({
    serverUrl: settings.generatorServerUrl,
    platform,
    basePath,
    history,
  });

  useEffect(() => {
    if (transcriber.errors.length > 0) {
      setErrors(transcriber.errors);
    }
  }, [transcriber.errors]);

  const handleTranscribe = useCallback(() => {
    void transcriber.run(document, view, selectedIndices);
  }, [transcriber, document, view, selectedIndices]);

  const viewKey =
    view.type === "root" ? "root" : `${view.type}-${view.rootIndex}`;

  // Selection bar: desktop shows when 2+ selected; mobile shows throughout
  // the explicit multi-select mode (started by a long-press).
  const showSelectionBar = isMobile
    ? multiSelectMode
    : selectedIndices.length >= 2;

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

    if (!playerTimeline || !editorTimeline) {
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
        timeline={playerTimeline}
        basePath={basePath}
        preserveTime
        initialTime={initialTime}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            height: "100%",
            background: "#1a1a1a",
            color: "#fff",
            fontFamily: "sans-serif",
            minHeight: 0,
          }}
        >
          <div style={{ height: '65vh', display: 'flex', flexDirection: 'row' }}>
            <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
              <InspectorTabs
                timeline={editorTimeline}
                viewDocument={viewDocument}
                jsonNode={jsonNode}
                onJsonNodeSave={handleJsonNodeSave}
                jsonJumpPath={jsonJumpPath}
                scriptComposition={scriptComposition}
                scriptError={scriptError}
                onScriptApply={handleScriptApply}
              />
            </div>
            <div style={{ flex: 1, display: 'flex' }}>
              <VideoCanvas width={playerTimeline.contentWidth} height={playerTimeline.contentHeight} />
            </div>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <ControlsBar
              document={editorDoc}
              filePath={filePath}
              selectedIndices={selectedIndices}
              onSelectionChange={onSelectionChange}
              onDocumentChange={updateDocument}
              onUndo={handleUndo}
              onRedo={handleRedo}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              view={view}
              onExit={handleExit}
              onEnterClip={handleEnterChild}
              platform={platform}
              onTranscribe={handleTranscribe}
              transcribing={transcriber.progress != null}
            />
            <TimelinePanel
              timeline={editorTimeline}
              document={editorDoc}
              viewDocument={viewDocument}
              filePath={filePath}
              isMobile={isMobile}
              selectedIndices={selectedIndices}
              onSelectionChange={onSelectionChange}
              multiSelectMode={multiSelectMode}
              onMultiSelectStart={onMultiSelectStart}
              onDocumentChange={updateDocument}
              view={view}
              onEnterClip={handleEnterChild}
              history={history}
              platform={platform}
            />
            {showSelectionBar && (
              <SelectionBar
                count={selectedIndices.length}
                onDeselect={() => onSelectionChange([])}
              />
            )}
          </div>
        </div>
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
          onSettings={() => setSettingsOpen(true)}
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

      {transcriber.progress && (
        <TranscribeProgressOverlay
          progress={transcriber.progress}
          onCancel={transcriber.cancel}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onSave={updateSettings}
        onReset={resetSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
