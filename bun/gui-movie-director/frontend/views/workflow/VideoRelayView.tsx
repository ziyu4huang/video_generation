import React, { useState } from "react";
import type { ViewDescriptor } from "../registry";
import { CommandViewShell } from "../../components/CommandViewShell";
import { TextField, NumberField, RangeField, ToggleField } from "../../components/FieldComponents";
import { FileUpload } from "../../components/FileUpload";
import { FormSection } from "../../components/FormSection";
import { useCommandJob } from "../../hooks/useCommandJob";
import { VideoLoraSection } from "./VideoLoraSection";

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

const FALLBACK_DEFAULTS: Record<string, any> = {
  width: 704, height: 448, fps: 24, seed: 42,
  cfg_scale: 1.0, stg_scale: 0.0, stage1_steps: 8, stage2_steps: 3,
  lora_scale: 1.0, distilled: true, low_ram: false, lora_path: "vbvr-ltx2.3", relay_duration: 8.0,
};

export function VideoRelayView() {
  const { state, setField, job, loading, progress, handleCancel, submit, error, setError } =
    useCommandJob("video-relay", "video relay", "video-relay", FALLBACK_DEFAULTS);
  const [selectedPreset, setSelectedPreset] = useState("");
  const [selectedVariants, setSelectedVariants] = useState<string[]>([]);

  const isDisabled = (): boolean => {
    if (selectedVariants.length > 0) return false;
    if (selectedPreset) return false;
    return !(state.relay_prompts_text?.trim());
  };

  const toggleVariant = (v: string) => {
    setSelectedVariants((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const params: Record<string, any> = {};
    params.width = state.width;
    params.height = state.height;
    params.fps = state.fps;
    params.seed = state.seed;
    params.stage1_steps = state.stage1_steps;
    params.stage2_steps = state.stage2_steps;
    params.cfg_scale = state.cfg_scale;
    params.stg_scale = state.stg_scale;
    if (state.relay_duration) params.relay_duration = state.relay_duration;
    if (state.low_ram) params.low_ram = true;
    if (state.distilled) params.distilled = true;
    if (state.lora_path) params.lora_path = state.lora_path;
    if (state.lora_scale !== 1.0) params.lora_scale = state.lora_scale;
    if (selectedVariants.length > 0) {
      params.relay_variant = selectedVariants.join(",");
    }
    if (selectedPreset) {
      params.relay_preset = selectedPreset;
    } else if (state.relay_prompts_text?.trim()) {
      params.relay_prompts = state.relay_prompts_text.trim().split("\n").filter((l: string) => l.trim());
    }
    if (state.relay_audio) params.relay_audio = state.relay_audio;
    if (state.relay_first_image) params.relay_first_image = state.relay_first_image;
    await submit(params);
  };

  return (
    <CommandViewShell
      onSubmit={handleSubmit}
      submitLabel={selectedVariants.length > 0 ? `Run A/B Test (${selectedVariants.length} variants)` : "Run Relay"}
      disabled={loading || isDisabled()}
      loading={loading}
      job={job}
      handleCancel={handleCancel}
      progress={progress}
      error={error}
      onDismiss={() => setError(null)}
    >
      <FormSection title="Prompt Preset">
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
      </FormSection>

      {!selectedPreset && (
        <FormSection title="Prompts (one per line = one segment)">
          <TextField
            label="Relay Prompts"
            value={state.relay_prompts_text ?? ""}
            onChange={(v) => setField("relay_prompts_text", v)}
            placeholder={"Line 1: opening shot...\nLine 2: next action...\nLine 3: finale..."}
            multiline
          />
        </FormSection>
      )}

      <FormSection title="A/B Variant Comparison">
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
      </FormSection>

      <FormSection title="Generation">
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
      </FormSection>

      <FormSection title="Quality">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <ToggleField label="Distilled" checked={state.distilled ?? true} onChange={(v) => setField("distilled", v)} />
          <ToggleField label="Low RAM" checked={state.low_ram ?? false} onChange={(v) => setField("low_ram", v)} />
        </div>
      </FormSection>

      <VideoLoraSection
        loraPath={state.lora_path ?? ""}
        loraScale={state.lora_scale}
        onPathChange={(v) => setField("lora_path", v)}
        onScaleChange={(v) => setField("lora_scale", v)}
        placeholder="Short name or path..."
      />

      <FormSection title="Audio & First Image">
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
      </FormSection>
    </CommandViewShell>
  );
}

export const videoRelayDescriptor: ViewDescriptor = {
  id: "vid-relay", group: "Workflow", label: "Video Relay", icon: "🔄",
  component: VideoRelayView,
};
