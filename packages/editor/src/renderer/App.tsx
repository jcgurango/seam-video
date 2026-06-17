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
import type { ResolvedTimeline, SeamFile } from "@seam/core";
import ControlsBar from "./ControlsBar.js";
import TimelinePanel from "./TimelinePanel.js";
import InspectorAccordion from "./InspectorAccordion.js";
import ProjectPicker from "./ProjectPicker.js";
import ProjectBrowser from "./ProjectBrowser.js";
import WebTopBar from "./WebTopBar.js";
import SettingsDialog from "./SettingsDialog.js";
import { useSettings } from "./useSettings.js";
import { useTranscribe, type CompositionAudioMode } from "./useTranscribe.js";
import CompositionAudioDialog from "./CompositionAudioDialog.js";
import Toast from "./Toast.js";
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
import { rootIndicesFromKeys, rootKeyFromIndex } from "./nodePath.js";
import type { Platform } from "./platform/index.js";
import { WebPlatform } from "./platform/index.js";

interface AppProps {
  platform: Platform;
}

const EMPTY_DOCUMENT: SeamFile = { type: "composition", children: [] };

/** CC-Cut mode: when non-null the editor is cutting the named bin entry
 *  into clips. Null means normal editing of the root document. This is the
 *  only "mode" the editor has now that drill-down navigation is gone. */
