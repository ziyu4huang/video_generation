import React, { useState } from "react";
import { TextField, NumberField, RangeField, SelectField, ToggleField } from "../components/FieldComponents";
import { FileUpload } from "../components/FileUpload";

interface I2iFormProps {
  onJobStart: (job: any) => void;
  loading: boolean;
}

export function I2iForm({ onJobStart, loading }: I2iFormProps) {
  const [inputImage, setInputImage] = useState<string | null>(null);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [denoiseStrength, setDenoiseStrength] = useState(0.4);
  const [pipeline, setPipeline] = useState("zimage");
  const [controlnetStrength, setControlnetStrength] = useState(1.0);
  const [steps, setSteps] = useState<number | undefined>(undefined);
  const [seed, setSeed] = useState(42);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputImage) { alert("Input image is required"); return; }

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "i2i",
          params: {
            input_image: inputImage,
            reference_image: referenceImage || undefined,
            prompt: prompt.trim() || undefined,
            denoise_strength: denoiseStrength,
            pipeline,
            controlnet_strength: referenceImage ? controlnetStrength : undefined,
            steps: steps ?? undefined,
            seed,
          },
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        onJobStart({
          id: data.jobId, command: "image i2i", status: "running",
          startedAt: new Date().toISOString(), outputFiles: [], logs: [],
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
      <div className="form-section">
        <div className="form-section-title">Input Images</div>
        <div className="form-row">
          <div className="form-group">
            <label>Source Image *</label>
            <FileUpload value={inputImage} onChange={setInputImage} />
          </div>
          <div className="form-group">
            <label>Reference Image (ControlNet)</label>
            <FileUpload value={referenceImage} onChange={setReferenceImage} />
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Generation</div>
        <TextField label="Prompt" value={prompt} onChange={setPrompt} placeholder="Describe changes (optional for I2I)..." multiline />
        <div className="form-row">
          <RangeField label="Denoise Strength" value={denoiseStrength} onChange={setDenoiseStrength} min={0} max={1} step={0.05} />
          <SelectField label="Pipeline" value={pipeline} onChange={setPipeline} options={[
            { value: "zimage", label: "ZImage Turbo" },
            { value: "flux2-klein", label: "Flux2 Klein 9B" },
          ]} />
        </div>
        {referenceImage && (
          <div className="form-row">
            <RangeField label="ControlNet Strength" value={controlnetStrength} onChange={setControlnetStrength} min={0} max={1} step={0.05} />
          </div>
        )}
        <div className="form-row">
          <NumberField label="Steps" value={steps} onChange={setSteps} min={1} max={50} />
          <NumberField label="Seed" value={seed} onChange={(v) => setSeed(v ?? 42)} />
        </div>
      </div>

      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={loading || !inputImage}>
          {loading ? <><span className="spinner" /> Generating...</> : "Generate"}
        </button>
      </div>
    </form>
  );
}
