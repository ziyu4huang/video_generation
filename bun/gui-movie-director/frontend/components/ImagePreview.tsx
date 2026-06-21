import React, { useState, useRef, useCallback, useEffect } from "react";
import { useSWRConfig } from "swr";
import * as Dialog from "@radix-ui/react-dialog";
import { formatBytes, basename } from "../utils/format";
import { CaptionScoreBar, parseCaptionScores } from "./CaptionScoreBar";
import { toast } from "../utils/toast";
import s from "./ImagePreview.module.css";
import { replayJob } from "../api/jobs";
import { runCaption } from "../api/caption";

type Tab = "run" | "manifest" | "scores";

const CAPTION_STYLES = [
  { id: "default", icon: "📝", label: "Description" },
  { id: "photography", icon: "📷", label: "Photography" },
  { id: "t2i", icon: "✨", label: "T2I Prompt" },
  { id: "profile", icon: "👤", label: "Profile" },
  { id: "style", icon: "🎨", label: "Art Style" },
  { id: "score", icon: "📊", label: "Quality Score" },
  { id: "compare", icon: "⚖️", label: "Compare" },
  { id: "review", icon: "✅", label: "Review" },
  { id: "playwright", icon: "🎭", label: "Playwright" },
] as const;

interface ImagePreviewProps {
  url: string;
  manifest?: Record<string, any> | null;
  run?: Record<string, any> | null;
  manifestPath?: string | null;
  runPath?: string | null;
  caption?: Record<string, any> | null;
  captionPath?: string | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

// --- Shared helpers ---

function shortPath(p: string, segments: number = 2): string {
  const parts = p.split("/");
  if (parts.length <= segments + 1) return p;
  return "…/" + parts.slice(-(segments + 1)).join("/");
}

// --- Section components ---

function Section({ title, children, defaultOpen = true }: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  // Collapsible: title bar toggles the body; sections stay open by default.
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={s.mfSection}>
      <button
        type="button"
        className={`${s.mfSectionTitle}${!open ? " " + s.mfSectionTitleCollapsed : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={s.mfSectionToggle} aria-hidden="true">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && <div className={s.mfSectionBody}>{children}</div>}
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

function LoRaFingerprintList({ loras }: { loras: any[] }) {
  const [selected, setSelected] = useState<{ name: string; info: any } | null>(null);

  return (
    <div className={s.mfModelTable}>
      {loras.map((info: any, i: number) => {
        const hasError = !!info.error;
        const name = (info.path && basename(info.path)) || `lora #${i + 1}`;
        return (
          <div
            key={i}
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

function PipelineStepsList({ steps }: { steps: any[] }) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const denoise = steps.find((st: any) => st.step === "denoising_per_step");
  const rows = steps.filter((st: any) => st.step !== "denoising_per_step");

  return (
    <div className={s.mfTimings}>
      {rows.map((st: any, i: number) => {
        const label = st.step.startsWith("stage:")
          ? st.step.slice(6)
          : st.step.replace(/_seconds$/, "").replace(/_/g, " ");
        return (
          <div key={i} className={s.mfTimingRow}>
            <span className={s.mfTimingLabel}>{label}</span>
            <span className={s.mfTimingValue}>
              {typeof st.seconds === "number" ? `${st.seconds.toFixed(2)}s` : "—"}
            </span>
          </div>
        );
      })}
      {denoise && Array.isArray(denoise.detail) && denoise.detail.length > 0 && (
        <div className={s.mfTimingSteps}>
          <span className={s.mfTimingToggle} onClick={() => setStepsOpen(!stepsOpen)}>
            {stepsOpen ? "▾" : "▸"} {denoise.detail.length} denoising steps
          </span>
          {stepsOpen && (
            <div className={s.mfTimingStepList}>
              {denoise.detail.map((t: any, i: number) => (
                <div key={i} className={`${s.mfTimingRow} ${s.mfTimingRowIndent}`}>
                  <span className={s.mfTimingLabel}>step {i}</span>
                  <span className={s.mfTimingValue}>{typeof t === "number" ? t.toFixed(2) + "s" : String(t)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EventsList({ events }: { events: any[] }) {
  return (
    <div className={s.mfTimings}>
      {events.map((ev: any, i: number) => (
        <div key={i} className={s.mfEventEntry}>
          <div className={s.mfTimingRow}>
            <span className={s.mfEventTypeBadge}>{ev.event}</span>
            <span className={s.mfTimingLabel}>{ev.target}</span>
            {typeof ev.seconds === "number" && (
              <span className={s.mfTimingValue}>{ev.seconds.toFixed(2)}s</span>
            )}
          </div>
          {ev.detail && Object.keys(ev.detail).length > 0 && (
            <div className={s.mfParamGrid}>
              {Object.entries(ev.detail).map(([k, v]: [string, any]) => (
                <div key={k} className={s.mfParamRow}>
                  <span className={s.mfParamKey}>{k}</span>
                  <span className={s.mfEventDetailVal}>{String(v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PromptBlock({ prompt }: { prompt: string }) {
  return (
    <div className={s.mfPromptRow}>
      <div className={s.mfPromptBox}>{prompt}</div>
      <CopyButton text={prompt} />
    </div>
  );
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

function LoraRow({ lora }: { lora: Record<string, any> }) {
  const stage = String(lora.stage || "main");
  const stageClass = stage === "main" ? s.mfLoraStageMain
    : stage === "face_detail" ? s.mfLoraStageFaceDetail
    : s.mfLoraStageFusion; // anime2real / faceswap / fusion → warning
  const path = lora.path ? String(lora.path) : null;
  const scale = lora.scale;
  return (
    <div className={s.mfLoraRow}>
      <span className={`${s.mfLoraStage} ${stageClass}`}>{stage}</span>
      {path ? (
        <>
          <span className={s.mfLoraPath} title={path}>{shortPath(path, 3)}</span>
          <CopyButton text={path} />
        </>
      ) : (
        <span className={s.mfLoraPath}>—</span>
      )}
      <span className={s.mfLoraScale}>{scale != null ? `×${scale}` : "—"}</span>
    </div>
  );
}

function RunViewer({ data, runPath }: { data: Record<string, any>; runPath?: string | null }) {
  const { mutate } = useSWRConfig();
  const [rerunning, setRerunning] = useState(false);

  // Re-run this generation by invoking the top-level `run.py replay <runPath>`
  // via the /api/replay job endpoint. Mirrors the useCommandJob submit pattern
  // (fetch + toast), inlined because RunViewer is a leaf component.
  const handleReRun = async () => {
    if (!runPath || rerunning) return;
    setRerunning(true);
    try {
      const d = await replayJob(runPath);
      if (d.jobId) {
        toast.success("Re-run started");
        mutate("/api/jobs"); // refresh the Jobs panel now (it also arrives over WS)
      } else {
        toast.error(d.error || "Failed to start re-run");
      }
    } catch (e) {
      toast.error(`Failed to start re-run: ${e}`);
    } finally {
      setRerunning(false);
    }
  };

  // Collect known keys for sections, rest goes to fallback
  const usedKeys = new Set<string>();
  const extras: Record<string, any> = {};

  // argv is no longer rendered (the Reproduce command display was replaced by
  // the Re-run button above), but keep it out of the Details fallback so stale
  // argv in old manifests doesn't leak there.
  usedKeys.add("argv");

  // LoRAs: structured multi-LoRA list [{path, scale, stage}]
  const loras = Array.isArray(data.loras) ? data.loras : null;
  if (loras) usedKeys.add("loras");

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
      {runPath && (
        <div className={s.mfReRunRow}>
          <button
            className={s.mfReRunBtn}
            onClick={handleReRun}
            disabled={rerunning}
            title="Re-run this generation via run.py replay"
          >
            {rerunning ? "⏳ Starting…" : "↻ Re-run"}
          </button>
        </div>
      )}
      {loras && (
        <Section title="LoRAs">
          {(loras as any[]).map((l, i) => <LoraRow key={i} lora={l} />)}
        </Section>
      )}
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
    if (data.pipeline_steps) usedKeys.add("pipeline_steps");
    if (Array.isArray(data.events) && data.events.length > 0) usedKeys.add("events");

    // LoRA fingerprints: models.loras (array) gets its own section; lora/loras
    // are removed from the generic ModelTable to avoid duplication.
    const modelsLoras = data.models && Array.isArray(data.models.loras) ? data.models.loras : null;
    const restModels = data.models ? { ...data.models } : null;
    if (modelsLoras && restModels) { delete restModels.loras; delete restModels.lora; }

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
        {restModels && Object.keys(restModels).length > 0 && (
          <Section title="Models">
            <ModelTable models={restModels} />
          </Section>
        )}
        {modelsLoras && (
          <Section title="LoRAs">
            <LoRaFingerprintList loras={modelsLoras} />
          </Section>
        )}
        {data.timings && (
          <Section title="Timings">
            <TimingsList timings={data.timings} />
          </Section>
        )}
        {Array.isArray(data.pipeline_steps) && data.pipeline_steps.length > 0 && (
          <Section title="Run sequence">
            <PipelineStepsList steps={data.pipeline_steps} />
          </Section>
        )}
        {Array.isArray(data.events) && data.events.length > 0 && (
          <Section title="Events">
            <EventsList events={data.events} />
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

function StyleDropdown({ currentStyle, onPick, disabled }: { currentStyle: string; onPick: (style: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const cur = CAPTION_STYLES.find((style) => style.id === currentStyle) || CAPTION_STYLES[0];
  return (
    <div style={{ position: "relative" }}>
      <button
        className={s.styleSelectBtn}
        onClick={() => setOpen(!open)}
        disabled={disabled}
        type="button"
      >
        {cur.icon} {cur.label} <span style={{ fontSize: 9, opacity: 0.6 }}>▼</span>
      </button>
      {open && (
        <>
          <div className={s.styleDropdownBackdrop} onClick={() => setOpen(false)} />
          <div className={s.styleDropdown}>
            {CAPTION_STYLES.map((st) => (
              <button
                key={st.id}
                className={`${s.styleDropdownItem}${st.id === currentStyle ? " " + s.styleDropdownItemActive : ""}`}
                onClick={() => { onPick(st.id); setOpen(false); }}
                type="button"
              >
                {st.icon} {st.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ScoresViewer({ caption, onRerun, onRefresh, rerunning, captionStyle, onStyleChange }: {
  caption: Record<string, any>;
  onRerun?: () => void;
  onRefresh?: () => void;
  rerunning?: boolean;
  captionStyle?: string;
  onStyleChange?: (style: string) => void;
}) {
  const scores = parseCaptionScores(caption.caption);
  const styleLabel = CAPTION_STYLES.find((style) => style.id === caption.style);
  const label = styleLabel ? `${styleLabel.icon} ${styleLabel.label}` : "Image Analysis";

  const actionRow = (
    <div className={s.captionActionsRow}>
      {onStyleChange && (
        <StyleDropdown currentStyle={captionStyle || "default"} onPick={onStyleChange} disabled={rerunning} />
      )}
      <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
        {onRefresh && (
          <button className={s.mfCopyBtn} onClick={onRefresh} disabled={rerunning} title="Reload from file">↻</button>
        )}
        {onRerun && (
          <button className={s.captionPrimaryBtn} onClick={onRerun} disabled={rerunning}>
            {rerunning ? "⏳ Generating…" : "✨ Rerun"}
          </button>
        )}
      </div>
    </div>
  );

  if (!scores) {
    const text = String(caption.caption ?? "");
    const handleCopy = async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success("Caption copied!");
      } catch { /* ignore */ }
    };
    return (
      <div className={s.captionTextBlock}>
        {actionRow}
        <div className={s.captionTextContent}>{text}</div>
        <div className={s.captionTextFooter}>
          <span className={s.captionTextLabel}>{label}</span>
          <button className={s.mfCopyBtn} onClick={handleCopy}>📋 Copy</button>
        </div>
      </div>
    );
  }
  return (
    <div style={{ padding: 16 }}>
      {actionRow}
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

// A `.caption.json` file holds multiple VLM styles per image. Legacy flat
// files (`{style, model, elapsed_sec, caption}`, no `styles` key) are migrated
// in-memory here, guessing the style key from their own `style` field.
function normalizeCaptionFile(raw: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!raw) return null;
  if (raw.styles && typeof raw.styles === "object") return raw;
  const style = raw.style || "default";
  return {
    image: raw.image,
    video: raw.video,
    model: raw.model,
    updated_style: style,
    styles: { [style]: { model: raw.model, elapsed_sec: raw.elapsed_sec, caption: raw.caption } },
  };
}

function pickCaptionStyle(file: Record<string, any> | null, style: string): Record<string, any> | null {
  const entry = file?.styles?.[style];
  if (!entry) return null;
  return { style, model: entry.model, elapsed_sec: entry.elapsed_sec, caption: entry.caption };
}

export function ImagePreview({ url, manifest, run, manifestPath, runPath, caption, captionPath, onClose, onPrev, onNext, hasPrev, hasNext }: ImagePreviewProps) {
  const hasRun = !!run;
  const hasManifest = !!manifest;
  const [captionLoading, setCaptionLoading] = useState(false);
  const [captionFile, setCaptionFile] = useState<Record<string, any> | null>(() => normalizeCaptionFile(caption));
  const [captionStyle, setCaptionStyle] = useState<string>("default");
  const effectiveCaption = pickCaptionStyle(captionFile, captionStyle);
  const [tab, setTab] = useState<Tab>(hasRun ? "run" : hasManifest ? "manifest" : "run");
  const [showRaw, setShowRaw] = useState(false);
  const data = tab === "run" ? run : manifest;
  const effectiveCaptionPath = captionPath ?? null;
  const activePath = tab === "run" ? runPath : tab === "manifest" ? manifestPath : effectiveCaptionPath;

  // Zoom / pan state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const didDrag = useRef(false);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  // Image loading state
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

  // Reset view + caption state when url changes. We reset here (rather than
  // via a React `key` remount) so the `.imagePreviewPanel` slide-in animation
  // does not re-play on every prev/next switch. The new image's own caption
  // cache (if any) seeds captionFile fresh — never carries over the previous
  // image's styles.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setImageLoaded(false);
    setImageError(false);
    setCaptionFile(normalizeCaptionFile(caption));
    setCaptionStyle("default");
    setTab(hasRun ? "run" : hasManifest ? "manifest" : "run");
    setShowRaw(false);
  }, [url]);

  // Scroll-wheel zoom (non-passive to allow preventDefault)
  useEffect(() => {
    const el = imageContainerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.88 : 1 / 0.88;
      setZoom((prev) => Math.max(0.5, Math.min(8, prev * delta)));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

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

  const handleStylePick = useCallback((style: string) => {
    setCaptionStyle(style);
  }, []);

  const handleRerunCaption = useCallback(async () => {
    const style = captionStyle;
    // Cache-first: this style is already in the loaded multi-style file.
    if (captionFile?.styles?.[style]) {
      toast.success("Caption loaded");
      return;
    }
    setCaptionLoading(true);
    try {
      const captionData = await runCaption({ url, style });
      if (captionData.ok && captionData.caption) {
        setCaptionFile(captionData.caption);
        toast.success(`Caption generated (${style})`);
      } else {
        toast.error(captionData.error || "Caption failed");
      }
    } catch (err) {
      toast.error(`Caption failed: ${err}`);
    } finally {
      setCaptionLoading(false);
    }
  }, [url, captionStyle, captionFile]);

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
        {/* Navigation arrows */}
        {onPrev && (
          <button
            className={`${s.navArrow} ${s.navArrowLeft}${!hasPrev ? " " + s.navArrowDisabled : ""}`}
            onClick={(e) => { e.stopPropagation(); onPrev(); }}
            disabled={!hasPrev}
            aria-label="Previous image"
          >
            ‹
          </button>
        )}
        {onNext && (
          <button
            className={`${s.navArrow} ${s.navArrowRight}${!hasNext ? " " + s.navArrowDisabled : ""}`}
            onClick={(e) => { e.stopPropagation(); onNext(); }}
            disabled={!hasNext}
            aria-label="Next image"
          >
            ›
          </button>
        )}

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
          <>
            {!imageLoaded && !imageError && (
              <div className={s.previewLoading}>
                <div className={s.previewSpinner} />
                <div className={s.previewLoadingText}>Loading image...</div>
              </div>
            )}
            {imageError ? (
              <div className={s.previewError}>
                <div className={s.previewErrorIcon}>⚠️</div>
                <div className={s.previewErrorText}>Failed to load image</div>
                <div className={s.previewErrorUrl}>{url.split("/").pop()}</div>
              </div>
            ) : (
              <img
                src={url}
                alt="Preview"
                className={`${s.previewMedia}${!imageLoaded ? " " + s.previewMediaHidden : ""}`}
                style={{ transform }}
                onLoad={() => setImageLoaded(true)}
                onError={() => { setImageLoaded(true); setImageError(true); }}
              />
            )}
          </>
        )}

        {/* Zoom toolbar — grouped: [− label +] | [1× 2× 4×] | [↺] */}
        <div className={s.zoomToolbar} onMouseDown={(e) => e.stopPropagation()}>
          <button
            className={s.zoomBtn}
            onClick={(e) => {
              e.stopPropagation();
              const z = Math.max(0.5, zoom / 1.5);
              setZoom(z);
              if (z === 1) setPan({ x: 0, y: 0 });
            }}
            title="Zoom out"
            aria-label="Zoom out"
          >−</button>
          <span className={s.zoomLabel}>{zoom.toFixed(1)}×</span>
          <button
            className={s.zoomBtn}
            onClick={(e) => {
              e.stopPropagation();
              const z = Math.min(8, zoom * 1.5);
              setZoom(z);
            }}
            title="Zoom in"
            aria-label="Zoom in"
          >+</button>
          <span className={s.zoomDivider} aria-hidden="true" />
          <button
            className={`${s.zoomBtn} ${zoom === 1 ? " " + s.zoomBtnActive : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            aria-label="Zoom 1×"
          >1×</button>
          <button
            className={`${s.zoomBtn} ${zoom === 2 ? " " + s.zoomBtnActive : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              setZoom(2);
            }}
            aria-label="Zoom 2×"
          >2×</button>
          <button
            className={`${s.zoomBtn} ${zoom === 4 ? " " + s.zoomBtnActive : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              setZoom(4);
            }}
            aria-label="Zoom 4×"
          >4×</button>
          {zoom !== 1 && (
            <>
              <span className={s.zoomDivider} aria-hidden="true" />
              <button
                className={s.zoomBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  resetView();
                }}
                title="Reset view"
                aria-label="Reset view"
              >↺</button>
            </>
          )}
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
              className={`${s.imagePreviewTab}${tab === "scores" ? " " + s.imagePreviewTabActive : ""}`}
              onClick={() => { setTab("scores"); setShowRaw(false); }}
              title={captionLoading ? "Generating caption..." : "Load or generate caption"}
            >
              {captionLoading ? "⏳" : "📊"} Scores
            </button>
          </div>
          <div className={s.imagePreviewPanelActions}>
            <button className={s.imagePreviewPanelClose} onClick={onClose}>✕</button>
          </div>
        </div>
        <div className={s.imagePreviewPanelBody}>
          {tab === "scores" && effectiveCaption ? (
            <ScoresViewer caption={effectiveCaption} onRerun={handleRerunCaption} rerunning={captionLoading} captionStyle={captionStyle} onStyleChange={handleStylePick} />
          ) : tab === "scores" ? (
            <div className={s.captionPickPrompt}>
              <div className={s.captionPickLabel}>Choose a caption style, then click Rerun</div>
              <StyleDropdown currentStyle={captionStyle} onPick={(style) => { handleStylePick(style); }} disabled={captionLoading} />
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <button className={s.captionPrimaryBtn} onClick={handleRerunCaption} disabled={captionLoading}>
                  {captionLoading ? "⏳ Generating…" : "✨ Generate"}
                </button>
              </div>
            </div>
          ) : data ? (
            <>
              <div className={s.imagePreviewPanelActions} style={{ padding: "8px 20px 0" }}>
                <button
                  className={s.imagePreviewRawBtn}
                  onClick={() => setShowRaw(true)}
                >📋 Raw</button>
                <button
                  className={s.imagePreviewRawBtn}
                  onClick={handleCopyPath}
                  disabled={!activePath}
                  title={activePath || "No JSON file"}
                >📁 Path</button>
              </div>
              {tab === "run" ? <RunViewer data={data} runPath={runPath} /> : <ManifestViewer data={data} />}
            </>
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
