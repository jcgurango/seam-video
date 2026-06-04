import React, { useState, useEffect, useRef } from "react";

interface MenuItem {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
}

interface WebTopBarProps {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onExportSeam: () => void;
  onImportSeam: (file: File) => void;
  onBrowseProjects: () => void;
  onSettings: () => void;
  canSave: boolean; // false if no document loaded
}

export default function WebTopBar({
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onExport,
  onImport,
  onExportSeam,
  onImportSeam,
  onBrowseProjects,
  onSettings,
  canSave,
}: WebTopBarProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importSeamInputRef = useRef<HTMLInputElement>(null);

  const triggerImport = () => importInputRef.current?.click();
  const triggerImportSeam = () => importSeamInputRef.current?.click();

  const handleImportChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onImport(file);
    e.target.value = "";
  };

  const handleImportSeamChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onImportSeam(file);
    e.target.value = "";
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isMac =
    typeof navigator !== "undefined" &&
    /mac/i.test(navigator.platform || navigator.userAgent);
  const mod = isMac ? "⌘" : "Ctrl+";

  const items: MenuItem[] = [
    { label: "New Project", shortcut: `${mod}N`, onClick: onNew },
    { label: "Open Project…", shortcut: `${mod}O`, onClick: onOpen },
    {
      label: "Save",
      shortcut: `${mod}S`,
      onClick: onSave,
      disabled: !canSave,
    },
    {
      label: "Save As…",
      shortcut: `${mod}⇧S`,
      onClick: onSaveAs,
      disabled: !canSave,
    },
    { label: "—", onClick: () => {} },
    { label: "Import .seam…", onClick: triggerImportSeam },
    {
      label: "Export .seam…",
      onClick: onExportSeam,
      disabled: !canSave,
    },
    { label: "—", onClick: () => {} },
    { label: "Import Zip…", onClick: triggerImport },
    {
      label: "Export Zip…",
      shortcut: `${mod}E`,
      onClick: onExport,
      disabled: !canSave,
    },
    { label: "—", onClick: () => {} },
    { label: "Browse Projects", onClick: onBrowseProjects },
    { label: "—", onClick: () => {} },
    { label: "Settings…", shortcut: `${mod},`, onClick: onSettings },
  ];

  const handleItem = (item: MenuItem) => {
    if (item.disabled || item.label === "—") return;
    setOpen(false);
    item.onClick();
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        background: "#1f1f1f",
        borderBottom: "1px solid #2a2a2a",
        fontFamily: "sans-serif",
        fontSize: 13,
        color: "#e0e0e0",
        height: 32,
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      <input
        ref={importInputRef}
        type="file"
        accept=".zip,application/zip"
        onChange={handleImportChange}
        style={{ display: "none" }}
      />
      <input
        ref={importSeamInputRef}
        type="file"
        accept=".seam,application/json"
        onChange={handleImportSeamChange}
        style={{ display: "none" }}
      />
      <div ref={ref} style={{ position: "relative" }}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            background: open ? "#2a2a2a" : "none",
            border: "none",
            color: "#e0e0e0",
            padding: "0 14px",
            height: "100%",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          File
        </button>
        {open && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              background: "#2a2a2a",
              border: "1px solid #3a3a3a",
              borderRadius: 4,
              minWidth: 220,
              boxShadow: "0 8px 20px rgba(0,0,0,0.5)",
              zIndex: 1000,
              padding: "4px 0",
            }}
          >
            {items.map((item, i) =>
              item.label === "—" ? (
                <div
                  key={i}
                  style={{
                    height: 1,
                    background: "#3a3a3a",
                    margin: "4px 0",
                  }}
                />
              ) : (
                <button
                  key={i}
                  onClick={() => handleItem(item)}
                  disabled={item.disabled}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    width: "100%",
                    padding: "6px 14px",
                    background: "none",
                    border: "none",
                    color: item.disabled ? "#666" : "#e0e0e0",
                    cursor: item.disabled ? "default" : "pointer",
                    fontSize: 13,
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => {
                    if (!item.disabled)
                      e.currentTarget.style.background = "#3a6ea5";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span>{item.label}</span>
                  {item.shortcut && (
                    <span
                      style={{
                        color: item.disabled ? "#555" : "#888",
                        fontSize: 11,
                        marginLeft: 20,
                      }}
                    >
                      {item.shortcut}
                    </span>
                  )}
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
