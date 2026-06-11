import React, { useState, useEffect, useRef } from "react";
import { LogViewer } from "../../components/LogViewer";
import { JobOutputPreview } from "../../components/JobOutputPreview";
import { TextField, NumberField, RangeField, ToggleField } from "../../components/FieldComponents";
import { FileUpload } from "../../components/FileUpload";
import { useCommandView } from "../../hooks/useCommandView";
import { useSchemaDefaults } from "../../hooks/useSchemaDefaults";
import { useNavigation } from "../../context/NavigationContext";

// ── Types ──────────────────────────────────────────────────────────

type VideoMode = "t2v" | "i2v" | "a2v" | "flf2v";

const MODE_OPTIONS: { value: VideoMode; label: string; desc: string }[] = [
  { value: "t2v", label: "T2V", desc: "Text → Video" },
  { value: "i2v", label: "I2V", desc: "Image → Video" },
  { value: "a2v", label: "A2V", desc: "Audio → Video" },
  { value: "flf2v", label: "FLF2V", desc: "First-Last Frame" },
];

// Static fallback defaults (used before server defaults load)
const FALLBACK_DEFAULTS: Record<string, any> = {
  width: 704,
  height: 448,
  frames: 97,
  fps: 24,
  seed: 42,
  cfg_scale: 5.0,
  stg_scale: 1.0,
  begin_strength: 1.0,
  end_strength: 1.0,
  lora_scale: 1.0,
};

// ── Main View ──────────────────────────────────────────────────────

