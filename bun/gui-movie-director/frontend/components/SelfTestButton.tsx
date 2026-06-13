import React, { useState, useRef, useEffect } from "react";
import { useSchemaDefaults, type SelfTestEntry } from "../hooks/useSchemaDefaults";

interface SelfTestButtonProps {
  action: string;
  onJobStart: (opts: { jobId: string; command: string; isSelfTest?: boolean }) => void;
}

/**
 * Dropdown button showing available self-tests for a given action.
 * Reads test names + I2I modes from server schema-defaults cache.
 * Hidden if no tests are available for the action.
 */
export function SelfTestButton({ action, onJobStart }: SelfTestButtonProps) {
  const defaults = useSchemaDefaults(action);
  const tests: SelfTestEntry[] = defaults?.self_tests ?? [];
  const i2iModes: Record<string, { desc: string }> | undefined = defaults?.i2i_self_test_modes;
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasTests = tests.length > 0;
  const hasModes = i2iModes && Object.keys(i2iModes).length > 0;

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

  // Nothing to show
  if (!hasTests && !hasModes) return null;

  const handleSelect = async (testName: string) => {
    setOpen(false);
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/selftest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, test_name: testName }),
      });
      const data = await res.json();
      if (data.jobId) {
        const isVideo = action.startsWith("video-");
        const command = isVideo
          ? `video ${action.replace("video-", "")}`
          : `image ${action}`;
        onJobStart({ jobId: data.jobId, command, isSelfTest: true });
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
    <div className="self-test-wrapper" ref={dropdownRef}>
      <button
        type="button"
        className="btn self-test-btn"
        onClick={() => setOpen(!open)}
        disabled={running}
        title="Run built-in self-test"
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
        <div className="self-test-dropdown">
          {hasTests && (
            <>
              {hasModes && (
                <div className="self-test-section-title">Built-in Tests</div>
              )}
              {tests.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  className="self-test-item"
                  onClick={() => handleSelect(t.name)}
                >
                  <div className="self-test-item-name">{t.name}</div>
                  <div className="self-test-item-desc">{t.desc}</div>
                </button>
              ))}
            </>
          )}
          {hasModes && (
            <>
              {hasTests && (
                <div className="self-test-section-title">I2I Modes</div>
              )}
              {Object.entries(i2iModes!).map(([mode, { desc }]) => (
                <button
                  key={mode}
                  type="button"
                  className="self-test-item"
                  onClick={() => handleSelect(mode)}
                >
                  <div className="self-test-item-name">{mode}</div>
                  <div className="self-test-item-desc">{desc}</div>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
