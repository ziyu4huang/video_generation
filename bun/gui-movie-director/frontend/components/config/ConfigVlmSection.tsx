import React, { useState } from "react";
import { FormSection } from "../FormSection";
import type { ConfigData, VlmTestResult } from "./types";

interface Props {
  vlmApiUrl: string;
  vlmModel: string;
  config: ConfigData;
  onUpdate: (key: "vlmApiUrl" | "vlmModel", value: string) => void;
}

export function ConfigVlmSection({ vlmApiUrl, vlmModel, config, onUpdate }: Props) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<VlmTestResult | null>(null);

  const handleVlmFieldChange = (key: "vlmApiUrl" | "vlmModel", value: string) => {
    onUpdate(key, value);
    setTestResult(null);
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
      setTestResult(await res.json());
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message || "Test failed" });
    }
    setTesting(false);
  };

  return (
    <FormSection title="VLM (Vision Language Model)">
      <div className="form-row">
        <div className="form-group">
          <label>API URL</label>
          <input
            type="text"
            value={vlmApiUrl}
            onChange={(e) => handleVlmFieldChange("vlmApiUrl", e.target.value)}
            placeholder="http://localhost:1234/v1"
          />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Model Name</label>
          <input
            type="text"
            value={vlmModel}
            onChange={(e) => handleVlmFieldChange("vlmModel", e.target.value)}
            placeholder="qwen/qwen3-vl-4b"
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
                : `⚠️ Connected — model "${vlmModel}" not found (available: ${testResult.models?.join(", ") ?? "none"})`
              : `❌ ${testResult.error}`}
          </span>
        )}
      </div>
    </FormSection>
  );
}
