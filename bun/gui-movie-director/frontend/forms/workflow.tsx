import React, { useState } from "react";
import { TextField, NumberField, RangeField, SelectField, ToggleField } from "../components/FieldComponents";

interface WorkflowFormProps {
  onJobStart: (job: any) => void;
  loading: boolean;
}

export function WorkflowForm({ onJobStart, loading }: WorkflowFormProps) {
  const [prompt, setPrompt] = useState("");
  const [pipeline, setPipeline] = useState("zimage");
  const [width, setWidth] = useState(640);
  const [height, setHeight] = useState(960);
  const [seed, setSeed] = useState(42);
  const [faceDetail, setFaceDetail] = useState(true);
  const [filmGrain, setFilmGrain] = useState(0.3);
  const [sharpening, setSharpening] = useState(0.5);
  const [upscale, setUpscale] = useState(true);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) { alert("Prompt is required"); return; }

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "workflow",
          params: {
            prompt: prompt.trim(),
            pipeline,
            width,
            height,
            seed,
            face_detail: faceDetail || undefined,
            film_grain: filmGrain > 0 ? filmGrain : undefined,
            sharpening: sharpening > 0 ? sharpening : undefined,
            upscale: upscale || undefined,
          },
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        onJobStart({ id: data.jobId, command: "image workflow", status: "running", startedAt: new Date().toISOString(), outputFiles: [], logs: [] });
      } else if (data.error) { alert(data.error); }
    } catch (err) { alert(`Failed to start job: ${err}`); }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="form-section">
        <div className="form-section-title">Prompt</div>
        <TextField label="Prompt *" value={prompt} onChange={setPrompt} placeholder="Describe the image..." multiline required />
      </div>
      <div className="form-section">
        <div className="form-section-title">Generation</div>
        <div className="form-row">
          <SelectField label="Pipeline" value={pipeline} onChange={setPipeline} options={[
            { value: "zimage", label: "ZImage Turbo" },
            { value: "flux2-klein", label: "Flux2 Klein 9B" },
          ]} />
          <NumberField label="Width" value={width} onChange={(v) => setWidth(v ?? 640)} min={256} max={2048} step={64} />
          <NumberField label="Height" value={height} onChange={(v) => setHeight(v ?? 960)} min={256} max={2048} step={64} />
          <NumberField label="Seed" value={seed} onChange={(v) => setSeed(v ?? 42)} />
        </div>
      </div>
      <div className="form-section">
        <div className="form-section-title">Post-Processing</div>
        <ToggleField label="Face Detailer" checked={faceDetail} onChange={setFaceDetail} />
        <div className="form-row" style={{ marginTop: 8 }}>
          <RangeField label="Film Grain" value={filmGrain} onChange={setFilmGrain} min={0} max={1} step={0.05} />
          <RangeField label="Sharpening" value={sharpening} onChange={setSharpening} min={0} max={1} step={0.05} />
        </div>
        <ToggleField label="ESRGAN 4× Upscale" checked={upscale} onChange={setUpscale} />
      </div>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={loading || !prompt.trim()}>
          {loading ? <><span className="spinner" /> Running workflow...</> : "Run Workflow"}
        </button>
      </div>
    </form>
  );
}
