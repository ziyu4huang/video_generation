import React, { useState } from "react";
import { JsonViewer } from "./JsonViewer";

type Tab = "run" | "manifest";

interface ImagePreviewProps {
  url: string;
  manifest?: Record<string, any> | null;
  run?: Record<string, any> | null;
  onClose: () => void;
}

// --- Shared helpers ---

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function shortPath(p: string, segments: number = 2): string {
  const parts = p.split("/");
  if (parts.length <= segments + 1) return p;
  return "…/" + parts.slice(-(segments + 1)).join("/");
}

// --- Section components ---

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mf-section">
      <div className="mf-section-title">{title}</div>
      <div className="mf-section-body">{children}</div>
    </div>
  );
}

function StatusBadge({ status, elapsed, memoryPeakMb }: {
  status: string;
  elapsed?: number;
  memoryPeakMb?: number;
}) {
  const ok = status === "success";
  return (
    <div className="mf-status-row">
      <span className={`mf-status-badge ${ok ? "success" : "failed"}`}>
        <span className="mf-status-dot" />
        {status}
      </span>
      {elapsed != null && <span className="mf-status-meta">{elapsed.toFixed(1)}s</span>}
      {memoryPeakMb != null && <span className="mf-status-meta">{formatBytes(memoryPeakMb * 1024 * 1024)}</span>}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };
  return (
    <button className="mf-copy-btn" onClick={handleCopy}>
      {copied ? "✓ Copied" : "📋 Copy"}
    </button>
  );
}

