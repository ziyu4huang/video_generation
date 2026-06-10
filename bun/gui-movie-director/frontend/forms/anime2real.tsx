import React, { useState } from "react";
import { TextField, NumberField, RangeField, SelectField } from "../components/FieldComponents";
import { FileUpload } from "../components/FileUpload";

interface Anime2realFormProps {
  onJobStart: (job: any) => void;
  loading: boolean;
}

export function Anime2realForm({ onJobStart, loading }: Anime2realFormProps) {
  const [inputImage, setInputImage] = useState<string | null>(null);
  const [realismStyle, setRealismStyle] = useState("civitai-chinese");
  const [loraScale, setLoraScale] = useState(1.0);
  const [refStrength, setRefStrength] = useState(1.0);
  const [refCount, setRefCount] = useState(1);
  const [steps, setSteps] = useState(8);
  const [seed, setSeed] = useState(42);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputImage) { alert("Input image is required"); return; }

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "anime2real",
          params: {
            input_image: inputImage,
            realism_style: realismStyle,
            anime2real_lora_scale: loraScale !== 1.0 ? loraScale : undefined,
            ref_strength: refStrength !== 1.0 ? refStrength : undefined,
            anime2real_ref_count: refCount !== 1 ? refCount : undefined,
            steps,
            seed,
          },
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        onJobStart({
          id: data.jobId, command: "image anime2real", status: "running",
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
        <div className="form-section-title">Input</div>
        <div className="form-group">
          <label>Anime Image *</label>
          <FileUpload value={inputImage} onChange={setInputImage} />
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Style Transfer</div>
        <SelectField label="Realism Style" value={realismStyle} onChange={setRealismStyle} options={[
          { value: "civitai-chinese", label: "CivitAI Chinese (Recommended)" },
          { value: "photorealistic", label: "Photorealistic" },
          { value: "3d-game", label: "3D Game" },
          { value: "semi-realistic", label: "Semi-Realistic" },
        ]} />
        <div className="form-row">
          <RangeField label="LoRA Scale" value={loraScale} onChange={setLoraScale} min={0} max={2} step={0.05} />
          <RangeField label="Reference Strength" value={refStrength} onChange={setRefStrength} min={0} max={1} step={0.05} />
        </div>
        <div className="form-row">
          <NumberField label="Reference Count" value={refCount} onChange={(v) => setRefCount(v ?? 1)} min={1} max={4} />
          <NumberField label="Steps" value={steps} onChange={(v) => setSteps(v ?? 8)} min={1} max={50} />
          <NumberField label="Seed" value={seed} onChange={(v) => setSeed(v ?? 42)} />
        </div>
      </div>

      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={loading || !inputImage}>
          {loading ? <><span className="spinner" /> Converting...</> : "Convert to Real"}
        </button>
      </div>
    </form>
  );
}
