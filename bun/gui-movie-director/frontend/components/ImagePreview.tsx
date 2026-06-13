import React, { useState, useRef, useCallback, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { formatBytes, basename } from "../utils/format";
import { CaptionScoreBar, parseCaptionScores } from "./CaptionScoreBar";
import { toast } from "../utils/toast";
import s from "./ImagePreview.module.css";

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
    <div className={s.mfSection}>
      <div className={s.mfSectionTitle}>{title}</div>
      <div className={s.mfSectionBody}>{children}</div>
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
    <div className={s.mfStatusRow}>
      <span className={`${s.mfStatusBadge} ${ok ? s.mfStatusBadgeSuccess : s.mfStatusBadgeFailed}`}>
        <span className={s.mfStatusDot} />
        {status}
      </span>
      {elapsed != null && <span className={s.mfStatusMeta}>{elapsed.toFixed(1)}s</span>}
      {memoryPeakMb != null && <span className={s.mfStatusMeta}>{formatBytes(memoryPeakMb * 1024 * 1024)}</span>}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied!");
    } catch { /* ignore */ }
  };
  return (
    <button className={s.mfCopyBtn} onClick={handleCopy}>
      📋 Copy
    </button>
  );
}

function ModelDetail({ name, info, onClose }: { name: string; info: Record<string, any>; onClose: () => void }) {
  return (
    <div className={s.mfModelDetailBackdrop} onClick={onClose}>
      <div className={s.mfModelDetail} onClick={(e) => e.stopPropagation()}>
        <div className={s.mfModelDetailHeader}>
          <span className={s.mfModelDetailName}>{name}</span>
          <button className={s.mfModelDetailClose} onClick={onClose}>✕</button>
        </div>
        <div className={s.mfModelDetailBody}>
          {info.path && (
            <div className={s.mfDetailRow}>
              <span className={s.mfDetailLabel}>path</span>
              <div className={s.mfDetailPathRow}>
                <span className={`${s.mfDetailValue} ${s.mfDetailValueMono}`}>{info.path}</span>
                <CopyButton text={info.path} />
              </div>
            </div>
          )}
          {info.realpath && info.realpath !== info.path && (
            <div className={s.mfDetailRow}>
              <span className={s.mfDetailLabel}>real path</span>
              <div className={s.mfDetailPathRow}>
                <span className={`${s.mfDetailValue} ${s.mfDetailValueMono}`}>{info.realpath}</span>
                <CopyButton text={info.realpath} />
              </div>
            </div>
          )}
          {info.size_bytes != null && (
            <div className={s.mfDetailRow}>
              <span className={s.mfDetailLabel}>size</span>
              <span className={s.mfDetailValue}>{formatBytes(info.size_bytes)} <span className={s.mfDetailDim}>({info.size_bytes.toLocaleString()} bytes)</span></span>
            </div>
          )}
          {info.md5_partial && (
            <div className={s.mfDetailRow}>
              <span className={s.mfDetailLabel}>md5</span>
              <span className={`${s.mfDetailValue} ${s.mfDetailValueMono}`}>{info.md5_partial}</span>
            </div>
          )}
          {info.error && (
            <div className={s.mfDetailRow}>
              <span className={s.mfDetailLabel}>error</span>
              <span className={`${s.mfDetailValue} ${s.mfDetailValueErr}`}>{info.error}</span>
            </div>
          )}
          {/* Show any extra keys */}
          {Object.entries(info)
            .filter(([k]) => !["path", "realpath", "size_bytes", "md5_partial", "error"].includes(k))
            .map(([k, v]) => (
              <div key={k} className={s.mfDetailRow}>
                <span className={s.mfDetailLabel}>{k}</span>
                <span className={s.mfDetailValue}>{String(v)}</span>
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
    <div className={s.mfModelTable}>
      {Object.entries(models).map(([name, info]: [string, any]) => {
        const hasError = !!info.error;
        return (
          <div
            key={name}
            className={`${s.mfModelRow}${hasError ? " " + s.mfModelRowError : ""}`}
            onClick={() => setSelected({ name, info })}
          >
            <span className={s.mfModelName}>{name}</span>
            <span className={s.mfModelSize}>
              {info.size_bytes ? formatBytes(info.size_bytes) : "—"}
            </span>
            <span className={`${s.mfModelStatus} ${hasError ? s.mfModelStatusErr : s.mfModelStatusOk}`}>
              {hasError ? info.error : "✓"}
            </span>
            <span className={s.mfModelExpand}>▸</span>
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
    <div className={s.mfTimings}>
      {entries.map(([key, val]) => {
        const label = key.replace(/_seconds$/, "").replace(/_/g, " ");
        return (
          <div key={key} className={s.mfTimingRow}>
            <span className={s.mfTimingLabel}>{label}</span>
            <span className={s.mfTimingValue}>{typeof val === "number" ? `${val.toFixed(2)}s` : String(val)}</span>
          </div>
        );
      })}
      {timings.denoising_step_times && (
        <div className={s.mfTimingSteps}>
          <span className={s.mfTimingToggle} onClick={() => setStepsOpen(!stepsOpen)}>
            {stepsOpen ? "▾" : "▸"} {timings.denoising_step_times.length} denoising steps
          </span>
          {stepsOpen && (
            <div className={s.mfTimingStepList}>
              {timings.denoising_step_times.map((t: number, i: number) => (
                <div key={i} className={`${s.mfTimingRow} ${s.mfTimingRowIndent}`}>
                  <span className={s.mfTimingLabel}>step {i}</span>
                  <span className={s.mfTimingValue}>{t.toFixed(2)}s</span>
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
  return <div className={s.mfPrompt}>{prompt}</div>;
}

function ParamValue({ value }: { value: unknown }): React.ReactElement {
  if (value === null || value === undefined) return <span className={s.jvNull}>null</span>;
  if (typeof value === "boolean") return <span className={s.jvBool}>{String(value)}</span>;
  if (typeof value === "number") return <span className={s.jvNum}>{value}</span>;
  if (typeof value === "string") {
    if (value.startsWith("/") && value.length > 60) {
      return <span className={s.jvPath} title={value}>{shortPath(value, 2)}</span>;
    }
    if (value.startsWith("http")) {
      return <a className={s.jvUrl} href={value} target="_blank" rel="noopener noreferrer">{value}</a>;
    }
    return <span className={s.jvString}>{value}</span>;
  }
  if (Array.isArray(value)) {
    return (
      <span>
        [{value.map((item, i) => <span key={i}><ParamValue value={item} />{i < value.length - 1 ? ", " : ""}</span>)}]
      </span>
    );
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);
    return (
      <span>
        {"{"}
        {entries.map(([k, v], i) => (
          <span key={k}>
            <span className={s.jvKey}>{k}</span>: <ParamValue value={v} />{i < entries.length - 1 ? ", " : ""}
          </span>
        ))}
        {"}"}
      </span>
    );
  }
  return <span className={s.jvString}>{String(value)}</span>;
}

function ParamGrid({ data, keys }: { data: Record<string, any>; keys?: string[] }) {
  const entries = keys
    ? keys.filter((k) => data[k] !== undefined && data[k] !== null).map((k) => [k, data[k]])
    : Object.entries(data).filter(([, v]) => v !== null && v !== undefined);

  return (
    <div className={s.mfParamGrid}>
      {entries.map(([key, val]) => (
        <div key={key} className={s.mfParamRow}>
          <span className={s.mfParamKey}>{key.replace(/_/g, " ")}</span>
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
    <div className={s.manifestViewer}>
      {cmdParts.length > 0 && (
        <Section title="Command">
          <div className={s.mfCommandLine}>{cmdParts.join(" · ")}</div>
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
      <div className={s.manifestViewer}>
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
              <div key={i} className={s.mfOutputRow}>
                {f.width && f.height && <span className={s.mfOutputMeta}>{f.width}×{f.height}</span>}
                {f.size_bytes && <span className={s.mfOutputMeta}>{formatBytes(f.size_bytes)}</span>}
                {f.seed != null && <span className={s.mfOutputMeta}>seed {f.seed}</span>}
                {f.label && <span className={s.mfOutputLabel}>{f.label}</span>}
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
    <div className={s.manifestViewer}>
      {(data.command || data.method) && (
        <Section title="Command">
          <div className={s.mfCommandLine}>
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

  const cursorMod = zoom > 1 ? (isPanning ? s.imagePreviewContentPanning : s.imagePreviewContentZoomed) : "";

  const handleCopyRaw = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      toast.success("JSON copied!");
    } catch { /* ignore */ }
  };

  const handleCopyPath = async () => {
    if (!activePath) return;
    try {
      await navigator.clipboard.writeText(activePath);
      toast.success("Path copied!");
    } catch { /* ignore */ }
  };

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  return (
    <Dialog.Root open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
    <Dialog.Content
      className={s.imagePreviewOverlay}
      onClick={handleOverlayClick}
      aria-describedby={undefined}
      onPointerDownOutside={(e) => e.preventDefault()}
      onInteractOutside={(e) => e.preventDefault()}
    >
      <Dialog.Title className="sr-only">Image Preview</Dialog.Title>
      <div
        className={`${s.imagePreviewContent}${cursorMod ? " " + cursorMod : ""}`}
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
            className={s.previewMedia}
            style={{ transform }}
          />
        ) : (
          <img
            src={url}
            alt="Preview"
            className={s.previewMedia}
            style={{ transform }}
          />
        )}
        <div className={s.zoomToolbar} onMouseDown={(e) => e.stopPropagation()}>
          {[1, 2, 4].map((level) => (
            <button
              key={level}
              className={`${s.zoomBtn}${zoom === level ? " " + s.zoomBtnActive : ""}`}
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
      <div className={s.imagePreviewPanel} onClick={(e) => e.stopPropagation()}>
        <div className={s.imagePreviewPanelHeader}>
          <div className={s.imagePreviewPanelTabs}>
            <button
              className={`${s.imagePreviewTab}${tab === "run" ? " " + s.imagePreviewTabActive : ""}${!hasRun ? " " + s.imagePreviewTabDisabled : ""}`}
              onClick={() => { setTab("run"); setShowRaw(false); }}
              disabled={!hasRun}
            >
              run.json
            </button>
            <button
              className={`${s.imagePreviewTab}${tab === "manifest" ? " " + s.imagePreviewTabActive : ""}${!hasManifest ? " " + s.imagePreviewTabDisabled : ""}`}
              onClick={() => { setTab("manifest"); setShowRaw(false); }}
              disabled={!hasManifest}
            >
              manifest.json
            </button>
            <button
              className={`${s.imagePreviewTab}${tab === "scores" ? " " + s.imagePreviewTabActive : ""}${!hasCaption ? " " + s.imagePreviewTabDisabled : ""}`}
              onClick={() => { setTab("scores"); setShowRaw(false); }}
              disabled={!hasCaption}
            >
              Scores
            </button>
          </div>
          <div className={s.imagePreviewPanelActions}>
            <button
              className={s.imagePreviewRawBtn}
              onClick={() => setShowRaw(true)}
              disabled={!data}
            >📋 Raw</button>
            <button
              className={s.imagePreviewRawBtn}
              onClick={handleCopyPath}
              disabled={!activePath}
              title={activePath || "No JSON file"}
            >📁 Path</button>
            <a
              href={url}
              download={url.split("/").pop()}
              className={s.imagePreviewRawBtn}
              title="Download"
              onClick={(e) => e.stopPropagation()}
            >↓ Save</a>
            <button className={s.imagePreviewPanelClose} onClick={onClose}>✕</button>
          </div>
        </div>
        <div className={s.imagePreviewPanelBody}>
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
          <div className={s.mfRawModalBackdrop} onClick={() => setShowRaw(false)}>
            <div className={s.mfRawModal} onClick={(e) => e.stopPropagation()}>
              <div className={s.mfRawModalHeader}>
                <span className={s.mfRawModalTitle}>{tab}.json</span>
                <div className={s.mfRawModalActions}>
                  <button className={s.mfRawCopyBtn} onClick={handleCopyRaw}>
                    📋 Copy
                  </button>
                  <button className={s.mfRawCloseBtn} onClick={() => setShowRaw(false)}>✕</button>
                </div>
              </div>
              <pre className={s.mfRawContent}>{JSON.stringify(data, null, 2)}</pre>
            </div>
          </div>
        )}
      </div>
    </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
