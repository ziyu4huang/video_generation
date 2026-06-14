import React from "react";
import type { ViewDescriptor } from "../registry";
import { CommandViewShell } from "../../components/CommandViewShell";
import { TextField, NumberField, ToggleField, SelectField } from "../../components/FieldComponents";
import { FileUpload } from "../../components/FileUpload";
import { FormSection } from "../../components/FormSection";
import { useCommandJob } from "../../hooks/useCommandJob";

const FALLBACK_DEFAULTS: Record<string, any> = {
  image_width: 640, image_height: 960, pipelines: "i2v,distilled-i2v,hq-i2v",
  frames: 97, seed: 42, width: 704, height: 448, stage1_steps: 8,
};

export function VideoCompareView() {
  const { state, setField, job, loading, progress, handleJobStart, handleCancel, submit, error, setError } =
    useCommandJob("video-compare", "video compare", "video-compare", FALLBACK_DEFAULTS);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const params: Record<string, any> = {};
    if (state.source_image) params.source_image = state.source_image;
    if (state.prompt?.trim()) params.prompt = state.prompt.trim();
    if (state.image_prompt?.trim()) params.image_prompt = state.image_prompt.trim();
    if (state.image_width !== 640) params.image_width = state.image_width;
    if (state.image_height !== 960) params.image_height = state.image_height;
    if (state.image_steps) params.image_steps = state.image_steps;
    if (state.skip_caption) params.skip_caption = true;
    if (state.caption_style) params.caption_style = state.caption_style;
    if (state.pipelines) params.pipelines = state.pipelines;
    if (state.frames !== 97) params.frames = state.frames;
    params.seed = state.seed;
    if (state.width !== 704) params.width = state.width;
    if (state.height !== 448) params.height = state.height;
    if (state.stage1_steps !== 8) params.stage1_steps = state.stage1_steps;
    if (state.dry_run) params.dry_run = true;
    await submit(params);
  };

  return (
    <CommandViewShell
      onSubmit={handleSubmit}
      submitLabel={loading ? "Comparing..." : "Start Compare"}
      disabled={loading || (!state.source_image && !state.prompt?.trim())}
      loading={loading}
      job={job}
      handleCancel={handleCancel}
      progress={progress}
      error={error}
      onDismiss={() => setError(null)}
      action="video-compare"
      handleJobStart={handleJobStart}
    >
      <FormSection title="Source">
        <TextField
          label="Video Prompt *"
          value={state.prompt ?? ""}
          onChange={(v) => setField("prompt", v)}
          placeholder="Describe the video you want to compare"
          multiline
        />
        <div className="form-group">
          <label>Source Image {state.source_image && " ✅"}</label>
          <FileUpload value={state.source_image ?? null} onChange={(v) => setField("source_image", v)} />
          <span className="help-text">Omit to auto-generate via Z-Image</span>
        </div>
      </FormSection>

      <FormSection title="Z-Image Generation (when no source image)">
        <TextField
          label="Z-Image Prompt"
          value={state.image_prompt ?? ""}
          onChange={(v) => setField("image_prompt", v)}
          placeholder="Prompt for reference image generation"
        />
        <div className="form-row">
          <NumberField label="Z-Image Width" value={state.image_width} onChange={(v) => setField("image_width", v)} min={256} max={2048} />
          <NumberField label="Z-Image Height" value={state.image_height} onChange={(v) => setField("image_height", v)} min={256} max={2048} />
          <NumberField label="Z-Image Steps" value={state.image_steps} onChange={(v) => setField("image_steps", v)} min={1} max={50} />
        </div>
      </FormSection>

      <FormSection title="Captioning">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <ToggleField label="Skip Captioning" checked={state.skip_caption ?? false} onChange={(v) => setField("skip_caption", v)} />
        </div>
        <SelectField
          label="Caption Style"
          value={state.caption_style ?? ""}
          onChange={(v) => setField("caption_style", v)}
          options={[
            { value: "", label: "Default (prompt)" },
            { value: "default", label: "Default" },
            { value: "photography", label: "Photography" },
            { value: "prompt", label: "Prompt" },
            { value: "profile", label: "Profile" },
            { value: "style", label: "Style" },
            { value: "score", label: "Score" },
            { value: "compare", label: "Compare" },
            { value: "review", label: "Review" },
          ]}
        />
      </FormSection>

      <FormSection title="Pipelines">
        <TextField
          label="Pipelines"
          value={state.pipelines ?? "i2v,distilled-i2v,hq-i2v"}
          onChange={(v) => setField("pipelines", v)}
          placeholder="Comma-separated: i2v,distilled-i2v,hq-i2v,t2v,distilled-t2v"
        />
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <ToggleField label="Dry Run (preview only)" checked={state.dry_run ?? false} onChange={(v) => setField("dry_run", v)} />
        </div>
      </FormSection>

      <FormSection title="Video Params">
        <div className="form-row">
          <NumberField label="Frames" value={state.frames} onChange={(v) => setField("frames", v)} min={9} max={257} step={8} />
          <NumberField label="Seed" value={state.seed} onChange={(v) => setField("seed", v)} />
          <NumberField label="Stage 1 Steps" value={state.stage1_steps} onChange={(v) => setField("stage1_steps", v)} min={1} max={50} />
        </div>
        <div className="form-row">
          <NumberField label="Width" value={state.width} onChange={(v) => setField("width", v)} min={256} max={1280} step={64} />
          <NumberField label="Height" value={state.height} onChange={(v) => setField("height", v)} min={256} max={1280} step={64} />
        </div>
      </FormSection>
    </CommandViewShell>
  );
}

export const videoCompareDescriptor: ViewDescriptor = {
  id: "vid-compare", group: "Workflow", label: "Video Compare", icon: "⚖️",
  component: VideoCompareView,
};
