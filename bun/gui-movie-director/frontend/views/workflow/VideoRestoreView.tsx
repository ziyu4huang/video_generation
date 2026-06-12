import React from "react";
import type { ViewDescriptor } from "../registry";
import { CommandViewShell } from "../../components/CommandViewShell";
import { TextField, NumberField, RangeField, ToggleField } from "../../components/FieldComponents";
import { FileUpload } from "../../components/FileUpload";
import { useCommandJob } from "../../hooks/useCommandJob";

const FALLBACK_DEFAULTS: Record<string, any> = {
  seed: 42, restore_scale: 1.0, restore_cond_strength: 1.0, restoration_scale: 1.0, upscale_scale: 1.0,
};

export function VideoRestoreView() {
  const { state, setField, job, loading, handleJobStart, handleCancel, submit, error, setError } =
    useCommandJob("video-restore", "video restore", "video-restore", FALLBACK_DEFAULTS);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const params: Record<string, any> = {};
    params.restore_input_flag = state.restore_input_flag;
    if (state.restore_output) params.restore_output = state.restore_output;
    if (state.restore_negative_prompt?.trim()) params.restore_negative_prompt = state.restore_negative_prompt.trim();
    if (state.restore_scale !== 1.0) params.restore_scale = state.restore_scale;
    if (state.restore_cond_strength !== 1.0) params.restore_cond_strength = state.restore_cond_strength;
    params.seed = state.seed;
    if (state.frames) params.frames = state.frames;
    if (state.low_ram) params.low_ram = true;
    if (state.restoration_lora) params.restoration_lora = state.restoration_lora;
    if (state.upscale_lora) params.upscale_lora = state.upscale_lora;
    if (state.restoration_scale !== 1.0) params.restoration_scale = state.restoration_scale;
    if (state.upscale_scale !== 1.0) params.upscale_scale = state.upscale_scale;
    if (state.no_upscale_lora) params.no_upscale_lora = true;
    if (state.restore_no_audio) params.restore_no_audio = true;
    await submit(params);
  };

  return (
    <CommandViewShell
      onSubmit={handleSubmit}
      submitLabel={loading ? "Restoring..." : "Restore Video"}
      disabled={loading || !state.restore_input_flag}
      loading={loading}
      job={job}
      handleCancel={handleCancel}
      error={error}
      onDismiss={() => setError(null)}
      action="video-restore"
      handleJobStart={handleJobStart}
    >
      <div className="form-section">
        <div className="form-section-title">Input</div>
        <div className="form-group">
          <label>Source Video *{state.restore_input_flag && " ✅"}</label>
          <FileUpload value={state.restore_input_flag ?? null} onChange={(v) => setField("restore_input_flag", v)} />
        </div>
        <TextField
          label="Output Path"
          value={state.restore_output ?? ""}
          onChange={(v) => setField("restore_output", v)}
          placeholder="Default: <input>_restored.mp4"
        />
      </div>

      <div className="form-section">
        <div className="form-section-title">Restore Settings</div>
        <div className="form-row">
          <RangeField label="Resolution Scale" value={state.restore_scale} onChange={(v) => setField("restore_scale", v)} min={0.5} max={4} step={0.25} />
          <RangeField label="Cond Strength" value={state.restore_cond_strength} onChange={(v) => setField("restore_cond_strength", v)} min={0} max={1} step={0.05} />
        </div>
        <TextField
          label="Negative Prompt"
          value={state.restore_negative_prompt ?? ""}
          onChange={(v) => setField("restore_negative_prompt", v)}
          placeholder="Default: built-in negative prompt"
          multiline
        />
      </div>

      <div className="form-section">
        <div className="form-section-title">Generation</div>
        <div className="form-row">
          <NumberField label="Seed" value={state.seed} onChange={(v) => setField("seed", v)} />
          <NumberField label="Frames" value={state.frames} onChange={(v) => setField("frames", v)} min={9} max={257} step={8} />
        </div>
        <ToggleField label="Low RAM" checked={state.low_ram ?? false} onChange={(v) => setField("low_ram", v)} />
      </div>

      <div className="form-section">
        <div className="form-section-title">LoRA</div>
        <div className="form-row">
          <TextField label="Restoration LoRA" value={state.restoration_lora ?? ""} onChange={(v) => setField("restoration_lora", v)} placeholder="Default: built-in" />
          <RangeField label="Restoration Scale" value={state.restoration_scale} onChange={(v) => setField("restoration_scale", v)} min={0} max={2} step={0.05} />
        </div>
        <div className="form-row">
          <TextField label="Upscale LoRA" value={state.upscale_lora ?? ""} onChange={(v) => setField("upscale_lora", v)} placeholder="Default: built-in" />
          <RangeField label="Upscale Scale" value={state.upscale_scale} onChange={(v) => setField("upscale_scale", v)} min={0} max={2} step={0.05} />
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <ToggleField label="Skip Upscale LoRA" checked={state.no_upscale_lora ?? false} onChange={(v) => setField("no_upscale_lora", v)} />
          <ToggleField label="No Audio Passthrough" checked={state.restore_no_audio ?? false} onChange={(v) => setField("restore_no_audio", v)} />
        </div>
      </div>
    </CommandViewShell>
  );
}

export const videoRestoreDescriptor: ViewDescriptor = {
  id: "vid-restore", group: "Workflow", label: "Video Restore", icon: "🔧",
  component: VideoRestoreView,
};
