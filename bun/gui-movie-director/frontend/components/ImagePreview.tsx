import React, { useState, useRef, useCallback, useEffect } from "react";
import { formatBytes, basename } from "../utils/format";
import { CaptionScoreBar, parseCaptionScores } from "./CaptionScoreBar";

type Tab = "run" | "manifest" | "scores";

interface ImagePreviewProps {
  url: string;
  manifest?: Record<string, any> | null;
  run?: Record<string, any> | null;
  manifestPath?: string | null;
  runPath?: string | null;
  caption?: Record<string, any> | null;
  captionPath?: string | null;
  onClose: () => void;
}

// --- Shared helpers ---

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

function ParamValue({ value }: { value: unknown }): React.ReactElement {
  if (value === null || value === undefined) return <span className="jv-null">null</span>;
  if (typeof value === "boolean") return <span className="jv-bool">{String(value)}</span>;
  if (typeof value === "number") return <span className="jv-num">{value}</span>;
  if (typeof value === "string") {
    if (value.startsWith("/") && value.length > 60) {
      return <span className="jv-path" title={value}>{shortPath(value, 2)}</span>;
    }
    if (value.startsWith("http")) {
      return <a className="jv-url" href={value} target="_blank" rel="noopener noreferrer">{value}</a>;
    }
    return <span className="jv-string">{value}</span>;
  }
  if (Array.isArray(value)) {
    return (
      <span className="mf-param-nested">
        [{value.map((item, i) => <span key={i} className="mf-param-array-item"><ParamValue value={item} />{i < value.length - 1 ? ", " : ""}</span>)}]
      </span>
    );
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);
    return (
      <span className="mf-param-nested">
        {"{"}
        {entries.map(([k, v], i) => (
          <span key={k} className="mf-param-obj-entry">
            <span className="jv-key">{k}</span>: <ParamValue value={v} />{i < entries.length - 1 ? ", " : ""}
          </span>
        ))}
        {"}"}
      </span>
    );
  }
  return <span className="jv-string">{String(value)}</span>;
}

function ParamGrid({ data, keys }: { data: Record<string, any>; keys?: string[] }) {
  const entries = keys
    ? keys.filter((k) => data[k] !== undefined && data[k] !== null).map((k) => [k, data[k]])
    : Object.entries(data).filter(([, v]) => v !== null && v !== undefined);

  return (
    <div className="mf-param-grid">
      {entries.map(([key, val]) => (
        <div key={key} className="mf-param-row">
          <span className="mf-param-key">{key.replace(/_/g, " ")}</span>
          <ParamValue value={val} />
        </div>
      ))}
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
          <ParamGrid data={extras} />
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
            <ParamGrid data={extras} />
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
          <ParamGrid data={extras} />
        </Section>
      )}
    </div>
  );
}

// --- Media type detection ---

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url);
}

function ScoresViewer({ caption }: { caption: Record<string, any> }) {
  const scores = parseCaptionScores(caption.caption);
  if (!scores) {
    return (
      <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 13 }}>
        No scores available. Raw caption: {String(caption.caption).slice(0, 200)}
      </div>
    );
  }
  return (
    <div style={{ padding: 16 }}>
      <CaptionScoreBar
        scores={scores}
        issues={scores.issues}
        strengths={scores.strengths}
        captured={scores.captured}
        missed={scores.missed}
        summary={scores.summary}
      />
    </div>
  );
}

// --- Main component ---

