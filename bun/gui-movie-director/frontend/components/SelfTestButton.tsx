import React, { useState, useRef, useEffect } from "react";
import { useSchemaDefaults, type SelfTestEntry } from "../hooks/useSchemaDefaults";
import { toast } from "../utils/toast";

interface SelfTestButtonProps {
  action: string;
  onJobStart: (opts: { jobId: string; command: string; isSelfTest?: boolean }) => void;
}

/**
 * Multi-select dropdown showing available self-tests for a given action.
 * Check tests to select, then click "Run (N)" to execute them.
 * Hidden if no tests are available for the action.
 */
export function SelfTestButton({ action, onJobStart }: SelfTestButtonProps) {
  const defaults = useSchemaDefaults(action);
  const tests: SelfTestEntry[] = defaults?.self_tests ?? [];
  const i2iModes: Record<string, { desc: string }> | undefined = defaults?.i2i_self_test_modes;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasTests = tests.length > 0;
  const hasModes = i2iModes && Object.keys(i2iModes).length > 0;

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

  if (!hasTests && !hasModes) return null;

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const runOne = async (testName: string) => {
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
      return true;
    }
    if (data.error) throw new Error(data.error);
    return false;
  };

  const handleRunSelected = async () => {
    const queue = [...selected];
    setOpen(false);
    setSelected(new Set());
    setRunning(true);
    setError(null);
    try {
      for (const name of queue) {
        await runOne(name);
      }
      toast.success(queue.length > 1 ? `${queue.length} self-tests started` : "Self-test started");
    } catch (err) {
      const msg = `Failed: ${err}`;
      setError(msg);
      toast.error(msg);
    } finally {
      setRunning(false);
    }
  };

  const selectedCount = selected.size;

  const renderItems = (items: Array<{ name: string; desc: string }>) =>
    items.map(({ name, desc }) => (
      <label key={name} className="self-test-item self-test-item--check">
        <input
          type="checkbox"
          className="self-test-checkbox"
          checked={selected.has(name)}
          onChange={() => toggle(name)}
        />
        <span className="self-test-item-body">
          <span className="self-test-item-name">{name}</span>
          <span className="self-test-item-desc">{desc}</span>
        </span>
      </label>
    ));

  return (
    <div className="self-test-wrapper" ref={dropdownRef}>
      <button
        type="button"
        className="btn self-test-btn"
        onClick={() => setOpen(!open)}
        disabled={running}
        title="Run built-in self-tests"
      >
        {running ? (
          <><span className="spinner" style={{ width: 12, height: 12 }} /> Testing…</>
        ) : (
          <>🧪 Self-Test{selectedCount > 0 && <span className="self-test-badge">{selectedCount}</span>}</>
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
              {renderItems(tests)}
            </>
          )}
          {hasModes && (
            <>
              {hasTests && (
                <div className="self-test-section-title">I2I Modes</div>
              )}
              {renderItems(
                Object.entries(i2iModes!).map(([name, { desc }]) => ({ name, desc }))
              )}
            </>
          )}
          <div className="self-test-footer">
            <button
              type="button"
              className="btn btn-primary self-test-run-btn"
              disabled={selectedCount === 0}
              onClick={handleRunSelected}
            >
              {selectedCount === 0
                ? "Select tests above"
                : `Run ${selectedCount} test${selectedCount > 1 ? "s" : ""}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