type CCCutMode = { binId: string } | null;

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
  // Canonical selection: path keys (`children.0`,
  // `children.3.attachments.1`). Root-only tools derive flat indices from
  // these via `rootIndicesFromKeys` at their boundary (see nodePath.ts).
  const [selection, setSelection] = useState<string[]>([]);
  const [ccCut, setCcCut] = useState<CCCutMode>(null);
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
  const [compAudioPromptOpen, setCompAudioPromptOpen] = useState(false);
  // Transient transcription feedback (empty selection, server/decoding
  // failures). Kept separate from `errors` so it shows as a dismissible toast
  // rather than blanking the editor with the validation-error view.
  const [transcribeNotice, setTranscribeNotice] = useState<string[]>([]);
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

  // Bin entry currently being CC-cut (null outside CC-cut mode). The
  // resolved word ribbon + preview doc derive from this.
  const ccBinEntry = useMemo(() => {
    if (!ccCut) return null;
    const bin = findBin(document as Composition);
    return bin.find((e) => e.id === ccCut.binId) ?? null;
  }, [ccCut, document]);

  const ccWords = useMemo(() => {
    if (!ccBinEntry) return [];
    return resolveCCWords(ccBinEntry, document);
  }, [ccBinEntry, document]);

  // The document currently being shown. Normal editing operates on the
  // root document directly; CC-cut synthesises a preview doc from the
  // user's in-progress word selections.
  const activeDoc = useMemo<SeamFile>(() => {
    if (ccCut) {
      if (!ccBinEntry) return document;
      return buildCCPreviewDoc(ccBinEntry, document, ccSelections);
    }
    return document;
  }, [ccCut, ccBinEntry, document, ccSelections]);

  // Two resolved timelines:
  //   - playerTimeline: bins spliced + scripts run; what the canvas plays.
  //   - editorTimeline: bins spliced, scripts NOT run; what the
  //     timeline panel renders. Skipping scripts means the panel shows
  //     the user's authored body, so drag/trim/delete writes back to
  //     positions that match what the user sees. Running scripts would
  //     replace those authored children with the script's output and
  //     edits would map onto compiled nodes that don't exist in the
  //     authored doc.
  // `rootTimeline` is the resolved root document; it drives the canvas in
  // normal editing and is where compile/resolve errors are published.
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
    if (!ccCut) return rootTimeline;
    try {
      const { doc: compiled } = compileDocument(activeDoc);
      return resolveDoc(compiled);
    } catch (err) {
      console.error("[App] playerTimeline resolve failed:", err, { activeDoc });
      return null;
    }
  }, [ccCut, activeDoc, rootTimeline]);

  const editorTimeline = useMemo<ResolvedTimeline | null>(() => {
    try {
      const { doc: panelCompiled } = compileDocument(activeDoc, {
        runScripts: false,
      });
      return resolveDoc(panelCompiled);
    } catch (err) {
      console.error("[App] editorTimeline resolve failed:", err, { activeDoc });
      return null;
    }
  }, [activeDoc]);

  // Guard: bounce out of CC-cut if the targeted bin entry has been
  // deleted / renamed out from under us.
  useEffect(() => {
    if (!ccCut) return;
    const bin = findBin(document as Composition);
    if (!bin.some((e) => e.id === ccCut.binId)) {
      setCcCut(null);
      setCcSelections([]);
    }
  }, [document, ccCut]);

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
    setSelection([]);
    setCcCut(null);
    setCcSelections([]);
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

  // Commit an edited document to history. On web, warm the blob URL cache for
  // any newly-referenced clip sources *before* the doc reaches state — the
  // timeline reads resolveSource() synchronously on mount, so a source that
  // isn't cached yet (one introduced by pasting JSON, editing a node's
  // `source`, etc.) would resolve to a bare filename and fail to decode.
  // Mirrors loadDocument's preload, minus the cache reset (this is
  // incremental — preloadBlobUrls skips sources already cached). Selection /
  // mode state stays in the synchronous callers so it isn't reordered behind
  // this await.
  const commitDocument = useEvent(async (newDoc: SeamFile) => {
    if (platform.kind === "web") {
      const wp = platform as WebPlatform;
      await wp.preloadBlobUrls(collectClipSources(newDoc));
    }
    history.push(newDoc);
  });

  const updateDocument = useCallback(
    (newDoc: SeamFile) => {
      // No more script-original / rendered-body bookkeeping — the
      // authored doc is the canonical state and the compile pass runs
      // lazily in rootTimeline. Any compile errors get reported there.
      void commitDocument(newDoc);
      setSelection([]);
    },
    [commitDocument]
  );

  // The JSON tab edits the authored root document directly. Bin
  // references appear as compositions with a `binItem` field; scripts
  // appear as a `script` string.
  const jsonNode = document;

  // A keyframe diamond click reveals a deeper path than the selection
  // (`children.3.opacity.2`). It's transient state, reset whenever the
  // selection changes so node selection still drives the jump otherwise.
  // The token forces the JSON section open + re-reveals on repeat clicks.
  const [jsonReveal, setJsonReveal] = useState<{ path: string; token: number } | null>(
    null,
  );
  useEffect(() => {
    setJsonReveal(null);
  }, [selection]);
  const handleJumpToJson = useCallback((path: string) => {
    setJsonReveal((prev) => ({ path, token: (prev?.token ?? 0) + 1 }));
  }, []);

  // The current selection's path key already *is* a dotted JSON path
  // (`children.0`, `children.3.attachments.1`) — jump straight to it. A
  // diamond click overrides with the exact keyframe path.
  const jsonJumpPath = useMemo<string | null>(() => {
    if (jsonReveal) return jsonReveal.path;
    if (selection.length !== 1) return null;
    return selection[0];
  }, [selection, jsonReveal]);

  // The Script tab targets the root composition.
  const scriptComposition = document as Composition;

  const handleScriptApply = useCallback(
    (next: Composition): string[] | null => {
      // The Script tab targets the root composition, so its output is the
      // new root document. The compile pass runs lazily on render — we
      // just validate up-front that it compiles + resolves cleanly.
      const newDoc = next as SeamFile;
      let compileErrors: string[] = [];
      try {
        const result = compileDocument(newDoc);
        compileErrors = result.errors.map((e) => `${e.source}: ${e.message}`);
        resolveDoc(result.doc);
      } catch (err) {
        return [...compileErrors, String(err)];
      }
      setScriptError(compileErrors.length > 0 ? compileErrors.join("\n") : null);
      void commitDocument(newDoc);
      setSelection([]);
      return null;
    },
    [commitDocument]
  );

  const handleJsonNodeSave = useCallback(
    (next: unknown): string[] | null => {
      // The JSON tab edits the whole root document. The edited form may
      // have stripped children/attachments on any script/bin composition —
      // `compileDocument` below regenerates them, so validation runs
      // against the authored shape and the compile pass runs after.
      const proposed = next;

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
      void commitDocument(validated.data);
      setSelection([]);
      return null;
    },
    [commitDocument]
  );

  const onSelectionChange = useCallback((next: string[]) => {
    setSelection(next);
  }, []);

  // Flat root indices for the root-only edit tools (ControlsBar): the
  // path-key selection projected down to `[0, childCount)` children and
  // `[childCount, …)` attachments, nested keys dropped.
  const rootSelectedIndices = useMemo(
    () => rootIndicesFromKeys(selection, document.children.length),
    [selection, document],
  );
  const onRootSelectionChange = useCallback(
    (idxs: number[]) => {
      setSelection(
        idxs.map((i) => rootKeyFromIndex(i, document.children.length)),
      );
    },
    [document],
  );

  // ── CC Cut entry / exit ────────────────────────────────────────

  const handleEnterCCCut = useCallback(
    (binId: string) => {
      setCcSelections([]);
      setCcCut({ binId });
      setSelection([]);
    },
    [],
  );

  const handleCCCutCancel = useCallback(() => {
    // Cancelling discards the in-progress cuts, which aren't on the undo
    // stack — confirm before throwing them away (an empty session is a
    // harmless no-op, so skip the prompt then).
    if (ccSelections.length > 0) {
      const ok = window.confirm(
        "Discard all CC Cut selections? This can't be undone.",
      );
      if (!ok) return;
    }
    setCcCut(null);
    setCcSelections([]);
  }, [ccSelections]);

  const handleCCCutOk = useCallback(() => {
    if (!ccCut) return;
    if (!ccBinEntry) return;
    if (ccSelections.length === 0) {
      // Nothing to splice — behave like cancel.
      handleCCCutCancel();
      return;
    }
    const spliced = buildCCSpliceChildren(
      ccBinEntry,
      ccCut.binId,
      ccSelections,
    );
    // Append the bin-reference children directly to the authored
    // document. The compile pass at preview/render time resolves them
    // against the doc's `bin`.
    const newDoc: SeamFile = {
      ...document,
      children: [...document.children, ...spliced],
    };
    void commitDocument(newDoc);
    setCcCut(null);
    setCcSelections([]);
  }, [ccCut, ccBinEntry, ccSelections, document, commitDocument, handleCCCutCancel]);

  // Delete in CC-cut mode: drop the timeline-selected entries from
  // `ccSelections` (which the timeline + word ribbon both drive off of).
  useEffect(() => {
    if (!ccCut) return;
    const handler = (e: KeyboardEvent) => {
      if (isTypingInEditableSurface(e)) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (selection.length === 0) return;
      e.preventDefault();
      // CC-cut renders the preview's root children; map the path-key
      // selection back to those flat child indices.
      const drop = new Set(
        rootIndicesFromKeys(selection, ccSelections.length).filter(
          (i) => i < ccSelections.length,
        ),
      );
      if (drop.size === 0) return;
      setCcSelections(ccSelections.filter((_, i) => !drop.has(i)));
      setSelection([]);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [ccCut, selection, ccSelections]);

  // ── Undo / Redo ────────────────────────────────────────────────

  const handleUndo = useCallback(() => {
    const prev = history.undo();
    if (prev != null) {
      setSelection([]);
    }
  }, [history]);

  const handleRedo = useCallback(() => {
    const next = history.redo();
    if (next != null) {
      setSelection([]);
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
  // appends a `data` attachment per response onto the root document.
  const transcriber = useTranscribe({
    serverUrl: settings.generatorServerUrl,
    platform,
    basePath,
    history,
  });

  useEffect(() => {
    if (transcriber.errors.length > 0) {
      setTranscribeNotice(transcriber.errors);
    }
  }, [transcriber.errors]);

  // Root-level selected nodes that are compositions — they need the mix-mode
  // modal before the job runs (clip/audio targets transcribe directly).
  const selectedCompositionCount = useMemo(() => {
    const childCount = document.children.length;
    return rootSelectedIndices.filter((idx) => {
      const node =
        idx < childCount
          ? document.children[idx]
          : document.attachments?.[idx - childCount];
      return node?.type === "composition";
    }).length;
  }, [rootSelectedIndices, document]);

  const handleTranscribe = useCallback(() => {
    if (rootSelectedIndices.length === 0) return;
    setTranscribeNotice([]);
    // A composition in the selection needs a mix-mode choice first.
    if (selectedCompositionCount > 0) {
      setCompAudioPromptOpen(true);
      return;
    }
    void transcriber.run(document, rootSelectedIndices);
  }, [transcriber, document, rootSelectedIndices, selectedCompositionCount]);

  const handleCompAudioChoose = useCallback(
    (mode: CompositionAudioMode) => {
      setCompAudioPromptOpen(false);
      setTranscribeNotice([]);
      void transcriber.run(document, rootSelectedIndices, mode);
    },
    [transcriber, document, rootSelectedIndices],
  );

  // Remounts the <Timeline> (resetting playhead) when toggling CC-cut mode.
  const viewKey = ccCut ? `cc-cut-${ccCut.binId}` : "root";

  // Selection bar appears once 2+ blocks are selected (Ctrl/Cmd+click).
  const showSelectionBar = selection.length >= 2;

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
        initialTime={0}
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
              while CC-cut mode is active. */}
          <div
            style={{
              flex: "1 1 0",
              minWidth: 0,
              display: "flex",
              borderRight: "1px solid #333",
            }}
          >
            {ccCut ? (
              <CCCutView
                words={ccWords}
                selections={ccSelections}
                onSelectionsChange={setCcSelections}
                focusedSelectionIndices={rootIndicesFromKeys(
                  selection,
                  ccSelections.length,
                ).filter((i) => i < ccSelections.length)}
              />
            ) : (
              <InspectorAccordion
                timeline={editorTimeline}
                document={activeDoc}
                jsonNode={jsonNode}
                onJsonNodeSave={handleJsonNodeSave}
                jsonJumpPath={jsonJumpPath}
                jsonRevealToken={jsonReveal?.token ?? 0}
                scriptComposition={scriptComposition}
                scriptError={scriptError}
                onScriptApply={handleScriptApply}
                rootDocument={document}
                onRootDocumentChange={updateDocument}
                onEnterCCCut={handleEnterCCCut}
                platform={platform}
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
              selectedIndices={rootSelectedIndices}
              selection={selection}
              timeline={editorTimeline}
              onSelectionChange={onRootSelectionChange}
              onDocumentChange={updateDocument}
              onUndo={handleUndo}
              onRedo={handleRedo}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              ccCutMode={ccCut != null}
              platform={platform}
              onTranscribe={handleTranscribe}
              transcribing={transcriber.progress != null}
              onCCCutOk={handleCCCutOk}
              onCCCutCancel={handleCCCutCancel}
              ccCutHasSelections={ccSelections.length > 0}
            />
            <TimelinePanel
              timeline={editorTimeline}
              document={ccCut ? undefined : document}
              filePath={filePath}
              selection={selection}
              onSelectionChange={onSelectionChange}
              onDocumentChange={updateDocument}
              history={history}
              platform={platform}
              onJumpToJson={handleJumpToJson}
            />
            {showSelectionBar && (
              <SelectionBar
                count={selection.length}
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

      <Toast
        messages={transcribeNotice}
        kind="error"
        onDismiss={() => setTranscribeNotice([])}
      />

      <CompositionAudioDialog
        open={compAudioPromptOpen}
        compositionCount={selectedCompositionCount}
        onChoose={handleCompAudioChoose}
        onClose={() => setCompAudioPromptOpen(false)}
      />

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
