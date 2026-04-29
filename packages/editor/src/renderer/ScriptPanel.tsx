import React, { useEffect, useMemo, useState } from "react";
import "./monacoSetup.js";
import Editor from "@monaco-editor/react";
import type { Composition } from "@seam/core";
import {
  bakeScript,
  disableScript,
  enableScript,
  findScript,
  withUpdatedScriptSrc,
} from "./nodeScript.js";

export interface ScriptPanelProps {
  /** The composition the user is currently viewing (root or a nested
   *  composition). May be null when the active view is a clip — in which
   *  case the panel just nudges the user to switch views. */
  currentComposition: Composition | null;
  /** Last script-execution error from this composition, surfaced via the
   *  parent so successful saves clear it. */
  scriptError: string | null;
  /** Apply a transformed composition back to the document at this view's
   *  position. The parent handles whether to wrap via the root script,
   *  splice into a child slot, etc. */
  onApply: (next: Composition) => string[] | null;
}

export default function ScriptPanel({
  currentComposition,
  scriptError,
  onApply,
}: ScriptPanelProps) {
  const script = useMemo(
    () => (currentComposition ? findScript(currentComposition) : null),
    [currentComposition]
  );

  const [draft, setDraft] = useState<string>(script?.payload.scriptSrc ?? "");
  const [baseline, setBaseline] = useState<string>(script?.payload.scriptSrc ?? "");
  const [errors, setErrors] = useState<string[] | null>(null);

  // When the active composition (or its script source) changes, sync the
  // editor — but preserve dirty edits if the user is mid-typing on the
  // same composition.
  useEffect(() => {
    const next = script?.payload.scriptSrc ?? "";
    if (draft === baseline) {
      setDraft(next);
      setBaseline(next);
      setErrors(null);
    } else {
      // Buffer is dirty — leave it, but reset baseline so dirty===false
      // resolves once the user matches the new scriptSrc.
      setBaseline(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script?.payload.scriptSrc]);

  if (!currentComposition) {
    return (
      <div style={EMPTY_STYLE}>
        Scripts can only be attached to compositions. Switch to a
        composition view to manage scripts.
      </div>
    );
  }

  const dirty = draft !== baseline;

  const handleEnable = () => {
    setErrors(null);
    try {
      const next = enableScript(currentComposition);
      const errs = onApply(next);
      if (errs) setErrors(errs);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    }
  };

  const handleDisable = () => {
    setErrors(null);
    const next = disableScript(currentComposition);
    const errs = onApply(next);
    if (errs) setErrors(errs);
  };

  const handleBake = () => {
    setErrors(null);
    try {
      const next = bakeScript(currentComposition);
      const errs = onApply(next);
      if (errs) setErrors(errs);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    }
  };

  const handleSave = () => {
    if (!script) return;
    setErrors(null);
    try {
      const next = withUpdatedScriptSrc(currentComposition, draft);
      const errs = onApply(next);
      if (errs) {
        setErrors(errs);
      } else {
        setBaseline(draft);
      }
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    }
  };

  if (!script) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          padding: 16,
          gap: 12,
        }}
      >
        <div style={{ color: "#aaa" }}>
          No script attached to this composition.
        </div>
        <div style={{ color: "#888", fontSize: 11 }}>
          Enabling a script captures the current composition as{" "}
          <code style={CODE_STYLE}>original</code> and starts with an
          identity script (<code style={CODE_STYLE}>return currentNode;</code>).
          The composition's body becomes the rendered output of running the
          script against <code style={CODE_STYLE}>original</code>; future
          edits to the timeline panel update <code style={CODE_STYLE}>original</code>{" "}
          and the script re-runs.
        </div>
        <div>
          <button onClick={handleEnable} style={BTN_PRIMARY}>
            Enable Script
          </button>
        </div>
        {errors && errors.length > 0 && <ErrorBox messages={errors} />}
      </div>
    );
  }

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
          language="javascript"
          theme="vs-dark"
          value={draft}
          onChange={(v) => setDraft(v ?? "")}
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
          padding: 8,
          background: "#1f1f1f",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          minHeight: 40,
        }}
      >
        <div style={{ color: "#888", fontSize: 11 }}>
          The script runs as{" "}
          <code style={CODE_STYLE}>
            (currentNode) =&gt; {"{"} … {"}"}
          </code>
          . Must return a composition node.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={handleSave}
            disabled={!dirty}
            title={dirty ? "Save and re-run" : "No changes"}
            style={dirty ? BTN_PRIMARY : BTN_DISABLED}
          >
            Save
          </button>
          <button
            onClick={handleBake}
            style={BTN_SECONDARY}
            title="Run the script one last time and replace the composition with its output. Removes the script."
          >
            Bake
          </button>
          <button onClick={handleDisable} style={BTN_DANGER}>
            Disable Script
          </button>
          {(errors && errors.length > 0) || scriptError ? (
            <ErrorBox
              messages={errors ?? (scriptError ? [scriptError] : [])}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ErrorBox({ messages }: { messages: string[] }) {
  return (
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
      {messages.join("\n")}
    </div>
  );
}

const BTN_PRIMARY: React.CSSProperties = {
  background: "#4a7eb8",
  border: "none",
  color: "#fff",
  padding: "6px 12px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
};

const BTN_DISABLED: React.CSSProperties = {
  ...BTN_PRIMARY,
  background: "#2a2a2a",
  color: "#666",
  cursor: "not-allowed",
};

const BTN_SECONDARY: React.CSSProperties = {
  background: "#333",
  border: "1px solid #444",
  color: "#e0e0e0",
  padding: "6px 12px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
};

const BTN_DANGER: React.CSSProperties = {
  background: "#7a3a3a",
  border: "1px solid #a04040",
  color: "#fff",
  padding: "6px 12px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
};

const CODE_STYLE: React.CSSProperties = {
  background: "#1a1a1a",
  padding: "1px 4px",
  borderRadius: 3,
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
};

const EMPTY_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: 16,
  color: "#888",
};
