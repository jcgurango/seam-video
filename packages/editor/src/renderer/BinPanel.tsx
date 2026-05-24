import React, { useMemo, useState } from "react";
import type { SeamFile } from "@seam/core";
import { findBin, renameBinItemId } from "./nodeBin.js";

export interface BinPanelProps {
  /** Editor-surface root. The bin lives in its metadata. */
  rootDocument: SeamFile;
  /** Apply a transformed root back to history. Renames go through here
   *  so the rest of the editor (timeline, script, compile pass) picks
   *  up the new ids automatically. */
  onRootDocumentChange: (next: SeamFile) => void;
}

/** Barebones bin panel: list every entry by id, let the user rename one
 *  in place. Rename reuses `renameBinItemId`, which rewrites every
 *  `seam-editor-bin-item` reference in the document tree (including
 *  inside a script's `original`) to point at the new id. */
export default function BinPanel({
  rootDocument,
  onRootDocumentChange,
}: BinPanelProps) {
  const entries = useMemo(() => findBin(rootDocument), [rootDocument]);
  const takenIds = useMemo(
    () => new Set(entries.map((e) => e.id)),
    [entries],
  );

  if (entries.length === 0) {
    return (
      <div style={EMPTY_STYLE}>
        The bin is empty. Select a composition and use the Bin tool
        (toolbar) to promote it into a reusable entry.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {entries.map((entry) => (
          <BinRow
            key={entry.id}
            id={entry.id}
            takenIds={takenIds}
            onRename={(newId) => {
              onRootDocumentChange(
                renameBinItemId(rootDocument, entry.id, newId),
              );
            }}
          />
        ))}
      </div>
    </div>
  );
}

interface BinRowProps {
  id: string;
  takenIds: Set<string>;
  onRename: (newId: string) => void;
}

function BinRow({ id, takenIds, onRename }: BinRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(id);

  const trimmed = draft.trim();
  const canSave =
    trimmed.length > 0 && (trimmed === id || !takenIds.has(trimmed));

  const startEdit = () => {
    setDraft(id);
    setEditing(true);
  };
  const cancel = () => {
    setDraft(id);
    setEditing(false);
  };
  const commit = () => {
    if (!canSave) return;
    if (trimmed !== id) onRename(trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={ROW_STYLE}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
          }}
          autoFocus
          style={INPUT_STYLE}
        />
        <button
          onClick={commit}
          disabled={!canSave}
          style={canSave ? BTN_PRIMARY : BTN_DISABLED}
          title={
            !canSave && trimmed.length === 0
              ? "Id can't be empty"
              : !canSave
                ? "Id already in use"
                : "Save"
          }
        >
          Save
        </button>
        <button onClick={cancel} style={BTN_SECONDARY}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div style={ROW_STYLE}>
      <code style={ID_STYLE}>{id}</code>
      <button onClick={startEdit} style={BTN_SECONDARY}>
        Rename
      </button>
    </div>
  );
}

const EMPTY_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: 16,
  color: "#888",
};

const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  background: "#1c1c1c",
  border: "1px solid #333",
  borderRadius: 4,
};

const ID_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
  color: "#ddd",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const INPUT_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "#111",
  border: "1px solid #444",
  borderRadius: 4,
  color: "#fff",
  padding: "4px 8px",
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
};

const BTN_PRIMARY: React.CSSProperties = {
  background: "#4a7eb8",
  border: "none",
  color: "#fff",
  padding: "4px 10px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
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
  padding: "4px 10px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "inherit",
};
