import React, { useEffect, useMemo, useRef, useState } from "react";
import "./monacoSetup.js";
import Editor from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { formatJsonWithLocations } from "./jsonFormat.js";

interface JsonNodePanelProps {
  /** Current value of the node, supplied by the parent. Re-renders flow in here. */
  node: unknown;
  /**
   * Called when the user clicks Save with a successfully-parsed value.
   * Returns null on success, or an array of error strings to display
   * (e.g. schema or resolution errors). The panel does the JSON.parse;
   * the parent does the schema validation + commit.
   */
  onSave: (next: unknown) => string[] | null;
  /**
   * Path key (e.g. "children.3", "attachments.0") to scroll the editor to
   * whenever it changes. Computed by the parent from the current selection.
   */
  jumpPath?: string | null;
}

export default function JsonNodePanel({
  node,
  onSave,
  jumpPath,
}: JsonNodePanelProps) {
  // Debounce the doc -> editor sync so a burst of timeline mutations
  // coalesces into a single (re-format + Monaco re-feed) instead of thrashing
  // Monaco — feeding a large document through it on every edit was the source
  // of multi-second re-tokenize/GC stalls. (The panel is unmounted entirely
  // while its accordion section is collapsed, so hidden edits cost nothing.)
  const [syncedNode, setSyncedNode] = useState(node);
  const nodeRef = useRef(node);
  nodeRef.current = node;
  useEffect(() => {
    const id = window.setTimeout(() => setSyncedNode(nodeRef.current), 120);
    return () => window.clearTimeout(id);
  }, [node]);

  // The "live" JSON the parent is showing — formatted with our own walker so
  // the location offsets line up with the rendered text.
  const formatted = useMemo(
    () => formatJsonWithLocations(syncedNode),
    [syncedNode],
  );
  const documentJson = formatted.text;
  const locations = formatted.locations;

  // The buffer the user is editing.
  const [editorJson, setEditorJson] = useState(documentJson);
  // The documentJson the editor was last in sync with. Diverges from
  // editorJson when the user types (-> dirty) and from documentJson when
  // the parent doc moves on its own (-> externalChanged).
  const [baselineJson, setBaselineJson] = useState(documentJson);
  const [errors, setErrors] = useState<string[] | null>(null);

  const dirty = editorJson !== baselineJson;
  const externalChanged = documentJson !== baselineJson;
  const conflicted = dirty && externalChanged;
  const canSave = dirty && !conflicted;

  // When the parent's node changes:
  //   - If the buffer is clean, mirror it (auto-reload).
  //   - If the buffer is dirty, leave it alone — the UI will show a Reload
  //     button because externalChanged is now true.
  useEffect(() => {
    if (!dirty && editorJson !== documentJson) {
      setEditorJson(documentJson);
      setBaselineJson(documentJson);
      setErrors(null);
    }
    // dirty intentionally not in deps: we only want to react to docJson moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentJson]);

  const handleChange = (value: string | undefined) => {
    setEditorJson(value ?? "");
    if (errors) setErrors(null);
  };

  const handleSave = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(editorJson);
    } catch (err) {
      setErrors([`Invalid JSON: ${(err as Error).message}`]);
      return;
    }
    const errs = onSave(parsed);
    if (errs && errs.length > 0) {
      setErrors(errs);
      return;
    }
    setErrors(null);
    setBaselineJson(editorJson);
  };

  const handleReload = () => {
    setEditorJson(documentJson);
    setBaselineJson(documentJson);
    setErrors(null);
  };

  // ── Jump-to-definition ──────────────────────────────────────────────
  // The editor instance + a helper to scroll/select a path in it. The
  // parent passes in the current path key (derived from the selection); we
  // reveal it whenever it changes, and again on first mount of the editor.
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);

  const revealPath = (path: string | null | undefined) => {
    if (!path) return;
    const ed = editorRef.current;
    if (!ed) return;
    const offset = locations.get(path);
    if (offset == null) return;
    const model = ed.getModel();
    if (!model) return;
    const pos = model.getPositionAt(offset);
    ed.revealLineInCenter(pos.lineNumber);
    ed.setPosition(pos);
  };

  const handleEditorMount = (ed: MonacoEditor.IStandaloneCodeEditor) => {
    editorRef.current = ed;
    revealPath(jumpPath);
  };

  useEffect(() => {
    revealPath(jumpPath);
    // locations is recomputed when documentJson changes; including it lets
    // the jump target re-resolve after auto-reloads. eslint-disable for
    // revealPath which is a closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpPath, locations]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          borderBottom: "1px solid #333",
        }}
      >
        <Editor
          language="json"
          theme="vs-dark"
          value={editorJson}
          onChange={handleChange}
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            wordWrap: "on",
            tabSize: 2,
            scrollBeyondLastLine: false,
            automaticLayout: true,
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: 8,
          background: "#1f1f1f",
          minHeight: 40,
        }}
      >
        <button
          onClick={handleSave}
          disabled={!canSave}
          title={
            conflicted
              ? "Document changed externally — reload first"
              : !dirty
                ? "No changes"
                : "Save"
          }
          style={{
            background: canSave ? "#4a7eb8" : "#2a2a2a",
            border: "none",
            color: canSave ? "#fff" : "#666",
            padding: "6px 12px",
            borderRadius: 4,
            cursor: canSave ? "pointer" : "not-allowed",
            fontSize: 12,
            fontFamily: "inherit",
          }}
        >
          Save
        </button>
        {conflicted && (
          <button
            onClick={handleReload}
            style={{
              background: "#7a5a3a",
              border: "none",
              color: "#fff",
              padding: "6px 12px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "inherit",
            }}
          >
            Reload
          </button>
        )}
        {errors && errors.length > 0 && (
          <div
            style={{
              color: "#ff6b6b",
              fontSize: 11,
              flex: 1,
              minWidth: 0,
              overflow: "auto",
              maxHeight: 60,
              fontFamily: "ui-monospace, monospace",
              whiteSpace: "pre-wrap",
            }}
          >
            {errors.join("\n")}
          </div>
        )}
      </div>
    </div>
  );
}
