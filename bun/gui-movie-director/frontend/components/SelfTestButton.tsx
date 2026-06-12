import React, { useState, useRef, useEffect } from "react";
import { useSchemaDefaults, type SelfTestEntry } from "../hooks/useSchemaDefaults";

interface SelfTestButtonProps {
  action: string;
  onJobStart: (opts: { jobId: string; command: string }) => void;
}

/**
 * Dropdown button that shows available self-tests for a given action.
 * Reads test names from server schema-defaults cache.
 * Hidden if no tests are available for the action.
 */
export function SelfTestButton({ action, onJobStart }: SelfTestButtonProps) {
  const defaults = useSchemaDefaults(action);
  const tests: SelfTestEntry[] = defaults?.self_tests ?? [];
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // No tests available — don't render
  if (tests.length === 0) return null;

  const handleSelect = async (test: SelfTestEntry) => {
    setOpen(false);
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/selftest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, test_name: test.name }),
      });
      const data = await res.json();
      if (data.jobId) {
        const isVideo = action.startsWith("video-");
        const command = isVideo
          ? `video ${action.replace("video-", "")}`
          : `image ${action}`;
        onJobStart({ jobId: data.jobId, command });
      } else if (data.error) {
        setError(data.error);
      }
    } catch (err) {
      setError(`Failed: ${err}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ position: "relative" }} ref={dropdownRef}>
      <button
        type="button"
        className="btn"
        onClick={() => setOpen(!open)}
        disabled={running}
        title="Run built-in self-test"
        style={{ fontSize: 12, padding: "6px 14px", whiteSpace: "nowrap" }}
      >
        {running ? (
          <><span className="spinner" style={{ width: 12, height: 12 }} /> Testing…</>
        ) : (
          "🧪 Self-Test"
        )}
      </button>

      {error && (
        <span style={{ marginLeft: 8, fontSize: 12, color: "var(--error)" }}>
          {error}
        </span>
      )}

      {open && (
        <div
          className="st-dropdown"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            minWidth: 280,
            maxHeight: 320,
            overflowY: "auto",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            zIndex: 50,
          }}
        >
          {tests.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => handleSelect(t)}
              style={{
                display: "block",
                width: "100%",
                padding: "8px 12px",
                background: "transparent",
                border: "none",
                borderBottom: "1px solid var(--border)",
                color: "var(--text)",
                textAlign: "left",
                cursor: "pointer",
                fontSize: 12,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
              }}
            >
              <div style={{ fontWeight: 500, color: "var(--text-bright)" }}>{t.name}</div>
              <div style={{ color: "var(--text-dim)", marginTop: 2, lineHeight: 1.3 }}>
                {t.desc}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
