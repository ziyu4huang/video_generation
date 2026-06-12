import React, { useState, useRef } from "react";
import { LogViewer } from "../../components/LogViewer";
import { JobOutputPreview } from "../../components/JobOutputPreview";
import { TextField, NumberField, RangeField, ToggleField } from "../../components/FieldComponents";
import { FileUpload } from "../../components/FileUpload";
import { InlineError } from "../../components/InlineError";
import { useCommandView } from "../../hooks/useCommandView";
import { useDefaultState } from "../../hooks/useDefaultState";
import { useNavigation } from "../../context/NavigationContext";

// ── Preset & Variant options ────────────────────────────────────────

const PRESET_OPTIONS = [
  { value: "", label: "Custom" },
  { value: "kitchen", label: "🍳 Kitchen (sequential cooking)" },
  { value: "physics", label: "💥 Physics (glass breaking)" },
  { value: "wuxia", label: "⚔️ Wuxia (martial arts)" },
  { value: "street", label: "🏙️ Street (crowd dynamics)" },
];

const VARIANT_OPTIONS = [
  { value: "distilled", label: "Distilled (baseline)", cfg: "1.0/0.0" },
  { value: "distilled+vbvr-siraxe", label: "Distilled + VBVR (siraxe) ★", cfg: "1.0/0.0" },
  { value: "distilled+vbvr-licon", label: "Distilled + VBVR (LiconStudio)", cfg: "1.0/0.0" },
  { value: "dev2stg", label: "Dev 2-Stage (dev+distill-lora)", cfg: "5.0/1.0" },
  { value: "dev2stg+vbvr-licon", label: "Dev 2-Stage + VBVR (LiconStudio)", cfg: "5.0/1.0" },
  { value: "dev2stg+vbvr-siraxe", label: "Dev 2-Stage + VBVR (siraxe)", cfg: "5.0/1.0" },
];

// Static fallback defaults — matches schema-defaults.py "video-relay"
const FALLBACK_DEFAULTS: Record<string, any> = {
  width: 704,
  height: 448,
  fps: 24,
  seed: 42,
  cfg_scale: 1.0,
  stg_scale: 0.0,
  stage1_steps: 8,
  stage2_steps: 3,
  lora_scale: 1.0,
  distilled: true,
  low_ram: false,
  lora_path: "vbvr-ltx2.3",
  relay_duration: 8.0,
};

// ── Main View ──────────────────────────────────────────────────────

