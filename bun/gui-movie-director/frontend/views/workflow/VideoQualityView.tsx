import React from "react";
import type { ViewDescriptor } from "../registry";
import { CommandViewShell } from "../../components/CommandViewShell";
import { TextField, NumberField, ToggleField, SelectField } from "../../components/FieldComponents";
import { FormSection } from "../../components/FormSection";
import { useCommandJob } from "../../hooks/useCommandJob";

const FALLBACK_DEFAULTS: Record<string, any> = {
  sample_every: 1, quality_lang: "en",
};

export function VideoQualityView() {
  const { state, setField, job, loading, progress, handleJobStart, handleCancel, submit, error, setError } =
    useCommandJob("video-quality", "video quality", "video-quality", FALLBACK_DEFAULTS);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const params: Record<string, any> = {};
    if (!state.quality_inputs?.trim()) {
      setError("Video paths are required");
      return;
    }
    params.quality_inputs = state.quality_inputs.trim();
    if (state.sample_every !== 1) params.sample_every = state.sample_every;
    if (state.quality_labels?.trim()) params.quality_labels = state.quality_labels.trim();
    if (state.quality_json?.trim()) params.quality_json = state.quality_json.trim();
    if (state.no_html) params.no_html = true;
    if (state.quality_lang !== "en") params.quality_lang = state.quality_lang;
    if (state.vlm_score) params.vlm_score = true;
    await submit(params);
  };

  return (
    <CommandViewShell
      onSubmit={handleSubmit}
      submitLabel={loading ? "Analyzing..." : "Analyze Quality"}
      disabled={loading || !state.quality_inputs?.trim()}
      loading={loading}
      job={job}
      handleCancel={handleCancel}
      progress={progress}
      error={error}
      onDismiss={() => setError(null)}
      action="video-quality"
      handleJobStart={handleJobStart}
    >
      <FormSection title="Input">
        <TextField
          label="Video Paths *"
          value={state.quality_inputs ?? ""}
          onChange={(v) => setField("quality_inputs", v)}
          placeholder="video.mp4 or A.mp4 B.mp4 or manifest.json"
          required
        />
        <TextField
          label="A/B Labels"
          value={state.quality_labels ?? ""}
          onChange={(v) => setField("quality_labels", v)}
          placeholder="e.g. Baseline,LoRA"
        />
      </FormSection>

      <FormSection title="Analysis">
        <div className="form-row">
          <NumberField label="Sample Every Nth Frame" value={state.sample_every} onChange={(v) => setField("sample_every", v)} min={1} max={100} />
          <SelectField
            label="Report Language"
            value={state.quality_lang ?? "en"}
            onChange={(v) => setField("quality_lang", v)}
            options={[
              { value: "en", label: "English" },
              { value: "zh_TW", label: "繁體中文" },
            ]}
          />
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <ToggleField label="Skip HTML Report" checked={state.no_html ?? false} onChange={(v) => setField("no_html", v)} />
          <ToggleField label="VLM Scoring" checked={state.vlm_score ?? false} onChange={(v) => setField("vlm_score", v)} />
        </div>
      </FormSection>

      <FormSection title="Output">
        <TextField
          label="JSON Report Path"
          value={state.quality_json ?? ""}
          onChange={(v) => setField("quality_json", v)}
          placeholder="Default: <input>.quality.json"
        />
      </FormSection>
    </CommandViewShell>
  );
}

export const videoQualityDescriptor: ViewDescriptor = {
  id: "vid-quality", group: "Workflow", label: "Video Quality", icon: "📊",
  component: VideoQualityView,
};
