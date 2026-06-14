import React, { useState, useEffect } from "react";
import type { ConfigData } from "./config/types";
import { CONFIG_DEFAULTS } from "./config/types";
import { ConfigPathsSection } from "./config/ConfigPathsSection";
import { ConfigRuntimeSection } from "./config/ConfigRuntimeSection";
import { ConfigVlmSection } from "./config/ConfigVlmSection";
import { SkeletonFormSection } from "./Skeleton";

export function ConfigView() {
  const [config, setConfig] = useState<ConfigData>(CONFIG_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => { setConfig({ ...CONFIG_DEFAULTS, ...data }); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const update = (key: keyof ConfigData, value: string | string[]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

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

  if (loading) {
    return (
      <div style={{ padding: "0 4px" }}>
        <div style={{ height: 28, marginBottom: 20 }} />
        <SkeletonFormSection />
        <div style={{ marginTop: 16 }}><SkeletonFormSection /></div>
        <div style={{ marginTop: 16 }}><SkeletonFormSection /></div>
      </div>
    );
  }

  return (
    <div>
      <h2>⚙️ Configuration</h2>

      <div className="config-form">
        <ConfigPathsSection
          outputDir={config.outputDir}
          modelsDir={config.modelsDir}
          onUpdate={update}
        />
        <ConfigRuntimeSection
          pythonPath={config.pythonPath}
          onUpdate={update}
        />
        <ConfigVlmSection
          vlmApiUrl={config.vlmApiUrl}
          vlmModel={config.vlmModel}
          config={config}
          onUpdate={update}
        />

        <div className="btn-row">
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : saved ? "✓ Saved" : "Save Configuration"}
          </button>
        </div>
      </div>
    </div>
  );
}