export function ImagePreview({ url, manifest, run, manifestPath, runPath, caption, captionPath, onClose }: ImagePreviewProps) {
  const hasRun = !!run;
  const hasManifest = !!manifest;
  const hasCaption = !!caption;
  const [tab, setTab] = useState<Tab>(hasRun ? "run" : hasManifest ? "manifest" : "scores");
  const [showRaw, setShowRaw] = useState(false);
  const [rawCopied, setRawCopied] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const data = tab === "run" ? run : manifest;
  const activePath = tab === "run" ? runPath : tab === "manifest" ? manifestPath : captionPath;

  // Zoom / pan state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const didDrag = useRef(false);

  // Reset zoom/pan when url changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [url]);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1 || e.button !== 0) return;
    e.preventDefault();
    didDrag.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    setIsPanning(true);
  }, [zoom, pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag.current = true;
    setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
  }, [isPanning]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const handleDoubleClick = useCallback(() => {
    resetView();
  }, [resetView]);

  // Close overlay only if not zoomed and not dragging
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    if (zoom !== 1 || isPanning || didDrag.current) {
      didDrag.current = false;
      return;
    }
    onClose();
  }, [zoom, onClose]);

  const cursorClass = zoom > 1 ? (isPanning ? "panning" : "zoomed") : "";

  const handleCopyRaw = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setRawCopied(true);
      setTimeout(() => setRawCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const handleCopyPath = async () => {
    if (!activePath) return;
    try {
      await navigator.clipboard.writeText(activePath);
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  return (
    <div className="image-preview-overlay" onClick={handleOverlayClick}>
      <div
        className={`image-preview-content ${cursorClass}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      >
        {isVideoUrl(url) ? (
          <video
            src={url}
            controls
            loop
            autoPlay
            className="preview-media"
            style={{ transform }}
          />
        ) : (
          <img
            src={url}
            alt="Preview"
            className="preview-media"
            style={{ transform }}
          />
        )}
        <div className="zoom-toolbar" onMouseDown={(e) => e.stopPropagation()}>
          {[1, 2, 4].map((level) => (
            <button
              key={level}
              className={`zoom-btn ${zoom === level ? "active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setZoom(level);
                if (level === 1) setPan({ x: 0, y: 0 });
              }}
            >
              {level}×
            </button>
          ))}
        </div>
      </div>
      <div className="image-preview-panel" onClick={(e) => e.stopPropagation()}>
        <div className="image-preview-panel-header">
          <div className="image-preview-panel-tabs">
            <button
              className={`image-preview-tab ${tab === "run" ? "active" : ""} ${!hasRun ? "disabled" : ""}`}
              onClick={() => { setTab("run"); setShowRaw(false); }}
              disabled={!hasRun}
            >
              run.json
            </button>
            <button
              className={`image-preview-tab ${tab === "manifest" ? "active" : ""} ${!hasManifest ? "disabled" : ""}`}
              onClick={() => { setTab("manifest"); setShowRaw(false); }}
              disabled={!hasManifest}
            >
              manifest.json
            </button>
            <button
              className={`image-preview-tab ${tab === "scores" ? "active" : ""} ${!hasCaption ? "disabled" : ""}`}
              onClick={() => { setTab("scores"); setShowRaw(false); }}
              disabled={!hasCaption}
            >
              Scores
            </button>
          </div>
          <div className="image-preview-panel-actions">
            <button
              className="image-preview-raw-btn"
              onClick={() => setShowRaw(true)}
              disabled={!data}
            >📋 Raw</button>
            <button
              className="image-preview-raw-btn"
              onClick={handleCopyPath}
              disabled={!activePath}
              title={activePath || "No JSON file"}
            >{pathCopied ? "✓ Copied" : "📁 Path"}</button>
            <button className="image-preview-panel-close" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="image-preview-panel-body">
          {tab === "scores" && caption ? (
            <ScoresViewer caption={caption} />
          ) : data ? (
            tab === "run" ? <RunViewer data={data} /> : <ManifestViewer data={data} />
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">📄</div>
              <div className="empty-state-text">No {tab}.json found for this image.</div>
            </div>
          )}
        </div>
        {showRaw && data && (
          <div className="mf-raw-modal-backdrop" onClick={() => setShowRaw(false)}>
            <div className="mf-raw-modal" onClick={(e) => e.stopPropagation()}>
              <div className="mf-raw-modal-header">
                <span className="mf-raw-modal-title">{tab}.json</span>
                <div className="mf-raw-modal-actions">
                  <button className="mf-raw-copy-btn" onClick={handleCopyRaw}>
                    {rawCopied ? "✓ Copied" : "📋 Copy"}
                  </button>
                  <button className="mf-raw-close-btn" onClick={() => setShowRaw(false)}>✕</button>
                </div>
              </div>
              <pre className="mf-raw-content">{JSON.stringify(data, null, 2)}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
