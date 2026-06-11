import React, { useState, useEffect } from "react";

interface ConfigData {
  outputDir: string;
  modelsDir: string;
  vlmApiUrl: string;
  vlmModel: string;
  pythonPath: string;
}

const DEFAULTS: ConfigData = {
  outputDir: "python/mlx-movie-director/output",
  modelsDir: "python/mlx-movie-director/models",
  vlmApiUrl: "http://localhost:1234/v1",
  vlmModel: "qwen/qwen3-vl-4b",
  pythonPath: "",
};

interface VlmTestResult {
  ok: boolean;
  error?: string;
  models?: string[];
  modelLoaded?: boolean;
}

interface ModelCheckResult {
  ok: boolean;
  total_models?: number;
  total_disk_human?: string;
  error_count?: number;
  warning_count?: number;
  notice_count?: number;
  htmlUrl?: string | null;
  timestamp?: string;
  error?: string;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function ConfigView() {
  const [config, setConfig] = useState<ConfigData>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<VlmTestResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; version?: string; error?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<ModelCheckResult | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => { setConfig({ ...DEFAULTS, ...data }); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // Load cached model check result on mount
  useEffect(() => {
    fetch("/api/model-check/cache")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && data.result?.summary) {
          const s = data.result.summary;
          setCheckResult({
            ok: true,
            total_models: s.total_models,
            total_disk_human: s.total_disk_human,
            error_count: s.error_count,
            warning_count: s.warning_count,
            notice_count: s.notice_count,
            htmlUrl: data.htmlUrl ?? null,
            timestamp: data.result.timestamp,
          });
        }
      })
      .catch(() => { /* no cache yet */ });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch { /* ignore */ }
    setSaving(false);
  };

  const update = (key: keyof ConfigData, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setTestResult(null);
    if (key === "pythonPath") setVerifyResult(null);
  };

