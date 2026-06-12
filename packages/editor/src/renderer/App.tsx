import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Timeline, VideoCanvas } from "@seam/preview";
import {
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  parseSeamFile,
  resolveComposition,
  resolveSpatial,
  validate as validateSeamFile,
} from "@seam/core";
import type { Child, ResolvedTimeline, SeamFile } from "@seam/core";
import ControlsBar from "./ControlsBar.js";
import TimelinePanel from "./TimelinePanel.js";
import InspectorAccordion from "./InspectorAccordion.js";
import ProjectPicker from "./ProjectPicker.js";
import ProjectBrowser from "./ProjectBrowser.js";
import WebTopBar from "./WebTopBar.js";
import SettingsDialog from "./SettingsDialog.js";
import { useSettings } from "./useSettings.js";
import { useTranscribe } from "./useTranscribe.js";
import TranscribeProgressOverlay from "./TranscribeProgressOverlay.js";
import ExportProgressOverlay from "./ExportProgressOverlay.js";
import { compileDocument } from "./compile.js";
import { findBin } from "./nodeBin.js";
import CCCutView from "./CCCutView.js";
import {
  buildCCPreviewDoc,
  buildCCSpliceChildren,
  resolveCCWords,
  type CCSelection,
} from "./ccCutTool.js";
import { isTypingInEditableSurface } from "./keyboardGuards.js";
import type { Composition } from "@seam/core";
import type { ExportProgress } from "./platform/types.js";
import { basenameWithoutExt, dirname } from "./pathUtils.js";
import {
  collectClipSources,
  remapSourcesToRelative,
} from "./exportHelpers.js";
import { useHistory } from "./useHistory.js";
import { useEvent } from "./useEvent.js";
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

