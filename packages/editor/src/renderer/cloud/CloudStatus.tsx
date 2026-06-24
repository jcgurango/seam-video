import React, { useEffect, useRef, useState } from "react";
import { Cloud, CloudOff, LogOut, RefreshCw } from "lucide-react";
import type { CloudClient } from "./CloudClient.js";
import { useCloud } from "./useCloud.js";

/**
 * Top-bar cloud control (right side of WebTopBar). Shows a "Login" button when
 * signed out, and the account + a Logout menu when signed in. Rendered only on
 * web when a cloud base URL is configured.
 */
export default function CloudStatus({ client }: { client: CloudClient }) {
  const state = useCloud(client);
  const [loginOpen, setLoginOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  if (!state) return null;

  if (state.status !== "authed") {
    const busy = state.status === "authenticating";
    return (
      <>
        <button
          onClick={() => setLoginOpen(true)}
          title={state.lastError ?? "Sign in to Seam Cloud"}
          style={barButtonStyle(!!state.lastError)}
        >
          <CloudOff size={14} />
          {busy ? "Signing in…" : "Login"}
        </button>
        {loginOpen && (
          <CloudLoginDialog client={client} onClose={() => setLoginOpen(false)} />
        )}
      </>
    );
  }

  const email = state.user?.email ?? "account";
  return (
    <div ref={menuRef} style={{ position: "relative", display: "flex" }}>
      <button
        onClick={() => setMenuOpen((v) => !v)}
        title={`Signed in to Seam Cloud as ${email}`}
        style={barButtonStyle(false)}
      >
        {state.refreshing ? (
          <RefreshCw size={14} style={{ opacity: 0.6 }} />
        ) : (
          <Cloud size={14} />
        )}
        <span
          style={{
            maxWidth: 160,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {email}
        </span>
      </button>
      {menuOpen && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            background: "#2a2a2a",
            border: "1px solid #3a3a3a",
            borderRadius: 4,
            minWidth: 200,
            boxShadow: "0 8px 20px rgba(0,0,0,0.5)",
            zIndex: 1000,
            padding: "4px 0",
          }}
        >
          <div style={{ padding: "8px 14px", borderBottom: "1px solid #3a3a3a" }}>
            <div style={{ fontSize: 13, color: "#e0e0e0" }}>{email}</div>
            <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
              {state.user?.role} · {state.media.length} cloud asset
              {state.media.length === 1 ? "" : "s"}
            </div>
          </div>
          <MenuRow
            onClick={() => {
              setMenuOpen(false);
              void client.refreshMedia();
            }}
          >
            <RefreshCw size={14} /> Refresh
          </MenuRow>
          <MenuRow
            onClick={() => {
              setMenuOpen(false);
              void client.logout();
            }}
          >
            <LogOut size={14} /> Sign out
          </MenuRow>
        </div>
      )}
    </div>
  );
}

function CloudLoginDialog({
  client,
  onClose,
}: {
  client: CloudClient;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.login(email, password);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      setBusy(false);
    }
  };

  return (
    <div style={overlayStyle} onMouseDown={onClose}>
      <form
        style={dialogStyle}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Cloud size={18} color="#6aa8e0" />
          <h2 style={{ margin: 0, fontSize: 16, color: "#fff" }}>Seam Cloud</h2>
        </div>
        <div style={{ fontSize: 12, color: "#888", wordBreak: "break-all" }}>
          {client.baseUrl}
        </div>
        <label style={labelStyle}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={inputStyle}
          />
        </label>
        {error && <div style={{ color: "#ff6b6b", fontSize: 12 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} style={secondaryButtonStyle}>
            Cancel
          </button>
          <button type="submit" disabled={busy} style={primaryButtonStyle}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}

function MenuRow({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "8px 14px",
        background: "none",
        border: "none",
        color: "#e0e0e0",
        cursor: "pointer",
        fontSize: 13,
        textAlign: "left",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "#3a6ea5")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {children}
    </button>
  );
}

function barButtonStyle(hasError: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "none",
    border: "none",
    color: hasError ? "#ff8a8a" : "#cfcfcf",
    padding: "0 14px",
    height: "100%",
    cursor: "pointer",
    fontSize: 13,
  };
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "grid",
  placeItems: "center",
  zIndex: 2000,
};

const dialogStyle: React.CSSProperties = {
  width: 320,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 24,
  background: "#1f1f1f",
  border: "1px solid #333",
  borderRadius: 10,
  fontFamily: "sans-serif",
};

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "#aaa",
};

const inputStyle: React.CSSProperties = {
  background: "#161616",
  color: "#fff",
  border: "1px solid #333",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 13,
};

const primaryButtonStyle: React.CSSProperties = {
  background: "#3a6ea5",
  border: "1px solid #4a8ed0",
  color: "#fff",
  padding: "8px 16px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid #3a3a3a",
  color: "#cfcfcf",
  padding: "8px 16px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
};