  const handleCheckModels = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await fetch("/api/model-check/run", { method: "POST" });
      const data = await res.json();
      if (data.ok && data.result?.summary) {
        const s = data.result.summary;
        setCheckResult({
          ok: true,
          total_models: s.total_models,
          total_disk_human: s.total_disk_human,
          error_count: s.error_count,
          warning_count: s.warning_count,
          notice_count: s.notice_count,
          htmlUrl: data.htmlUrl,
          timestamp: data.result.timestamp,
        });
      } else {
        setCheckResult({ ok: false, error: data.error || "Check failed" });
      }
    } catch (e: any) {
      setCheckResult({ ok: false, error: e.message || "Network error" });
    }
    setChecking(false);
  };

  const handleVerifyPython = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch("/api/config/verify-python", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pythonPath: config.pythonPath }),
      });
      setVerifyResult(await res.json());
    } catch (e: any) {
      setVerifyResult({ ok: false, error: e.message });
    }
    setVerifying(false);
  };

  const handleTestVlm = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Save config first so the test uses current values
      await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const res = await fetch("/api/vlm/test");
      const data = await res.json();
      setTestResult(data);
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message || "Test failed" });
    }
    setTesting(false);
  };

  // Build model check summary line
  const renderCheckSummary = () => {
    if (!checkResult) return null;
    const r = checkResult;
    const parts: string[] = [];
    const statusClass = !r.ok ? "fail"
      : (r.error_count ?? 0) > 0 ? "fail"
      : (r.warning_count ?? 0) > 0 ? "warn"
      : "ok";

    if (r.ok) {
      const icon = (r.error_count ?? 0) > 0 ? "❌"
        : (r.warning_count ?? 0) > 0 ? "⚠️" : "✅";
      parts.push(`${icon} ${r.total_models} models · ${r.total_disk_human}`);
      if ((r.error_count ?? 0) > 0) parts.push(`${r.error_count} errors`);
      if ((r.warning_count ?? 0) > 0) parts.push(`${r.warning_count} warnings`);
      if ((r.notice_count ?? 0) > 0) parts.push(`${r.notice_count} notices`);
    } else {
      parts.push(`❌ ${r.error}`);
    }

    return (
      <div className="mc-result-panel">
        <div className="mc-result-header">
          <span className={`vlm-test-badge ${statusClass}`}>
            {parts.join(" · ")}
          </span>
          {r.timestamp && (
            <span className="mc-result-time">
              Last checked: {relativeTime(r.timestamp)}
            </span>
          )}
        </div>
        {r.ok && r.htmlUrl && (
          <a
            className="mc-report-link"
            href={r.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            📄 View Full Report
          </a>
        )}
      </div>
    );
  };

  if (loading) {
    return <div className="empty-state"><div className="spinner" style={{ width: 32, height: 32 }} /></div>;
  }

  return (
    <div>
      <h2>⚙️ Configuration</h2>

      <div className="config-form">
        <div className="form-section">
          <div className="form-section-title">Paths (relative to repo root)</div>
          <div className="form-row">
            <div className="form-group">
              <label>Output Directory</label>
              <input
                type="text"
                value={config.outputDir}
                onChange={(e) => update("outputDir", e.target.value)}
                placeholder={DEFAULTS.outputDir}
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Models Directory</label>
              <input
                type="text"
                value={config.modelsDir}
                onChange={(e) => update("modelsDir", e.target.value)}
                placeholder={DEFAULTS.modelsDir}
              />
            </div>
          </div>
          <div className="form-row" style={{ alignItems: "center", gap: 12 }}>
            <button
              className="btn btn-secondary"
              onClick={handleCheckModels}
              disabled={checking}
              style={{ whiteSpace: "nowrap" }}
            >
              {checking ? "⏳ Scanning…" : "📦 Check Models"}
            </button>
            {checking && <div className="spinner" style={{ width: 18, height: 18 }} />}
          </div>
          {renderCheckSummary()}
        </div>

        <div className="form-section">
          <div className="form-section-title">Runtime</div>
          <div className="form-row">
            <div className="form-group">
              <label>Python venv binary</label>
              <input
                type="text"
                value={config.pythonPath}
                onChange={(e) => update("pythonPath", e.target.value)}
                placeholder="/path/to/python/venv/bin/python"
              />
            </div>
          </div>
          <div className="form-row" style={{ alignItems: "center", gap: 12 }}>
            <button
              className="btn btn-secondary"
              onClick={handleVerifyPython}
              disabled={verifying}
              style={{ whiteSpace: "nowrap" }}
            >
              {verifying ? "⏳ Verifying…" : "🔍 Verify"}
            </button>
            {verifyResult && (
              <span className={`vlm-test-badge ${verifyResult.ok ? "ok" : "fail"}`}>
                {verifyResult.ok
                  ? `✅ mlx.core OK (Python ${verifyResult.version})`
                  : `❌ ${verifyResult.error}`}
              </span>
            )}
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">VLM (Vision Language Model)</div>
          <div className="form-row">
            <div className="form-group">
              <label>API URL</label>
              <input
                type="text"
                value={config.vlmApiUrl}
                onChange={(e) => update("vlmApiUrl", e.target.value)}
                placeholder={DEFAULTS.vlmApiUrl}
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Model Name</label>
              <input
                type="text"
                value={config.vlmModel}
                onChange={(e) => update("vlmModel", e.target.value)}
                placeholder={DEFAULTS.vlmModel}
              />
            </div>
          </div>
          <div className="form-row" style={{ alignItems: "center", gap: 12 }}>
            <button
              className="btn btn-secondary"
              onClick={handleTestVlm}
              disabled={testing}
              style={{ whiteSpace: "nowrap" }}
            >
              {testing ? "⏳ Testing…" : "🔧 Test Connection"}
            </button>
            {testResult && (
              <span className={`vlm-test-badge ${testResult.ok ? (testResult.modelLoaded ? "ok" : "warn") : "fail"}`}>
                {testResult.ok
                  ? testResult.modelLoaded
                    ? `✅ Model loaded (${testResult.models?.length ?? 0} models available)`
                    : `⚠️ Connected — model "${config.vlmModel}" not found (available: ${testResult.models?.join(", ") ?? "none"})`
                  : `❌ ${testResult.error}`}
              </span>
            )}
          </div>
        </div>

        <div className="btn-row">
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : saved ? "✓ Saved" : "Save Configuration"}
          </button>
        </div>
      </div>
    </div>
  );
}