function resolveDoc(doc: SeamFile): ResolvedTimeline {
  const temporal = resolveComposition(doc);
  return resolveSpatial(
    temporal,
    doc.contentWidth ?? DEFAULT_CANVAS_WIDTH,
    doc.contentHeight ?? DEFAULT_CANVAS_HEIGHT,
  );
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

  const [filePath, setFilePath] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [view, setView] = useState<View>(ROOT_VIEW);
  const [initialTime, setInitialTime] = useState(0);
  // In-flight selections for the CC Cut view. Cleared on entry and on
  // OK/Cancel — lives on App because both the CC view (renders + edits)
  // and the toolbar (OK button) need to read them.
  const [ccSelections, setCcSelections] = useState<CCSelection[]>([]);
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

  // Track the most recent compile/script error so the Script tab can
  // surface it. Compile errors are collected (not thrown) so partial
  // failures still produce a usable preview.
  const [scriptError, setScriptError] = useState<string | null>(null);

  // Bin entry currently being CC-cut (null outside cc-cut view). The
  // resolved word ribbon + preview doc derive from this.
  const ccBinEntry = useMemo(() => {
    if (view.type !== "cc-cut") return null;
    const bin = findBin(document as Composition);
    return bin.find((e) => e.id === view.binId) ?? null;
  }, [view, document]);

  const ccWords = useMemo(() => {
    if (!ccBinEntry) return [];
    return resolveCCWords(ccBinEntry, document);
  }, [ccBinEntry, document]);

  // The view's effective document. Root view shows the whole doc;
  // composition/clip views drill into a sub-tree; CC-cut synthesises a
  // preview doc from the user's in-progress selections.
  const viewDocument = useMemo<SeamFile>(() => {
    if (view.type === "cc-cut") {
      if (!ccBinEntry) return document;
      return buildCCPreviewDoc(ccBinEntry, document, ccSelections);
    }
    return view.type === "root" ? document : getViewDocument(document, view);
  }, [view, ccBinEntry, document, ccSelections]);

  // Two resolved timelines per view:
  //   - playerTimeline: bins spliced + scripts run; what the canvas plays.
  //   - editorTimeline: bins spliced, scripts NOT run; what the
  //     timeline panel renders. Skipping scripts means the panel shows
  //     the user's authored body, so drag/trim/delete writes back to
  //     positions that match what the user sees. Running scripts would
  //     replace those authored children with the script's output and
  //     edits would map onto compiled nodes that don't exist in the
  //     authored doc.
  // `rootTimeline` is the playerTimeline of root view, hoisted because
  // view-navigation math (timeOnEnter / translateTimeOnExit) needs it
  // and because we use it to publish compile/resolve errors.
  const rootTimeline = useMemo<ResolvedTimeline | null>(() => {
    try {
      const { doc: compiled, errors: compileErrors } = compileDocument(document);
      setScriptError(
        compileErrors.length > 0
          ? compileErrors.map((e) => `${e.source}: ${e.message}`).join("\n")
          : null,
      );
      const resolved = resolveDoc(compiled);
      setErrors([]);
      return resolved;
    } catch (err) {
      console.error("[App] rootTimeline resolve failed:", err, { document });
      setErrors([String(err)]);
      return null;
    }
  }, [document]);

  const playerTimeline = useMemo<ResolvedTimeline | null>(() => {
    if (view.type === "root") return rootTimeline;
    try {
      const { doc: compiled } = compileDocument(viewDocument);
      return resolveDoc(compiled);
    } catch (err) {
      console.error("[App] playerTimeline resolve failed:", err, {
        viewDocument,
      });
      return null;
    }
  }, [view.type, viewDocument, rootTimeline]);

  const editorTimeline = useMemo<ResolvedTimeline | null>(() => {
    try {
      const { doc: panelCompiled } = compileDocument(viewDocument, {
        runScripts: false,
      });
      return resolveDoc(panelCompiled);
    } catch (err) {
      console.error("[App] editorTimeline resolve failed:", err, {
        viewDocument,
      });
      return null;
    }
  }, [viewDocument]);

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
    } else if (view.type === "cc-cut") {
      // Bounce out if the targeted bin entry has been deleted /
      // renamed out from under us.
      const bin = findBin(document as Composition);
      if (!bin.some((e) => e.id === view.binId)) {
        setView(ROOT_VIEW);
        setInitialTime(0);
        setCcSelections([]);
      }
    }
  }, [document, view]);

  const updateTitle = useCallback(
    (fp: string | null) => {
      platform.setTitle(
        fp ? `Seam Editor — ${fp}` : "Seam Editor — Untitled"
      );
    },
    [platform]
  );

  // `useEvent`: stable identity, latest closure. Lets the menu/action
  // wiring `useEffect` register once at mount without needing a ref
  // mirror for every callback it touches.
  const loadDocument = useEvent(async (doc: SeamFile, fp: string | null) => {
    // On web, warm up the blob URL cache for every referenced clip *before*
    // we commit the document to state. Otherwise <Timeline>'s setTimeline
    // runs synchronously and resolveSource returns raw filenames → mediabunny
    // fetches the SPA fallback HTML and fails.
    if (platform.kind === "web") {
      const wp = platform as WebPlatform;
      wp.clearBlobUrlCache();
      await wp.preloadBlobUrls(collectClipSources(doc));
    }
    // The authored doc is the source of truth — bin references and
    // script outputs are resolved at compile time by the preview /
    // render pipeline, not stored back into the doc.
    history.reset(doc);
    setFilePath(fp);
    setErrors([]);
    setSelectedIndices([]);
    setView(ROOT_VIEW);
    setInitialTime(0);
    updateTitle(fp);
  });

  const openFromJson = useEvent(async (json: string, fp: string) => {
    const result = parseSeamFile(json);
    if (!result.success) {
      setErrors(result.errors);
      return;
    }
    await loadDocument(result.data, fp);
  });

  const updateDocument = useCallback(
    (newDoc: SeamFile) => {
      // No more script-original / rendered-body bookkeeping — the
      // authored doc is the canonical state and the compile pass runs
      // lazily in rootTimeline. Any compile errors get reported there.
      history.push(newDoc);
      setSelectedIndices([]);
    },
    [history]
  );

  // The JSON tab shows the authored doc directly — there's no rendered
  // shadow to hide. Bin references appear as compositions with a
  // `binItem` field (and whatever children/attachments the user has
  // authored, typically none). Scripts appear as a `script` string.
  const jsonNode = useMemo<unknown>(() => {
    if (view.type === "clip" || view.type === "composition") {
      return document.children[view.rootIndex];
    }
    return document;
  }, [document, view]);

  // Translate the current selection into a JSON path inside `jsonNode`.
  // Selection indices are encoded as: [0, children.length) → child,
  // [children.length, total) → attachment. In clip view the JSON node is the
  // clip itself (no children/attachments), so jumping doesn't apply.
  //
  // When the displayed node has a script attached, the timeline renders
  // the script's `original.children` (via the editor-surface unwrap),
  // so the visible JSON puts those at
  // Translate the current selection into a JSON path inside the JSON
  // tab's view. Selection indices encode [0, children.length) → child,
  // [children.length, total) → attachment. With no rendered-shadow
  // wrap, the path maps directly onto the authored doc's fields.
  const jsonJumpPath = useMemo<string | null>(() => {
    if (selectedIndices.length !== 1) return null;
    if (view.type === "clip") return null;
    const idx = selectedIndices[0];
    const childCount = viewDocument.children.length;
    return idx < childCount
      ? `children.${idx}`
      : `attachments.${idx - childCount}`;
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
      // Splice the (script-bearing or script-removed) composition back
      // into the document at the current view's position. The compile
      // pass runs lazily on render — we just validate up-front that the
      // resulting doc can be compiled + resolved cleanly.
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
      let compileErrors: string[] = [];
      try {
        const result = compileDocument(newDoc);
        compileErrors = result.errors.map((e) => `${e.source}: ${e.message}`);
        resolveDoc(result.doc);
      } catch (err) {
        return [...compileErrors, String(err)];
      }
      setScriptError(compileErrors.length > 0 ? compileErrors.join("\n") : null);
      history.push(newDoc);
      setSelectedIndices([]);
      return null;
    },
    [document, view, history]
  );

  const handleJsonNodeSave = useCallback(
    (next: unknown): string[] | null => {
      // Splice the user's edited node back into the on-disk document.
      // The edited form may have stripped children/attachments on any
      // script/bin composition — `compileDocument` below regenerates
      // them, so we deliberately skip schema validation until after the
      // compile pass.
      let proposed: unknown;
      if (view.type === "root") {
        proposed = next;
      } else if (view.type === "clip" || view.type === "composition") {
        const idx = view.rootIndex;
        if (!document.children[idx]) {
          return ["View target no longer exists in the document."];
        }
        const newChildren = document.children.slice();
        newChildren[idx] = next as Child;
        proposed = { ...document, children: newChildren };
      } else {
        // cc-cut view doesn't expose a JSON tab — defensive no-op.
        return ["Cannot save JSON in this view."];
      }

      // Validate the authored shape directly — bin/binItem/script are
      // first-party schema fields now, so a bin reference with no
      // children is structurally valid. The compile pass runs lazily
      // for preview/render and surfaces any unresolved references
      // through scriptError.
      const validated = validateSeamFile(proposed);
      if (!validated.success) {
        console.warn("[App] handleJsonNodeSave validate failed:", validated.errors, {
          proposed,
        });
        return validated.errors;
      }

      let compileErrors: string[] = [];
      try {
        const result = compileDocument(validated.data);
        compileErrors = result.errors.map((e) => `${e.source}: ${e.message}`);
        resolveDoc(result.doc);
      } catch (err) {
        return [...compileErrors, String(err)];
      }

      setScriptError(compileErrors.length > 0 ? compileErrors.join("\n") : null);
      history.push(validated.data);
      setSelectedIndices([]);
      return null;
    },
    [document, view, history]
  );

  const onSelectionChange = useCallback((next: number[]) => {
    setSelectedIndices(next);
  }, []);

  // ── View navigation ────────────────────────────────────────────

  const handleEnterChild = useCallback(
    async (rootIndex: number, currentParentTime: number) => {
      if (!rootTimeline) return;
      const target = document.children[rootIndex];
      if (!target) return;

      if (target.type === "clip") {
        const basePath = filePath ? dirname(filePath) : "";
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
    [document, rootTimeline, filePath]
  );

  const handleExit = useCallback(
    (viewTime: number) => {
      if (view.type === "cc-cut") {
        // CC view doesn't translate time (synthesised preview); exit is
        // wired through Cancel instead. Treat handleExit as Cancel.
        setView(ROOT_VIEW);
        setCcSelections([]);
        setInitialTime(0);
        return;
      }
      if (!rootTimeline) return;
      const t = translateTimeOnExit(document, rootTimeline, view, viewTime);
      setInitialTime(t);
      setView(ROOT_VIEW);
    },
    [document, rootTimeline, view]
  );

  // ── CC Cut entry / exit ────────────────────────────────────────

  const handleEnterCCCut = useCallback(
    (binId: string) => {
      setCcSelections([]);
      setView({ type: "cc-cut", binId });
      setInitialTime(0);
      setSelectedIndices([]);
    },
    [],
  );

  const handleCCCutCancel = useCallback(() => {
    setView(ROOT_VIEW);
    setCcSelections([]);
    setInitialTime(0);
  }, []);

  const handleCCCutOk = useCallback(() => {
    if (view.type !== "cc-cut") return;
    if (!ccBinEntry) return;
    if (ccSelections.length === 0) {
      // Nothing to splice — behave like cancel.
      handleCCCutCancel();
      return;
    }
    const spliced = buildCCSpliceChildren(
      ccBinEntry,
      view.binId,
      ccSelections,
    );
    // Append the bin-reference children directly to the authored
    // document. The compile pass at preview/render time resolves them
    // against the doc's `bin`.
    const newDoc: SeamFile = {
      ...document,
      children: [...document.children, ...spliced],
    };
    history.push(newDoc);
    setView(ROOT_VIEW);
    setCcSelections([]);
    setInitialTime(0);
  }, [view, ccBinEntry, ccSelections, document, history, handleCCCutCancel]);

  // Delete in CC-cut view: drop the timeline-selected entries from
  // `ccSelections` (which the timeline + word ribbon both drive off of).
  // TimelinePanel's own delete handler is root-only, so this runs at
  // the App level for the cc-cut case.
  useEffect(() => {
    if (view.type !== "cc-cut") return;
    const handler = (e: KeyboardEvent) => {
      if (isTypingInEditableSurface(e)) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (selectedIndices.length === 0) return;
      e.preventDefault();
      const drop = new Set(
        selectedIndices.filter((i) => i < ccSelections.length),
      );
      if (drop.size === 0) return;
      setCcSelections(ccSelections.filter((_, i) => !drop.has(i)));
      setSelectedIndices([]);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [view, selectedIndices, ccSelections]);

  // ── Undo / Redo ────────────────────────────────────────────────

  const handleUndo = useCallback(() => {
    const prev = history.undo();
    if (prev != null) {
      setSelectedIndices([]);
    }
  }, [history]);

  const handleRedo = useCallback(() => {
    const next = history.redo();
    if (next != null) {
      setSelectedIndices([]);
    }
  }, [history]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Let the browser / Monaco handle undo / redo when an editable
      // element owns focus — otherwise typing into a rename input or
      // the JSON / Script editor and hitting Ctrl+Z would silently
      // roll back the *document* instead of the input.
      if (isTypingInEditableSurface(e)) return;
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

  const handleSave = useEvent(async () => {
    if (filePath) {
      await saveToFile(filePath);
    } else {
      const fp = await platform.pickSavePath();
      if (fp) await saveToFile(fp);
    }
  });

  const handleSaveAs = useEvent(async () => {
    const fp = await platform.pickSavePath();
    if (fp) await saveToFile(fp);
  });

  const handleExport = useEvent(async () => {
    const defaultName = filePath ? basenameWithoutExt(filePath) : "untitled";
    const basePath = filePath ? dirname(filePath) : "";
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
  });

  const handleImport = useEvent(async (file: File) => {
    if (!platform.importProject) return;
    try {
      const result = await platform.importProject(file);
      if (result) {
        await openFromJson(result.json, result.filePath);
        setShowBrowser(false);
      }
    } catch (err) {
      setErrors([String(err)]);
    }
  });

  // Web-only: bare .seam JSON import (no clip bundle). Confirms with
  // the user before overwriting an existing project of the same name.
  const handleImportSeam = useEvent(async (file: File) => {
    if (platform.kind !== "web") return;
    const wp = platform as WebPlatform;
    const targetName = file.name.endsWith(".seam")
      ? file.name
      : `${file.name}.seam`;
    try {
      if (await wp.projectExists(targetName)) {
        const ok = window.confirm(
          `"${targetName}" already exists in projects/. ` +
            `Importing will overwrite it. Continue?`,
        );
        if (!ok) return;
      }
      const result = await wp.importSeamFile(file);
      await openFromJson(result.json, result.filePath);
      setShowBrowser(false);
    } catch (err) {
      setErrors([String(err)]);
    }
  });

  // Web-only: download just the .seam JSON, no clips bundled.
  const handleExportSeam = useEvent(async () => {
    if (platform.kind !== "web") return;
    const wp = platform as WebPlatform;
    const defaultName = filePath ? basenameWithoutExt(filePath) : "untitled";
    try {
      await wp.exportSeamFile(history.current, defaultName);
    } catch (err) {
      setErrors([String(err)]);
    }
  });

  // ── Init + menu / action wiring ────────────────────────────────

  useEffect(() => {
    platform.getInitial().then((data) => {
      if (data) {
        void openFromJson(data.json, data.filePath);
      } else {
        void loadDocument(EMPTY_DOCUMENT, null);
      }
    });

    platform.onAction("new", () => {
      void loadDocument({ type: "composition", children: [] }, null);
      setShowBrowser(false);
    });

    platform.onAction("open", async () => {
      const result = await platform.openProject();
      if (!result) return;
      if ("error" in result) {
        setErrors([result.error]);
        return;
      }
      await openFromJson(result.json, result.filePath);
      setShowBrowser(false);
    });

    platform.onAction("save", () => void handleSave());
    platform.onAction("save-as", () => void handleSaveAs());
    platform.onAction("export", () => void handleExport());
    platform.onAction("settings", () => setSettingsOpen(true));
    // useEvent-wrapped handlers have stable identity — listing them as
    // deps is honest and won't re-fire this effect.
  }, [
    platform,
    openFromJson,
    loadDocument,
    handleSave,
    handleSaveAs,
    handleExport,
  ]);

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
    view.type === "root"
      ? "root"
      : view.type === "cc-cut"
        ? `cc-cut-${view.binId}`
        : `${view.type}-${view.rootIndex}`;

  // Selection bar appears once 2+ blocks are selected (Ctrl/Cmd+click).
  const showSelectionBar = selectedIndices.length >= 2;

  // ProjectBrowser uses (fp, json) order; WebTopBar's open flow goes
  // through platform.openProject(). Same destination, different entry
  // points — both clear the browser overlay on success.
  const handleOpenFromBrowser = useEvent((fp: string, json: string) => {
    void openFromJson(json, fp);
    setShowBrowser(false);
  });

  const handleNewProject = useEvent(() => {
    void loadDocument({ type: "composition", children: [] }, null);
    setShowBrowser(false);
  });

  const topBarOpen = useEvent(async () => {
    const result = await platform.openProject();
    if (!result) return;
    if ("error" in result) {
      setErrors([result.error]);
      return;
    }
    await openFromJson(result.json, result.filePath);
    setShowBrowser(false);
  });

  const topBarBrowseProjects = useEvent(() => {
    setShowBrowser(true);
  });

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
          onNew={handleNewProject}
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
            flexDirection: "row",
            height: "100%",
            background: "#1a1a1a",
            color: "#fff",
            fontFamily: "sans-serif",
            minHeight: 0,
          }}
        >
          {/* Left pane (~1/3): the inspector accordion, or the CC Cut editor
              while that view is active. */}
          <div
            style={{
              flex: "1 1 0",
              minWidth: 0,
              display: "flex",
              borderRight: "1px solid #333",
            }}
          >
            {view.type === "cc-cut" ? (
              <CCCutView
                words={ccWords}
                selections={ccSelections}
                onSelectionsChange={setCcSelections}
                focusedSelectionIndices={selectedIndices.filter(
                  (i) => i < ccSelections.length,
                )}
              />
            ) : (
              <InspectorAccordion
                timeline={editorTimeline}
                viewDocument={viewDocument}
                jsonNode={jsonNode}
                onJsonNodeSave={handleJsonNodeSave}
                jsonJumpPath={jsonJumpPath}
                scriptComposition={scriptComposition}
                scriptError={scriptError}
                onScriptApply={handleScriptApply}
                rootDocument={document}
                onRootDocumentChange={updateDocument}
                onEnterCCCut={handleEnterCCCut}
              />
            )}
          </div>
          {/* Right pane (~2/3): viewport on top, tools, then the timeline. */}
          <div
            style={{
              flex: "2 1 0",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            {/* VideoCanvas supplies its own flex:1 centering stage — don't
                wrap it in another flex box or the canvas loses a definite
                height to fit against and overflows vertically. */}
            <VideoCanvas
              width={playerTimeline.contentWidth}
              height={playerTimeline.contentHeight}
              style={{ background: "#111" }}
            />
            <ControlsBar
              document={document}
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
              onCCCutOk={handleCCCutOk}
              onCCCutCancel={handleCCCutCancel}
              ccCutHasSelections={ccSelections.length > 0}
            />
            <TimelinePanel
              timeline={editorTimeline}
              document={document}
              viewDocument={viewDocument}
              filePath={filePath}
              selectedIndices={selectedIndices}
              onSelectionChange={onSelectionChange}
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
          onNew={handleNewProject}
          onOpen={topBarOpen}
          onSave={handleSave}
          onSaveAs={handleSaveAs}
          onExport={handleExport}
          onImport={handleImport}
          onExportSeam={handleExportSeam}
          onImportSeam={handleImportSeam}
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