export function VideoGenerateView() {
  const command = "video generate";
  const { job, loading, handleJobStart, handleCancel } = useCommandView(command);
  const navigate = useNavigation();
  const serverDefaults = useSchemaDefaults("video-generate");
  const [mode, setMode] = useState<VideoMode>("t2v");
  const [state, setState] = useState<Record<string, any>>({ ...FALLBACK_DEFAULTS });
  // Track fields the user has manually edited — never overwrite these
  const userModifiedRef = useRef<Set<string>>(new Set());

  // Apply server defaults once they load, skipping user-touched fields
  useEffect(() => {
    if (!serverDefaults) return;
    setState((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(serverDefaults)) {
        if (!userModifiedRef.current.has(k)) next[k] = v;
      }
      return next;
    });
  }, [serverDefaults]);

  const setField = (key: string, value: any) => {
    userModifiedRef.current.add(key);
    setState((prev) => ({ ...prev, [key]: value }));
  };

  // Quality preset mutual exclusion: hq, distilled, teacache are exclusive
  const handleQualityToggle = (key: string, value: boolean) => {
    userModifiedRef.current.add(key);
    setState((prev) => {
      const next = { ...prev };
      if (value) {
        next.hq = key === "hq";
        next.distilled = key === "distilled";
        next.teacache = key === "teacache";
      } else {
        next[key] = false;
      }
      return next;
    });
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
    try {
      const params: Record<string, any> = {};

      // Prompt
      if (state.prompt?.trim()) params.prompt = state.prompt.trim();
      if (state.test_prompt?.trim()) params.test_prompt = state.test_prompt.trim();

      // Generation
      params.width = state.width;
      params.height = state.height;
      params.frames = state.frames;
      params.fps = state.fps;
      params.seed = state.seed;
      params.cfg_scale = state.cfg_scale;
      params.stg_scale = state.stg_scale !== 1.0 ? state.stg_scale : undefined;
      if (state.stage1_steps) params.stage1_steps = state.stage1_steps;
      if (state.stage2_steps) params.stage2_steps = state.stage2_steps;

      // Mode-specific
      if (mode === "i2v" && state.input_image) params.input_image = state.input_image;
      if (mode === "a2v" && state.audio) params.audio = state.audio;
      if (mode === "flf2v") {
        if (state.begin_image) params.begin_image = state.begin_image;
        if (state.end_image) params.end_image = state.end_image;
        if (state.begin_strength !== 1.0) params.begin_strength = state.begin_strength;
        if (state.end_strength !== 1.0) params.end_strength = state.end_strength;
      }

      // Quality
      if (state.low_ram) params.low_ram = true;
      if (state.hq) params.hq = true;
      if (state.distilled) params.distilled = true;
      if (state.teacache) params.teacache = true;
      if (state.temporal_upscale) params.temporal_upscale = true;
      if (state.enhance_prompt) params.enhance_prompt = true;

      // LoRA
      if (state.lora_path) params.lora_path = state.lora_path;
      if (state.lora_scale !== 1.0) params.lora_scale = state.lora_scale;

      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "video-generate", command: "video generate", params }),
      });
      const data = await res.json();
      if (data.jobId) {
        handleJobStart({ jobId: data.jobId, command: "video generate" });
      } else if (data.error) {
        alert(data.error);
      }
    } catch (err) {
      alert(`Failed to start job: ${err}`);
    }
  };

  return (
    <>
      <form onSubmit={handleSubmit}>
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

        {/* Prompt */}
        <div className="form-section">
          <div className="form-section-title">Prompt</div>
          <TextField
            label="Prompt *"
            value={state.prompt ?? ""}
            onChange={(v) => setField("prompt", v)}
            placeholder="Describe the video you want to generate..."
            multiline
            required
          />
        </div>

        {/* Mode-specific inputs */}
        <div className="form-section">
          <div className="form-section-title">
            {mode === "t2v" && "Text-to-Video"}
            {mode === "i2v" && "Image-to-Video"}
            {mode === "a2v" && "Audio-to-Video"}
            {mode === "flf2v" && "First-Last Frame to Video"}
          </div>

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
                <RangeField
                  label="Begin Strength"
                  value={state.begin_strength}
                  onChange={(v) => setField("begin_strength", v)}
                  min={0} max={1} step={0.05}
                />
                <RangeField
                  label="End Strength"
                  value={state.end_strength}
                  onChange={(v) => setField("end_strength", v)}
                  min={0} max={1} step={0.05}
                />
              </div>
            </>
          )}
        </div>

        {/* Generation settings */}
        <div className="form-section">
          <div className="form-section-title">Generation</div>
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
        </div>

        {/* Quality presets */}
        <div className="form-section">
          <div className="form-section-title">Quality</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <ToggleField label="Low RAM" checked={state.low_ram ?? false} onChange={(v) => setField("low_ram", v)} />
            <ToggleField label="HQ" checked={state.hq ?? false} onChange={(v) => handleQualityToggle("hq", v)} />
            <ToggleField label="Distilled" checked={state.distilled ?? false} onChange={(v) => handleQualityToggle("distilled", v)} />
            <ToggleField label="TeaCache" checked={state.teacache ?? false} onChange={(v) => handleQualityToggle("teacache", v)} />
            <ToggleField label="Temporal Upscale" checked={state.temporal_upscale ?? false} onChange={(v) => setField("temporal_upscale", v)} />
            <ToggleField label="Enhance Prompt" checked={state.enhance_prompt ?? false} onChange={(v) => setField("enhance_prompt", v)} />
          </div>
        </div>

        {/* LoRA */}
        <div className="form-section">
          <div className="form-section-title">LoRA</div>
          <div className="form-row">
            <TextField label="LoRA Path" value={state.lora_path ?? ""} onChange={(v) => setField("lora_path", v)} placeholder="Path to LoRA weights..." />
            <RangeField label="LoRA Scale" value={state.lora_scale} onChange={(v) => setField("lora_scale", v)} min={0} max={2} step={0.05} />
          </div>
        </div>

        {/* Submit */}
        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={loading || isDisabled()}>
            {loading ? (
              <><span className="spinner" /> Generating...</>
            ) : (
              "Generate Video"
            )}
          </button>
        </div>
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