export function VideoRelayView() {
  const command = "video relay";
  const { job, loading, handleJobStart, handleCancel } = useCommandView(command);
  const navigate = useNavigation();
  const { state, setField } = useDefaultState("video-relay", FALLBACK_DEFAULTS);
  const [error, setError] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState("");
  const [selectedVariants, setSelectedVariants] = useState<string[]>([]);
  const userModifiedRef = useRef<Set<string>>(new Set());

  const isDisabled = (): boolean => {
    if (selectedVariants.length > 0) return false; // A/B mode uses preset prompts
    if (selectedPreset) return false; // preset mode
    return !(state.relay_prompts_text?.trim());
  };

  const toggleVariant = (v: string) => {
    setSelectedVariants((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const params: Record<string, any> = {};

      // Resolution
      params.width = state.width;
      params.height = state.height;
      params.fps = state.fps;
      params.seed = state.seed;
      params.stage1_steps = state.stage1_steps;
      params.stage2_steps = state.stage2_steps;
      params.cfg_scale = state.cfg_scale;
      params.stg_scale = state.stg_scale;

      // Duration
      if (state.relay_duration) params.relay_duration = state.relay_duration;

      // Quality
      if (state.low_ram) params.low_ram = true;
      if (state.distilled) params.distilled = true;

      // LoRA
      if (state.lora_path) params.lora_path = state.lora_path;
      if (state.lora_scale !== 1.0) params.lora_scale = state.lora_scale;

      // A/B variant mode
      if (selectedVariants.length > 0) {
        params.relay_variant = selectedVariants.join(",");
      }

      // Preset mode
      if (selectedPreset) {
        params.relay_preset = selectedPreset;
      } else if (state.relay_prompts_text?.trim()) {
        // Custom inline prompts (one per line)
        params.relay_prompts = state.relay_prompts_text
          .trim()
          .split("\n")
          .filter((l: string) => l.trim());
      }

      // Audio
      if (state.relay_audio) params.relay_audio = state.relay_audio;

      // First image
      if (state.relay_first_image) params.relay_first_image = state.relay_first_image;

      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "video-relay", command: "video relay", params }),
      });
      const data = await res.json();
      if (data.jobId) {
        handleJobStart({ jobId: data.jobId, command: "video relay" });
      } else if (data.error) {
        setError(data.error);
      }
    } catch (err) {
      setError(`Failed to start job: ${err}`);
    }
  };

  return (
    <>
      <form onSubmit={handleSubmit}>
        {/* Preset selection */}
        <div className="form-section">
          <div className="form-section-title">Prompt Preset</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {PRESET_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`mode-tab ${selectedPreset === opt.value ? "active" : ""}`}
                onClick={() => setSelectedPreset(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Custom prompts (when no preset selected) */}
        {!selectedPreset && (
          <div className="form-section">
            <div className="form-section-title">Prompts (one per line = one segment)</div>
            <TextField
              label="Relay Prompts"
              value={state.relay_prompts_text ?? ""}
              onChange={(v) => setField("relay_prompts_text", v)}
              placeholder={"Line 1: opening shot...\nLine 2: next action...\nLine 3: finale..."}
              multiline
            />
          </div>
        )}

        {/* A/B Variant selection */}
        <div className="form-section">
          <div className="form-section-title">A/B Variant Comparison</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {VARIANT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`mc-badge ${selectedVariants.includes(opt.value) ? "active" : ""}`}
                onClick={() => toggleVariant(opt.value)}
                title={`cfg/stg: ${opt.cfg}`}
              >
                {selectedVariants.includes(opt.value) ? "✓ " : ""}
                {opt.label}
              </button>
            ))}
          </div>
          {selectedVariants.length > 0 && (
            <div style={{ marginTop: 8, fontSize: "0.85em", color: "var(--text-muted)" }}>
              {selectedVariants.length} variant(s) selected — each runs independently (~5-10 min/variant)
            </div>
          )}
        </div>

        {/* Generation settings */}
        <div className="form-section">
          <div className="form-section-title">Generation</div>
          <div className="form-row">
            <NumberField label="Width" value={state.width} onChange={(v) => setField("width", v)} min={256} max={2048} step={64} />
            <NumberField label="Height" value={state.height} onChange={(v) => setField("height", v)} min={256} max={2048} step={64} />
            <NumberField label="Duration (s/seg)" value={state.relay_duration} onChange={(v) => setField("relay_duration", v)} min={1} max={30} step={1} />
          </div>
          <div className="form-row">
            <NumberField label="FPS" value={state.fps} onChange={(v) => setField("fps", v)} min={1} max={60} />
            <NumberField label="Seed" value={state.seed} onChange={(v) => setField("seed", v)} />
            <NumberField label="Stage 1 Steps" value={state.stage1_steps} onChange={(v) => setField("stage1_steps", v)} min={1} max={100} />
            <NumberField label="Stage 2 Steps" value={state.stage2_steps} onChange={(v) => setField("stage2_steps", v)} min={1} max={100} />
          </div>
          <div className="form-row">
            <RangeField label="CFG Scale" value={state.cfg_scale} onChange={(v) => setField("cfg_scale", v)} min={1} max={20} step={0.5} />
            <RangeField label="STG Scale" value={state.stg_scale} onChange={(v) => setField("stg_scale", v)} min={0} max={5} step={0.1} />
          </div>
        </div>

        {/* Quality */}
        <div className="form-section">
          <div className="form-section-title">Quality</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <ToggleField label="Distilled" checked={state.distilled ?? true} onChange={(v) => setField("distilled", v)} />
            <ToggleField label="Low RAM" checked={state.low_ram ?? false} onChange={(v) => setField("low_ram", v)} />
          </div>
        </div>

        {/* LoRA */}
        <div className="form-section">
          <div className="form-section-title">LoRA</div>
          <div className="form-row">
            <TextField label="LoRA Path" value={state.lora_path ?? ""} onChange={(v) => setField("lora_path", v)} placeholder="Short name or path..." />
            <RangeField label="LoRA Scale" value={state.lora_scale} onChange={(v) => setField("lora_scale", v)} min={0} max={2} step={0.05} />
          </div>
        </div>

        {/* Audio & Image */}
        <div className="form-section">
          <div className="form-section-title">Audio & First Image</div>
          <div className="form-row">
            <div className="form-group">
              <label>Audio Track{state.relay_audio && " ✅"}</label>
              <FileUpload value={state.relay_audio ?? null} onChange={(v) => setField("relay_audio", v)} />
            </div>
            <div className="form-group">
              <label>First Image (optional){state.relay_first_image && " ✅"}</label>
              <FileUpload value={state.relay_first_image ?? null} onChange={(v) => setField("relay_first_image", v)} />
            </div>
          </div>
        </div>

        {/* Submit */}
        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={loading || isDisabled()}>
            {loading ? (
              <><span className="spinner" /> Running Relay...</>
            ) : (
              selectedVariants.length > 0
                ? `Run A/B Test (${selectedVariants.length} variants)`
                : "Run Relay"
            )}
          </button>
        </div>
        <InlineError message={error} onDismiss={() => setError(null)} />
      </form>

      {/* Job output */}
      {job?.status === "completed" && (
        <JobOutputPreview
          job={job}
          onViewInGallery={() => {
            const names = (job.outputFiles ?? [])
              .map((f: string) => f.split("/").pop())
              .filter(Boolean) as string[];
            navigate({ type: "gallery", highlight: names });
          }}
        />
      )}
      {(job?.logs?.length ?? 0) > 0 && (
        <LogViewer
          logs={job?.logs ?? []}
          status={job?.status}
          onCancel={job?.status === "running" ? handleCancel : undefined}
        />
      )}
    </>
  );
}
