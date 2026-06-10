import React, { useState } from "react";
import { TextField, NumberField, RangeField, SelectField, ToggleField } from "../components/FieldComponents";

interface T2iFormProps {
  onJobStart: (job: any) => void;
  loading: boolean;
}

export function T2iForm({ onJobStart, loading }: T2iFormProps) {
  const [prompt, setPrompt] = useState("");
  const [pipeline, setPipeline] = useState("zimage");
  const [width, setWidth] = useState(640);
  const [height, setHeight] = useState(960);
  const [steps, setSteps] = useState<number | undefined>(undefined);
  const [seed, setSeed] = useState(42);
  const [loraScale, setLoraScale] = useState(1.0);
  const [draft, setDraft] = useState(false);
  const [upscale, setUpscale] = useState(false);
  const [count, setCount] = useState(1);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "t2i",
          params: {
            prompt: prompt.trim(),
            pipeline,
            width,
            height,
            steps: steps ?? undefined,
            seed,
            lora_scale: loraScale !== 1.0 ? loraScale : undefined,
            draft: draft || undefined,
            upscale: upscale || undefined,
            count: count > 1 ? count : undefined,
          },
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        onJobStart({
          id: data.jobId,
          command: `image t2i`,
          status: "running",
          startedAt: new Date().toISOString(),
          outputFiles: [],
          logs: [],
        });
      } else if (data.error) {
        alert(data.error);
      }
    } catch (err) {
      alert(`Failed to start job: ${err}`);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* Prompt */}
      <div className="form-section">
        <div className="form-section-title">Prompt</div>
        <TextField
          label="Prompt"
          value={prompt}
          onChange={setPrompt}
          placeholder="Describe the image you want to generate..."
          multiline
          required
        />
      </div>

      {/* Generation settings */}
      <div className="form-section">
        <div className="form-section-title">Generation</div>
        <div className="form-row">
          <SelectField
            label="Pipeline"
            value={pipeline}
            onChange={setPipeline}
            options={[
              { value: "zimage", label: "ZImage Turbo" },
              { value: "flux2-klein", label: "Flux2 Klein 9B" },
            ]}
          />
          <NumberField label="Steps" value={steps} onChange={setSteps} min={1} max={50} placeholder={pipeline === "flux2-klein" ? "4" : "9"} />
          <NumberField label="Seed" value={seed} onChange={(v) => setSeed(v ?? 42)} />
        </div>
        <div className="form-row">
          <NumberField label="Width" value={width} onChange={(v) => setWidth(v ?? 640)} min={256} max={2048} step={64} />
          <NumberField label="Height" value={height} onChange={(v) => setHeight(v ?? 960)} min={256} max={2048} step={64} />
          <NumberField label="Count" value={count} onChange={(v) => setCount(v ?? 1)} min={1} max={10} />
        </div>
      </div>

      {/* LoRA */}
      <div className="form-section">
        <div className="form-section-title">LoRA & Style</div>
        <RangeField
          label="LoRA Scale"
          value={loraScale}
          onChange={setLoraScale}
          min={0}
          max={2}
          step={0.05}
        />
      </div>

      {/* Options */}
      <div className="form-section">
        <div className="form-section-title">Options</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <ToggleField label="Draft mode (fewer steps, smaller resolution)" checked={draft} onChange={setDraft} />
          <ToggleField label="ESRGAN 4× Upscale" checked={upscale} onChange={setUpscale} />
        </div>
      </div>

      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={loading || !prompt.trim()}>
          {loading ? (
            <><span className="spinner" /> Generating...</>
          ) : (
            "Generate"
          )}
        </button>
      </div>
    </form>
  );
}
