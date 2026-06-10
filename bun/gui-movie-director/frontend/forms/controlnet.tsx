import React, { useState } from "react";
import { TextField, NumberField, RangeField, SelectField, ToggleField } from "../components/FieldComponents";
import { FileUpload } from "../components/FileUpload";

interface ControlnetFormProps {
  onJobStart: (job: any) => void;
  loading: boolean;
}

export function ControlnetForm({ onJobStart, loading }: ControlnetFormProps) {
  const [inputImage, setInputImage] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [controlnetType, setControlnetType] = useState("canny");
  const [controlnetStrength, setControlnetStrength] = useState(1.0);
  const [blurRef, setBlurRef] = useState(false);
  const [removeOutlines, setRemoveOutlines] = useState(false);
  const [steps, setSteps] = useState<number | undefined>(undefined);
  const [seed, setSeed] = useState(42);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) { alert("Prompt is required"); return; }

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "controlnet",
          params: {
            prompt: prompt.trim(),
            input_image: inputImage || undefined,
            controlnet_type: controlnetType,
            controlnet_strength: controlnetStrength !== 1.0 ? controlnetStrength : undefined,
            blur_ref: blurRef || undefined,
            remove_outlines: removeOutlines || undefined,
            steps: steps ?? undefined,
            seed,
          },
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        onJobStart({ id: data.jobId, command: "image controlnet", status: "running", startedAt: new Date().toISOString(), outputFiles: [], logs: [] });
      } else if (data.error) { alert(data.error); }
    } catch (err) { alert(`Failed to start job: ${err}`); }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="form-section">
        <div className="form-section-title">Input</div>
        <div className="form-group">
          <label>Reference Image (optional)</label>
          <FileUpload value={inputImage} onChange={setInputImage} />
        </div>
      </div>
      <div className="form-section">
        <div className="form-section-title">ControlNet</div>
        <TextField label="Prompt *" value={prompt} onChange={setPrompt} placeholder="Describe the image..." multiline required />
        <div className="form-row" style={{ marginTop: 12 }}>
          <SelectField label="Type" value={controlnetType} onChange={setControlnetType} options={[
            { value: "canny", label: "Canny Edges" },
            { value: "pose", label: "OpenPose" },
            { value: "depth", label: "Depth" },
            { value: "hed", label: "HED" },
            { value: "scribble", label: "Scribble" },
            { value: "gray", label: "Gray" },
          ]} />
          <RangeField label="Strength" value={controlnetStrength} onChange={setControlnetStrength} min={0} max={1} step={0.05} />
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
          <ToggleField label="Blur Reference" checked={blurRef} onChange={setBlurRef} />
          <ToggleField label="Remove Outlines" checked={removeOutlines} onChange={setRemoveOutlines} />
        </div>
        <div className="form-row" style={{ marginTop: 12 }}>
          <NumberField label="Steps" value={steps} onChange={setSteps} min={1} max={50} />
          <NumberField label="Seed" value={seed} onChange={(v) => setSeed(v ?? 42)} />
        </div>
      </div>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={loading || !prompt.trim()}>
          {loading ? <><span className="spinner" /> Generating...</> : "Generate"}
        </button>
      </div>
    </form>
  );
}