function ModelDetail({ name, info, onClose }: { name: string; info: Record<string, any>; onClose: () => void }) {
  return (
    <div className="mf-model-detail-backdrop" onClick={onClose}>
      <div className="mf-model-detail" onClick={(e) => e.stopPropagation()}>
        <div className="mf-model-detail-header">
          <span className="mf-model-detail-name">{name}</span>
          <button className="mf-model-detail-close" onClick={onClose}>✕</button>
        </div>
        <div className="mf-model-detail-body">
          {info.path && (
            <div className="mf-detail-row">
              <span className="mf-detail-label">path</span>
              <div className="mf-detail-path-row">
                <span className="mf-detail-value mono">{info.path}</span>
                <CopyButton text={info.path} />
              </div>
            </div>
          )}
          {info.realpath && info.realpath !== info.path && (
            <div className="mf-detail-row">
              <span className="mf-detail-label">real path</span>
              <div className="mf-detail-path-row">
                <span className="mf-detail-value mono">{info.realpath}</span>
                <CopyButton text={info.realpath} />
              </div>
            </div>
          )}
          {info.size_bytes != null && (
            <div className="mf-detail-row">
              <span className="mf-detail-label">size</span>
              <span className="mf-detail-value">{formatBytes(info.size_bytes)} <span className="mf-detail-dim">({info.size_bytes.toLocaleString()} bytes)</span></span>
            </div>
          )}
          {info.md5_partial && (
            <div className="mf-detail-row">
              <span className="mf-detail-label">md5</span>
              <span className="mf-detail-value mono">{info.md5_partial}</span>
            </div>
          )}
          {info.error && (
            <div className="mf-detail-row">
              <span className="mf-detail-label">error</span>
              <span className="mf-detail-value err">{info.error}</span>
            </div>
          )}
          {/* Show any extra keys */}
          {Object.entries(info)
            .filter(([k]) => !["path", "realpath", "size_bytes", "md5_partial", "error"].includes(k))
            .map(([k, v]) => (
              <div key={k} className="mf-detail-row">
                <span className="mf-detail-label">{k}</span>
                <span className="mf-detail-value">{String(v)}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function ModelTable({ models }: { models: Record<string, any> }) {
  const [selected, setSelected] = useState<{ name: string; info: any } | null>(null);

  return (
    <div className="mf-model-table">
      {Object.entries(models).map(([name, info]: [string, any]) => {
        const hasError = !!info.error;
        return (
          <div
            key={name}
            className={`mf-model-row ${hasError ? "error" : ""}`}
            onClick={() => setSelected({ name, info })}
          >
            <span className="mf-model-name">{name}</span>
            <span className="mf-model-size">
              {info.size_bytes ? formatBytes(info.size_bytes) : "—"}
            </span>
            <span className={`mf-model-status ${hasError ? "err" : "ok"}`}>
              {hasError ? info.error : "✓"}
            </span>
            <span className="mf-model-expand">▸</span>
          </div>
        );
      })}
      {selected && (
        <ModelDetail
          name={selected.name}
          info={selected.info}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function TimingsList({ timings }: { timings: Record<string, any> }) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const entries = Object.entries(timings).filter(([k]) => k !== "denoising_step_times");

  return (
    <div className="mf-timings">
      {entries.map(([key, val]) => {
        const label = key.replace(/_seconds$/, "").replace(/_/g, " ");
        return (
          <div key={key} className="mf-timing-row">
            <span className="mf-timing-label">{label}</span>
            <span className="mf-timing-value">{typeof val === "number" ? `${val.toFixed(2)}s` : String(val)}</span>
          </div>
        );
      })}
      {timings.denoising_step_times && (
        <div className="mf-timing-steps">
          <span className="mf-timing-toggle" onClick={() => setStepsOpen(!stepsOpen)}>
            {stepsOpen ? "▾" : "▸"} {timings.denoising_step_times.length} denoising steps
          </span>
          {stepsOpen && (
            <div className="mf-timing-step-list">
              {timings.denoising_step_times.map((t: number, i: number) => (
                <div key={i} className="mf-timing-row indent">
                  <span className="mf-timing-label">step {i}</span>
                  <span className="mf-timing-value">{t.toFixed(2)}s</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PromptBlock({ prompt }: { prompt: string }) {
  return <div className="mf-prompt">{prompt}</div>;
}

function ParamGrid({ data, keys }: { data: Record<string, any>; keys?: string[] }) {
  const entries = keys
    ? keys.filter((k) => data[k] !== undefined && data[k] !== null).map((k) => [k, data[k]])
    : Object.entries(data).filter(([, v]) => v !== null && v !== undefined);

  return (
    <div className="mf-param-grid">
      {entries.map(([key, val]) => {
        let display: string;
        if (typeof val === "number") display = String(val);
        else if (typeof val === "boolean") display = val ? "yes" : "no";
        else if (typeof val === "string") {
          // Shorten paths
          if (val.startsWith("/") && val.length > 60) {
            display = shortPath(val, 2);
          } else {
            display = val;
          }
        } else {
          display = JSON.stringify(val);
        }
        return (
          <div key={key} className="mf-param-row">
            <span className="mf-param-key">{key.replace(/_/g, " ")}</span>
            <span className="mf-param-val" title={typeof val === "string" ? val : undefined}>{display}</span>
          </div>
        );
      })}
    </div>
  );
}

// --- Structured viewers ---

function RunViewer({ data }: { data: Record<string, any> }) {
  // Collect known keys for sections, rest goes to fallback
  const usedKeys = new Set<string>();
  const extras: Record<string, any> = {};

  // Command section
  const cmdParts = [data.command, data.action, data.pipeline].filter(Boolean);
  usedKeys.add("command"); usedKeys.add("action"); usedKeys.add("pipeline");

  // Prompt
  const hasPrompt = !!data.prompt;
  if (hasPrompt) usedKeys.add("prompt");

  // Core params
  const paramKeys = [
    "seed", "steps", "width", "height", "scale",
    "lora_path", "lora_scale", "lora",
    "controlnet_type", "controlnet_strength",
    "denoise_strength", "ref_count",
    "input_image", "skip_preprocess", "thin_lines", "blur_ref", "remove_outlines",
  ];
  const hasParams = paramKeys.some((k) => data[k] !== undefined && data[k] !== null);
  paramKeys.forEach((k) => { if (data[k] !== undefined) usedKeys.add(k); });

  // Collect extras
  Object.entries(data).forEach(([k, v]) => {
    if (!usedKeys.has(k)) extras[k] = v;
  });

  return (
    <div className="manifest-viewer">
      {cmdParts.length > 0 && (
        <Section title="Command">
          <div className="mf-command-line">{cmdParts.join(" · ")}</div>
        </Section>
      )}
      {hasPrompt && (
        <Section title="Prompt">
          <PromptBlock prompt={data.prompt} />
        </Section>
      )}
      {hasParams && (
        <Section title="Parameters">
          <ParamGrid data={data} keys={paramKeys} />
        </Section>
      )}
      {Object.keys(extras).length > 0 && (
        <Section title="Details">
          <JsonViewer data={extras} defaultOpen={1} />
        </Section>
      )}
    </div>
  );
}

function ManifestViewer({ data }: { data: Record<string, any> }) {
  const isNewFormat = !!data.status || !!data.models;
  const usedKeys = new Set<string>();
  const extras: Record<string, any> = {};

  if (isNewFormat) {
    // --- New format: status, models, timings, output ---
    if (data.status) usedKeys.add("status");
    if (data.elapsed_seconds != null) usedKeys.add("elapsed_seconds");
    if (data.memory_peak_mb != null) usedKeys.add("memory_peak_mb");
    if (data.start_time) usedKeys.add("start_time");
    if (data.end_time) usedKeys.add("end_time");
    if (data.run_file) usedKeys.add("run_file");
    if (data.models) usedKeys.add("models");
    if (data.timings) usedKeys.add("timings");
    if (data.output_files) usedKeys.add("output_files");
    if (data.error !== undefined) usedKeys.add("error");

    Object.entries(data).forEach(([k, v]) => {
      if (!usedKeys.has(k)) extras[k] = v;
    });

    return (
      <div className="manifest-viewer">
        <Section title="Status">
          <StatusBadge
            status={data.status || "unknown"}
            elapsed={data.elapsed_seconds}
            memoryPeakMb={data.memory_peak_mb}
          />
        </Section>
        {data.models && (
          <Section title="Models">
            <ModelTable models={data.models} />
          </Section>
        )}
        {data.timings && (
          <Section title="Timings">
            <TimingsList timings={data.timings} />
          </Section>
        )}
        {data.output_files && data.output_files.length > 0 && (
          <Section title="Output">
            {data.output_files.map((f: any, i: number) => (
              <div key={i} className="mf-output-row">
                {f.width && f.height && <span className="mf-output-meta">{f.width}×{f.height}</span>}
                {f.size_bytes && <span className="mf-output-meta">{formatBytes(f.size_bytes)}</span>}
                {f.seed != null && <span className="mf-output-meta">seed {f.seed}</span>}
                {f.label && <span className="mf-output-label">{f.label}</span>}
              </div>
            ))}
          </Section>
        )}
        {Object.keys(extras).length > 0 && (
          <Section title="Details">
            <JsonViewer data={extras} defaultOpen={1} />
          </Section>
        )}
      </div>
    );
  }

  // --- Old format: command, method, prompt, params ---
  if (data.command) usedKeys.add("command");
  if (data.method) usedKeys.add("method");
  if (data.timestamp) usedKeys.add("timestamp");
  if (data.prompt) usedKeys.add("prompt");
  const paramKeys = [
    "seed", "steps", "ref_count", "lora_path", "lora_scale",
    "input_image", "output", "elapsed_seconds",
  ];
  paramKeys.forEach((k) => { if (data[k] !== undefined) usedKeys.add(k); });
  if (data.outputs) usedKeys.add("outputs");

  Object.entries(data).forEach(([k, v]) => {
    if (!usedKeys.has(k)) extras[k] = v;
  });

  return (
    <div className="manifest-viewer">
      {(data.command || data.method) && (
        <Section title="Command">
          <div className="mf-command-line">
            {[data.command, data.method].filter(Boolean).join(" · ")}
          </div>
        </Section>
      )}
      {data.prompt && (
        <Section title="Prompt">
          <PromptBlock prompt={data.prompt} />
        </Section>
      )}
      <Section title="Parameters">
        <ParamGrid data={data} keys={paramKeys} />
      </Section>
      {Object.keys(extras).length > 0 && (
        <Section title="Details">
          <JsonViewer data={extras} defaultOpen={1} />
        </Section>
      )}
    </div>
  );
}

// --- Main component ---

export function ImagePreview({ url, manifest, run, onClose }: ImagePreviewProps) {
  const hasRun = !!run;
  const hasManifest = !!manifest;
  const [tab, setTab] = useState<Tab>(hasRun ? "run" : "manifest");
  const data = tab === "run" ? run : manifest;

  return (
    <div className="image-preview-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="image-preview-content">
        <img src={url} alt="Preview" />
      </div>
      <div className="image-preview-panel" onClick={(e) => e.stopPropagation()}>
        <div className="image-preview-panel-header">
          <div className="image-preview-panel-tabs">
            <button
              className={`image-preview-tab ${tab === "run" ? "active" : ""} ${!hasRun ? "disabled" : ""}`}
              onClick={() => hasRun && setTab("run")}
              disabled={!hasRun}
            >
              run.json
            </button>
            <button
              className={`image-preview-tab ${tab === "manifest" ? "active" : ""} ${!hasManifest ? "disabled" : ""}`}
              onClick={() => hasManifest && setTab("manifest")}
              disabled={!hasManifest}
            >
              manifest.json
            </button>
          </div>
          <button className="image-preview-panel-close" onClick={onClose}>✕</button>
        </div>
        <div className="image-preview-panel-body">
          {data ? (
            tab === "run" ? <RunViewer data={data} /> : <ManifestViewer data={data} />
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">📄</div>
              <div className="empty-state-text">No {tab}.json found for this image.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
