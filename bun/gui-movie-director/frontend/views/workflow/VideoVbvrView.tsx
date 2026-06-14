import React from "react";
import type { ViewDescriptor } from "../registry";
import { CommandViewShell } from "../../components/CommandViewShell";
import { TextField, NumberField, RangeField, ToggleField } from "../../components/FieldComponents";
import { FileUpload } from "../../components/FileUpload";
import { FormSection } from "../../components/FormSection";
import { useCommandJob } from "../../hooks/useCommandJob";

const FALLBACK_DEFAULTS: Record<string, any> = {
  seed: 42, width: 704, height: 448, frames: 97, fps: 24,
  cfg_scale: 5.0, stg_scale: 1.0, stage1_steps: 8, stage2_steps: 3,
  lora_scale: 1.0,
};

export function VideoVbvrView() {
  const { state, setField, job, loading, progress, handleJobStart, handleCancel, submit, error, setError } =
    useCommandJob("video-vbvr", "video vbvr", "video-vbvr", FALLBACK_DEFAULTS);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const params: Record<string, any> = {};
    if (!state.prompt?.trim()) {
      setError("Prompt is required");
      return;
    }
    params.prompt = state.prompt.trim();
    if (state.input_image) params.input_image = state.input_image;
    if (state.vbvr_lora?.trim()) params.vbvr_lora = state.vbvr_lora.trim();
    if (state.seed !== 42) params.seed = state.seed;
    if (state.width !== 704) params.width = state.width;
    if (state.height !== 448) params.height = state.height;
    if (state.frames !== 97) params.frames = state.frames;
    if (state.fps !== 24) params.fps = state.fps;
    if (state.cfg_scale !== 5.0) params.cfg_scale = state.cfg_scale;
    if (state.stg_scale !== 1.0) params.stg_scale = state.stg_scale;
    if (state.stage1_steps !== 8) params.stage1_steps = state.stage1_steps;
    if (state.stage2_steps !== 3) params.stage2_steps = state.stage2_steps;
    if (state.low_ram) params.low_ram = true;
    if (state.hq) params.hq = true;
    if (state.teacache) params.teacache = true;
    if (state.lora_scale !== 1.0) params.lora_scale = state.lora_scale;
    await submit(params);
  };

  return (
    <CommandViewShell
      onSubmit={handleSubmit}
      submitLabel={loading ? "Generating VBVR..." : "Generate VBVR"}
      disabled={loading || !state.prompt?.trim()}
      loading={loading}
      job={job}
      handleCancel={handleCancel}
      progress={progress}
      error={error}
      onDismiss={() => setError(null)}
      action="video-vbvr"
      handleJobStart={handleJobStart}
    >
      <FormSection title="Input">
        <TextField
          label="Prompt *"
          value={state.prompt ?? ""}
          onChange={(v) => setField("prompt", v)}
          placeholder="Describe the video scene with VBVR reasoning"
          multiline
          required
        />
        <div className="form-group">
          <label>Input Image {state.input_image && " ✅"}</label>
          <FileUpload value={state.input_image ?? null} onChange={(v) => setField("input_image", v)} />
          <span className="help-text">Recommended — enables I2V mode for best results</span>
        </div>
      </FormSection>

      <FormSection title="VBVR LoRA">
        <TextField
          label="VBVR LoRA Path"
          value={state.vbvr_lora ?? ""}
          onChange={(v) => setField("vbvr_lora", v)}
          placeholder="Auto-detected from models/lora/ if omitted"
        />
        <div className="form-row">
          <RangeField label="LoRA Scale" value={state.lora_scale} onChange={(v) => setField("lora_scale", v)} min={0} max={2} step={0.05} />
        </div>
      </FormSection>

      <FormSection title="Video Params">
        <div className="form-row">
          <NumberField label="Frames" value={state.frames} onChange={(v) => setField("frames", v)} min={9} max={257} step={8} />
          <NumberField label="FPS" value={state.fps} onChange={(v) => setField("fps", v)} min={8} max={60} />
          <NumberField label="Seed" value={state.seed} onChange={(v) => setField("seed", v)} />
        </div>
        <div className="form-row">
          <NumberField label="Width" value={state.width} onChange={(v) => setField("width", v)} min={256} max={1280} step={64} />
          <NumberField label="Height" value={state.height} onChange={(v) => setField("height", v)} min={256} max={1280} step={64} />
        </div>
        <div className="form-row">
          <NumberField label="CFG Scale" value={state.cfg_scale} onChange={(v) => setField("cfg_scale", v)} min={1} max={30} step={0.5} />
          <NumberField label="STG Scale" value={state.stg_scale} onChange={(v) => setField("stg_scale", v)} min={0} max={10} step={0.5} />
        </div>
        <div className="form-row">
          <NumberField label="Stage 1 Steps" value={state.stage1_steps} onChange={(v) => setField("stage1_steps", v)} min={1} max={50} />
          <NumberField label="Stage 2 Steps" value={state.stage2_steps} onChange={(v) => setField("stage2_steps", v)} min={1} max={50} />
        </div>
      </FormSection>

      <FormSection title="Performance">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <ToggleField label="Low RAM" checked={state.low_ram ?? false} onChange={(v) => setField("low_ram", v)} />
          <ToggleField label="HQ (slowest, best)" checked={state.hq ?? false} onChange={(v) => setField("hq", v)} />
          <ToggleField label="TeaCache (speedup)" checked={state.teacache ?? false} onChange={(v) => setField("teacache", v)} />
        </div>
      </FormSection>
    </CommandViewShell>
  );
}

export const videoVbvrDescriptor: ViewDescriptor = {
  id: "vid-vbvr", group: "Workflow", label: "Video VBVR", icon: "🧠",
  component: VideoVbvrView,
};
