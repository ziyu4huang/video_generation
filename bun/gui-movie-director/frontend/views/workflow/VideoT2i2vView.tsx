import React from "react";
import type { ViewDescriptor } from "../registry";
import { CommandViewShell } from "../../components/CommandViewShell";
import { TextField, NumberField, RangeField, ToggleField } from "../../components/FieldComponents";
import { FormSection } from "../../components/FormSection";
import { useCommandJob } from "../../hooks/useCommandJob";

const FALLBACK_DEFAULTS: Record<string, any> = {
  seed: 99,
  t2i_transformer: "moody-pro-mix",
  t2i_steps: 9,
  t2i_width: 640,
  t2i_height: 960,
  t2i_lora_scale: 1.0,
  transformer: "dasiwa",
  frames: 97,
  fps: 24,
  lora_scale: 1.0,
};

const LTX_TRANSFORMERS = [
  { value: "dasiwa", label: "DaSiWa (recommended — best I2V quality)" },
  { value: "dev", label: "Dev" },
  { value: "distilled", label: "Distilled (fast, CFG=1)" },
];

export function VideoT2i2vView() {
  const { state, setField, job, loading, progress, handleJobStart, handleCancel, submit, error, setError } =
    useCommandJob("video-t2i2v", "video t2i2v", "video-t2i2v", FALLBACK_DEFAULTS);

  const isDisabled = () => !state.prompt?.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const params: Record<string, any> = {};
    if (!state.prompt?.trim()) return;
    params.prompt = state.prompt.trim();
    params.seed = state.seed ?? 99;

    // T2I stage
    if (state.t2i_transformer) params.t2i_transformer = state.t2i_transformer;
    if (state.t2i_steps) params.t2i_steps = state.t2i_steps;
    if (state.t2i_seed != null) params.t2i_seed = state.t2i_seed;
    params.t2i_width = state.t2i_width ?? 640;
    params.t2i_height = state.t2i_height ?? 960;
    if (state.t2i_lora_path) params.t2i_lora_path = state.t2i_lora_path;
    if (state.t2i_lora_scale != null && state.t2i_lora_scale !== 1.0) params.t2i_lora_scale = state.t2i_lora_scale;

    // VLM stage
    if (state.action?.trim()) params.action = state.action.trim();
    if (state.vlm_api_url?.trim()) params.vlm_api_url = state.vlm_api_url.trim();

    // Video stage
    params.transformer = state.transformer ?? "dasiwa";
    params.frames = state.frames ?? 97;
    params.fps = state.fps ?? 24;
    if (state.cfg_scale != null) params.cfg_scale = state.cfg_scale;
    if (state.stg_scale != null) params.stg_scale = state.stg_scale;
    if (state.stage1_steps != null) params.stage1_steps = state.stage1_steps;
    if (state.stage2_steps != null) params.stage2_steps = state.stage2_steps;
    if (state.hq) params.hq = true;
    if (state.distilled) params.distilled = true;
    if (state.teacache) params.teacache = true;
    if (state.lora_path) params.lora_path = state.lora_path;
    if (state.lora_scale != null && state.lora_scale !== 1.0) params.lora_scale = state.lora_scale;

    await submit(params);
  };

  return (
    <CommandViewShell
      onSubmit={handleSubmit}
      submitLabel={loading ? "Running pipeline..." : "Generate T2I → VLM → I2V"}
      disabled={loading || isDisabled()}
      loading={loading}
      job={job}
      handleCancel={handleCancel}
      progress={progress}
      error={error}
      onDismiss={() => setError(null)}
      action="video-t2i2v"
      handleJobStart={handleJobStart}
    >
      {/* ── Stage 1: ZImage T2I ── */}
      <FormSection title="Stage 1 — Image (ZImage T2I)">
        <TextField
          label="Image Prompt *"
          value={state.prompt ?? ""}
          onChange={(v) => setField("prompt", v)}
          placeholder="Describe the character and scene for image generation..."
          multiline
          required
        />
        <div className="form-row">
          <TextField
            label="Transformer"
            value={state.t2i_transformer ?? "moody-pro-mix"}
            onChange={(v) => setField("t2i_transformer", v)}
          />
          <NumberField label="Steps" value={state.t2i_steps ?? 9} onChange={(v) => setField("t2i_steps", v)} min={1} max={50} />
          <NumberField label="Seed" value={state.seed ?? 99} onChange={(v) => setField("seed", v)} />
        </div>
        <div className="form-row">
          <NumberField label="Width" value={state.t2i_width ?? 640} onChange={(v) => setField("t2i_width", v)} min={256} max={2048} step={64} />
          <NumberField label="Height" value={state.t2i_height ?? 960} onChange={(v) => setField("t2i_height", v)} min={256} max={2048} step={64} />
          <NumberField label="T2I Seed Override" value={state.t2i_seed ?? ""} onChange={(v) => setField("t2i_seed", v || null)} />
        </div>
        <div className="form-row">
          <TextField
            label="LoRA Path"
            value={state.t2i_lora_path ?? ""}
            onChange={(v) => setField("t2i_lora_path", v || null)}
            placeholder="optional"
          />
          <RangeField label="LoRA Scale" value={state.t2i_lora_scale ?? 1.0} onChange={(v) => setField("t2i_lora_scale", v)} min={0} max={2} step={0.05} />
        </div>
      </FormSection>

      {/* ── Stage 2: VLM Prompt Assistant ── */}
      <FormSection title="Stage 2 — VLM Prompt Assistant (optional)">
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
          VLM 分析圖片後，將您的動作描述擴展為包含動作細節與 zh-TW 語音台詞的完整 LTX I2V 提示詞。留空則直接使用原始 Prompt。
        </div>
        <TextField
          label="Action Intent (動作指令)"
          value={state.action ?? ""}
          onChange={(v) => setField("action", v || null)}
          placeholder="例：她微笑走向鏡頭，輕聲說「嗯…你來了」"
          multiline
        />
        <TextField
          label="VLM API URL (optional)"
          value={state.vlm_api_url ?? ""}
          onChange={(v) => setField("vlm_api_url", v || null)}
          placeholder="http://localhost:1234/v1"
        />
      </FormSection>

      {/* ── Stage 3: LTX I2V ── */}
      <FormSection title="Stage 3 — Video (LTX-2.3 I2V)">
        <div className="form-group">
          <label>LTX Transformer</label>
          <select
            value={state.transformer ?? "dasiwa"}
            onChange={(e) => setField("transformer", e.target.value)}
            className="field-select"
          >
            {LTX_TRANSFORMERS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <NumberField label="Frames" value={state.frames ?? 97} onChange={(v) => setField("frames", v)} min={9} max={257} step={8} />
          <NumberField label="FPS" value={state.fps ?? 24} onChange={(v) => setField("fps", v)} min={1} max={60} />
          <NumberField label="CFG Scale" value={state.cfg_scale ?? ""} onChange={(v) => setField("cfg_scale", v || null)} min={1} max={20} step={0.5} />
        </div>
        <div className="form-row">
          <NumberField label="Stage 1 Steps" value={state.stage1_steps ?? ""} onChange={(v) => setField("stage1_steps", v || null)} min={1} max={100} />
          <NumberField label="Stage 2 Steps" value={state.stage2_steps ?? ""} onChange={(v) => setField("stage2_steps", v || null)} min={1} max={100} />
          <NumberField label="STG Scale" value={state.stg_scale ?? ""} onChange={(v) => setField("stg_scale", v || null)} min={0} max={5} step={0.1} />
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
          <ToggleField label="HQ" checked={state.hq ?? false} onChange={(v) => setField("hq", v)} />
          <ToggleField label="Distilled" checked={state.distilled ?? false} onChange={(v) => setField("distilled", v)} />
          <ToggleField label="TeaCache" checked={state.teacache ?? false} onChange={(v) => setField("teacache", v)} />
        </div>
        <div className="form-row" style={{ marginTop: 8 }}>
          <TextField
            label="Video LoRA Path"
            value={state.lora_path ?? ""}
            onChange={(v) => setField("lora_path", v || null)}
            placeholder="optional"
          />
          <RangeField label="Video LoRA Scale" value={state.lora_scale ?? 1.0} onChange={(v) => setField("lora_scale", v)} min={0} max={2} step={0.05} />
        </div>
      </FormSection>
    </CommandViewShell>
  );
}

export const videoT2i2vDescriptor: ViewDescriptor = {
  id: "vid-t2i2v", group: "Workflow", label: "T2I2V", icon: "🎞️",
  component: VideoT2i2vView,
};
