import React, { useState } from "react";
import { TextField, NumberField } from "../components/FieldComponents";
import { FileUpload } from "../components/FileUpload";

interface AngleFormProps {
  onJobStart: (job: any) => void;
  loading: boolean;
}

export function AngleForm({ onJobStart, loading }: AngleFormProps) {
  const [inputImage, setInputImage] = useState<string | null>(null);
  const [azimuth, setAzimuth] = useState(90);
  const [elevation, setElevation] = useState(0);
  const [prompt, setPrompt] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputImage) { alert("Input image is required"); return; }

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "angle",
          params: {
            input_image: inputImage,
            azimuth,
            elevation,
            prompt: prompt.trim() || undefined,
          },
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        onJobStart({ id: data.jobId, command: "image angle", status: "running", startedAt: new Date().toISOString(), outputFiles: [], logs: [] });
      } else if (data.error) { alert(data.error); }
    } catch (err) { alert(`Failed to start job: ${err}`); }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="form-section">
        <div className="form-section-title">Input</div>
        <div className="form-group">
          <label>Source Image *</label>
          <FileUpload value={inputImage} onChange={setInputImage} />
        </div>
      </div>
      <div className="form-section">
        <div className="form-section-title">Camera Angle</div>
        <div className="form-row">
          <NumberField label="Azimuth (horizontal rotation)" value={azimuth} onChange={(v) => setAzimuth(v ?? 90)} min={-180} max={180} />
          <NumberField label="Elevation (vertical angle)" value={elevation} onChange={(v) => setElevation(v ?? 0)} min={-90} max={90} />
        </div>
        <TextField label="Prompt (optional)" value={prompt} onChange={setPrompt} placeholder="Describe any changes to the scene..." multiline />
      </div>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={loading || !inputImage}>
          {loading ? <><span className="spinner" /> Reframing...</> : "Reframe"}
        </button>
      </div>
    </form>
  );
}
