import React, { useState } from "react";
import type { ViewDescriptor } from "../registry";
import { CommandViewShell } from "../../components/CommandViewShell";
import { TextField, NumberField, RangeField, ToggleField } from "../../components/FieldComponents";
import { FileUpload } from "../../components/FileUpload";
import { FormSection } from "../../components/FormSection";
import { useCommandJob } from "../../hooks/useCommandJob";
import { VideoLoraSection } from "./VideoLoraSection";

type VideoMode = "t2v" | "i2v" | "a2v" | "flf2v";

const MODE_OPTIONS: { value: VideoMode; label: string; desc: string }[] = [
  { value: "t2v", label: "T2V", desc: "Text → Video" },
  { value: "i2v", label: "I2V", desc: "Image → Video" },
  { value: "a2v", label: "A2V", desc: "Audio → Video" },
  { value: "flf2v", label: "FLF2V", desc: "First-Last Frame" },
];

const FALLBACK_DEFAULTS: Record<string, any> = {
  width: 704, height: 448, frames: 97, fps: 24, seed: 42,
  cfg_scale: 5.0, stg_scale: 1.0, begin_strength: 1.0, end_strength: 1.0, lora_scale: 1.0,
};

export function VideoGenerateView() {
  const { state, setField, job, loading, progress, handleJobStart, handleCancel, submit, error, setError } =
    useCommandJob("video-generate", "video generate", "video-generate", FALLBACK_DEFAULTS);
  const [mode, setMode] = useState<VideoMode>("t2v");

  const handleQualityToggle = (key: string, value: boolean) => {
    if (value) {
      // hq/distilled/teacache are mutually exclusive
      setField("hq", key === "hq");
      setField("distilled", key === "distilled");
      setField("teacache", key === "teacache");
    } else {
      setField(key, false);
    }
  };

  const isDisabled = (): boolean => {
    if (!state.prompt?.trim()) return true;
    if (mode === "i2v" && !state.input_image) return true;
    if (mode === "a2v" && !state.audio) return true;
    if (mode === "flf2v" && (!state.begin_image || !state.end_image)) return true;
    return false;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const params: Record<string, any> = {};
    if (state.prompt?.trim()) params.prompt = state.prompt.trim();
    if (state.test_prompt?.trim()) params.test_prompt = state.test_prompt.trim();
    params.width = state.width;
    params.height = state.height;
    params.frames = state.frames;
    params.fps = state.fps;
    params.seed = state.seed;
    params.cfg_scale = state.cfg_scale;
    if (state.stg_scale !== 1.0) params.stg_scale = state.stg_scale;
    if (state.stage1_steps) params.stage1_steps = state.stage1_steps;
    if (state.stage2_steps) params.stage2_steps = state.stage2_steps;
    if (mode === "i2v" && state.input_image) params.input_image = state.input_image;
    if (mode === "a2v" && state.audio) params.audio = state.audio;
    if (mode === "flf2v") {
      if (state.begin_image) params.begin_image = state.begin_image;
      if (state.end_image) params.end_image = state.end_image;
      if (state.begin_strength !== 1.0) params.begin_strength = state.begin_strength;
      if (state.end_strength !== 1.0) params.end_strength = state.end_strength;
    }
    if (state.low_ram) params.low_ram = true;
    if (state.hq) params.hq = true;
    if (state.distilled) params.distilled = true;
    if (state.teacache) params.teacache = true;
    if (state.temporal_upscale) params.temporal_upscale = true;
    if (state.enhance_prompt) params.enhance_prompt = true;
    if (state.lora_path) params.lora_path = state.lora_path;
    if (state.lora_scale !== 1.0) params.lora_scale = state.lora_scale;
    await submit(params);
  };

  return (
    <CommandViewShell
      onSubmit={handleSubmit}
      submitLabel={loading ? "Generating..." : "Generate Video"}
      disabled={loading || isDisabled()}
      loading={loading}
      job={job}
      handleCancel={handleCancel}
      progress={progress}
      error={error}
      onDismiss={() => setError(null)}
      action="video-generate"
      handleJobStart={handleJobStart}
    >
      {/* Mode tabs */}
      <div className="mode-tab-bar">
        {MODE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`mode-tab ${mode === opt.value ? "active" : ""}`}
            onClick={() => setMode(opt.value)}
            title={opt.desc}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <FormSection title="Prompt">
        <TextField
          label="Prompt *"
          value={state.prompt ?? ""}
          onChange={(v) => setField("prompt", v)}
          placeholder="Describe the video you want to generate..."
          multiline
          required
        />
      </FormSection>

      <FormSection title={
        mode === "t2v" ? "Text-to-Video" :
        mode === "i2v" ? "Image-to-Video" :
        mode === "a2v" ? "Audio-to-Video" :
        "First-Last Frame to Video"
      }>
        {mode === "i2v" && (
          <div className="form-group">
            <label>Source Image *{state.input_image && " ✅"}</label>
            <FileUpload value={state.input_image ?? null} onChange={(v) => setField("input_image", v)} />
          </div>
        )}
        {mode === "a2v" && (
          <div className="form-group">
            <label>Audio File *{state.audio && " ✅"}</label>
            <FileUpload value={state.audio ?? null} onChange={(v) => setField("audio", v)} />
          </div>
        )}
        {mode === "flf2v" && (
          <>
            <div className="form-row">
              <div className="form-group">
                <label>First Frame *{state.begin_image && " ✅"}</label>
                <FileUpload value={state.begin_image ?? null} onChange={(v) => setField("begin_image", v)} />
              </div>
              <div className="form-group">
                <label>Last Frame *{state.end_image && " ✅"}</label>
                <FileUpload value={state.end_image ?? null} onChange={(v) => setField("end_image", v)} />
              </div>
            </div>
            <div className="form-row">
              <RangeField label="Begin Strength" value={state.begin_strength} onChange={(v) => setField("begin_strength", v)} min={0} max={1} step={0.05} />
              <RangeField label="End Strength" value={state.end_strength} onChange={(v) => setField("end_strength", v)} min={0} max={1} step={0.05} />
            </div>
          </>
        )}
      </FormSection>

      <FormSection title="Generation">
        <div className="form-row">
          <NumberField label="Width" value={state.width} onChange={(v) => setField("width", v)} min={256} max={2048} step={64} />
          <NumberField label="Height" value={state.height} onChange={(v) => setField("height", v)} min={256} max={2048} step={64} />
          <NumberField label="Frames" value={state.frames} onChange={(v) => setField("frames", v)} min={9} max={257} step={8} />
        </div>
        <div className="form-row">
          <NumberField label="FPS" value={state.fps} onChange={(v) => setField("fps", v)} min={1} max={60} />
          <NumberField label="Seed" value={state.seed} onChange={(v) => setField("seed", v)} />
          <RangeField label="CFG Scale" value={state.cfg_scale} onChange={(v) => setField("cfg_scale", v)} min={1} max={20} step={0.5} />
        </div>
        <div className="form-row">
          <NumberField label="Stage 1 Steps" value={state.stage1_steps} onChange={(v) => setField("stage1_steps", v)} min={1} max={100} />
          <NumberField label="Stage 2 Steps" value={state.stage2_steps} onChange={(v) => setField("stage2_steps", v)} min={1} max={100} />
        </div>
      </FormSection>

      <FormSection title="Quality">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <ToggleField label="Low RAM" checked={state.low_ram ?? false} onChange={(v) => setField("low_ram", v)} />
          <ToggleField label="HQ" checked={state.hq ?? false} onChange={(v) => handleQualityToggle("hq", v)} />
          <ToggleField label="Distilled" checked={state.distilled ?? false} onChange={(v) => handleQualityToggle("distilled", v)} />
          <ToggleField label="TeaCache" checked={state.teacache ?? false} onChange={(v) => handleQualityToggle("teacache", v)} />
          <ToggleField label="Temporal Upscale" checked={state.temporal_upscale ?? false} onChange={(v) => setField("temporal_upscale", v)} />
          <ToggleField label="Enhance Prompt" checked={state.enhance_prompt ?? false} onChange={(v) => setField("enhance_prompt", v)} />
        </div>
      </FormSection>

      <VideoLoraSection
        loraPath={state.lora_path ?? ""}
        loraScale={state.lora_scale}
        onPathChange={(v) => setField("lora_path", v)}
        onScaleChange={(v) => setField("lora_scale", v)}
      />
    </CommandViewShell>
  );
}

export const videoGenerateDescriptor: ViewDescriptor = {
  id: "vid-generate", group: "Workflow", label: "Video Generate", icon: "🎬",
  component: VideoGenerateView,
};
