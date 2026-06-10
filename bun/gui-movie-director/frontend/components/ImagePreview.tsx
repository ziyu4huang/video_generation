import React from "react";

interface ImagePreviewProps {
  url: string;
  manifest?: Record<string, any> | null;
  onClose: () => void;
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
      <span style={{ color: "var(--text-dim)", fontSize: 12, minWidth: 80, flexShrink: 0 }}>{label}</span>
      <span style={{ color: "var(--text)", fontSize: 12, wordBreak: "break-word" }}>{value}</span>
    </div>
  );
}

export function ImagePreview({ url, manifest, onClose }: ImagePreviewProps) {
  return (
    <div className="image-preview-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <button className="image-preview-close" onClick={onClose}>✕</button>
      <div className="image-preview-content">
        <img src={url} alt="Preview" />
      </div>
      {manifest && (
        <div style={{
          width: 280,
          minWidth: 280,
          background: "var(--bg-surface)",
          borderLeft: "1px solid var(--border)",
          padding: 20,
          overflowY: "auto",
          color: "var(--text)",
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-bright)", marginBottom: 16 }}>
            Metadata
          </div>

          {manifest.command && <MetaRow label="Command" value={manifest.command} />}
          {manifest.prompt && (
            <MetaRow label="Prompt" value={
              <span style={{ maxHeight: 120, overflow: "auto", display: "block" }}>
                {manifest.prompt}
              </span>
            } />
          )}
          {manifest.seed != null && <MetaRow label="Seed" value={String(manifest.seed)} />}
          {manifest.steps != null && <MetaRow label="Steps" value={String(manifest.steps)} />}
          {manifest.pipeline && <MetaRow label="Pipeline" value={manifest.pipeline} />}
          {manifest.width && manifest.height && <MetaRow label="Resolution" value={`${manifest.width}×${manifest.height}`} />}
          {manifest.lora && <MetaRow label="LoRA" value={manifest.lora} />}
          {manifest.lora_scale != null && <MetaRow label="LoRA Scale" value={String(manifest.lora_scale)} />}
          {manifest.denoise_strength != null && <MetaRow label="Denoise" value={String(manifest.denoise_strength)} />}
          {manifest.controlnet_type && <MetaRow label="ControlNet" value={manifest.controlnet_type} />}
          {manifest.controlnet_strength != null && <MetaRow label="CN Strength" value={String(manifest.controlnet_strength)} />}
          {manifest.elapsed_seconds != null && (
            <MetaRow label="Time" value={`${manifest.elapsed_seconds.toFixed(1)}s`} />
          )}
          {manifest.timestamp && <MetaRow label="Created" value={new Date(manifest.timestamp).toLocaleString()} />}

          {/* Show any extra manifest keys not explicitly handled */}
          {Object.entries(manifest)
            .filter(([k]) => !["command", "prompt", "seed", "steps", "pipeline", "width", "height",
              "lora", "lora_scale", "denoise_strength", "controlnet_type", "controlnet_strength",
              "elapsed_seconds", "timestamp", "input_hash"].includes(k))
            .map(([k, v]) => (
              <MetaRow key={k} label={k} value={typeof v === "object" ? JSON.stringify(v) : String(v)} />
            ))
          }
        </div>
      )}
    </div>
  );
}
