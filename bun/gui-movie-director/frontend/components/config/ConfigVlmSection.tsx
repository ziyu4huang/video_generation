import React, { useState } from "react";
import { FormSection } from "../FormSection";
import type { ConfigData, VlmTestResult } from "./types";
import { putConfig, testVlm } from "../../api/config";

function shortModelName(id?: string): string {
  if (!id) return "unknown";
  if (id.includes("gemma")) return "Gemma 26B";
  if (id.includes("qwen3-vl-4b")) return "Qwen 4B";
  return id.split("/").pop() || id;
}

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
      await putConfig(config);
      setTestResult(await testVlm());
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
            placeholder="auto"
          />
          <small style={{ color: "var(--text-dim)", fontSize: 11 }}>
            <code>auto</code> (default) = use the best loaded VLM (prefers Gemma 26B
            when loaded, else Qwen 4B). Or paste a specific id (e.g. <code>google/gemma-4-26b-a4b-qat</code>) to force it.
          </small>
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
                ? vlmModel.trim().toLowerCase() === "auto" || vlmModel.trim() === ""
                  ? `✅ Auto → ${shortModelName(testResult.activeModel)}${testResult.willLoad ? " (will load)" : " ✓ loaded"}`
                  : `✅ Model loaded: ${shortModelName(testResult.activeModel)}`
                : `⚠️ Connected — model "${vlmModel}" not loaded (loaded: ${testResult.loadedModels?.join(", ") || "none"})`
              : `❌ ${testResult.error}`}
          </span>
        )}
      </div>
    </FormSection>
  );
}
