import React, { useState } from "react";
import { useSchemaDefaults, type SelfTestEntry } from "../hooks/useSchemaDefaults";
import { toast } from "../utils/toast";

interface SelfTestButtonProps {
  action: string;
  onJobStart: (opts: { jobId: string; command: string; isSelfTest?: boolean }) => void;
}

/**
 * Trigger button that opens a modal to select and run built-in self-tests.
 * Hidden when no tests are available for the action.
 */
export function SelfTestButton({ action, onJobStart }: SelfTestButtonProps) {
  const defaults = useSchemaDefaults(action);
  const tests: SelfTestEntry[] = defaults?.self_tests ?? [];
  const i2iModes: Record<string, { desc: string }> | undefined = defaults?.i2i_self_test_modes;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasTests = tests.length > 0;
  const hasModes = i2iModes && Object.keys(i2iModes).length > 0;

  if (!hasTests && !hasModes) return null;

  const allItems: Array<{ name: string; desc: string; section: string | null }> = [
    ...(hasTests
      ? tests.map((t) => ({ name: t.name, desc: t.desc, section: hasModes ? "Built-in Tests" : null }))
      : []),
    ...(hasModes
      ? Object.entries(i2iModes!).map(([name, { desc }]) => ({
          name,
          desc,
          section: hasTests ? "I2I Modes" : null,
        }))
      : []),
  ];

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const allSelected = allItems.length > 0 && allItems.every((i) => selected.has(i.name));
  const selectAll = () => setSelected(new Set(allItems.map((i) => i.name)));
  const selectNone = () => setSelected(new Set());

  const runOne = async (testName: string) => {
    const res = await fetch("/api/selftest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, test_name: testName }),
    });
    const data = await res.json();
    if (data.jobId) {
      const isVideo = action.startsWith("video-");
      const command = isVideo ? `video ${action.replace("video-", "")}` : `image ${action}`;
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

  const handleOverlayMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) setOpen(false);
  };

  const selectedCount = selected.size;
  let lastSection: string | null = null;

  return (
    <>
      <button
        type="button"
        className="btn self-test-trigger-btn"
        onClick={() => setOpen(true)}
        disabled={running}
        title="Run built-in self-tests"
      >
        {running ? (
          <>
            <span className="spinner" style={{ width: 12, height: 12 }} /> Testing…
          </>
        ) : (
          <>
            🧪 Self-Test
            {selectedCount > 0 && <span className="self-test-badge">{selectedCount}</span>}
          </>
        )}
      </button>

      {error && (
        <span style={{ fontSize: 12, color: "var(--error)", marginLeft: 8 }}>{error}</span>
      )}

      {open && (
        <div className="self-test-overlay" onMouseDown={handleOverlayMouseDown}>
          <div className="self-test-modal">
            {/* Header */}
            <div className="self-test-modal-header">
              <div>
                <div className="self-test-modal-title">🧪 Self-Test Suite</div>
                <div className="self-test-modal-subtitle">
                  Select tests to run for <code style={{ fontSize: 12 }}>{action}</code>
                </div>
              </div>
              <button
                type="button"
                className="self-test-modal-close"
                onClick={() => setOpen(false)}
                title="Close"
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div className="self-test-modal-body">
              {allItems.map(({ name, desc, section }) => {
                const showSection = section !== null && section !== lastSection;
                if (section !== null) lastSection = section;
                return (
                  <React.Fragment key={name}>
                    {showSection && (
                      <div className="self-test-section-title">{section}</div>
                    )}
                    <label
                      className="self-test-modal-item"
                      data-selected={selected.has(name) ? "true" : "false"}
                    >
                      <input
                        type="checkbox"
                        className="self-test-checkbox"
                        checked={selected.has(name)}
                        onChange={() => toggle(name)}
                      />
                      <div className="self-test-modal-item-body">
                        <div className="self-test-item-name">{name}</div>
                        <div className="self-test-item-desc">{desc}</div>
                      </div>
                    </label>
                  </React.Fragment>
                );
              })}
            </div>

            {/* Footer */}
            <div className="self-test-modal-footer">
              <button
                type="button"
                className="self-test-select-all-btn"
                onClick={allSelected ? selectNone : selectAll}
              >
                {allSelected ? "Deselect All" : "Select All"}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={selectedCount === 0}
                onClick={handleRunSelected}
              >
                {selectedCount === 0
                  ? "Select tests above"
                  : `Run ${selectedCount} test${selectedCount > 1 ? "s" : ""} →`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
