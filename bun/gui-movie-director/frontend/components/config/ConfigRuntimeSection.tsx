import React, { useState } from "react";
import { FormSection } from "../FormSection";

interface Props {
  pythonPath: string;
  onUpdate: (key: "pythonPath", value: string) => void;
}

export function ConfigRuntimeSection({ pythonPath, onUpdate }: Props) {
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; version?: string; error?: string } | null>(null);

  const handlePythonPathChange = (value: string) => {
    onUpdate("pythonPath", value);
    setVerifyResult(null);
  };

  const handleVerifyPython = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch("/api/config/verify-python", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pythonPath }),
      });
      setVerifyResult(await res.json());
    } catch (e: any) {
      setVerifyResult({ ok: false, error: e.message });
    }
    setVerifying(false);
  };

  return (
    <FormSection title="Runtime">
      <div className="form-row">
        <div className="form-group">
          <label>Python venv binary</label>
          <input
            type="text"
            value={pythonPath}
            onChange={(e) => handlePythonPathChange(e.target.value)}
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
    </FormSection>
  );
}
