import React, { useState } from "react";
import { NumberField, SelectField } from "../components/FieldComponents";
import { FileUpload } from "../components/FileUpload";

interface FaceswapFormProps {
  onJobStart: (job: any) => void;
  loading: boolean;
}

export function FaceswapForm({ onJobStart, loading }: FaceswapFormProps) {
  const [bodyImage, setBodyImage] = useState<string | null>(null);
  const [faceImage, setFaceImage] = useState<string | null>(null);
  const [mode, setMode] = useState("head");
  const [seed, setSeed] = useState(42);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bodyImage || !faceImage) { alert("Both images are required"); return; }

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "faceswap",
          params: { input_image: bodyImage, face: faceImage, mode, seed },
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        onJobStart({ id: data.jobId, command: "image faceswap", status: "running", startedAt: new Date().toISOString(), outputFiles: [], logs: [] });
      } else if (data.error) { alert(data.error); }
    } catch (err) { alert(`Failed to start job: ${err}`); }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="form-section">
        <div className="form-section-title">Images</div>
        <div className="form-row">
          <div className="form-group">
            <label>Body Image *</label>
            <FileUpload value={bodyImage} onChange={setBodyImage} />
          </div>
          <div className="form-group">
            <label>Face Image *</label>
            <FileUpload value={faceImage} onChange={setFaceImage} />
          </div>
        </div>
      </div>
      <div className="form-section">
        <div className="form-section-title">Settings</div>
        <div className="form-row">
          <SelectField label="Mode" value={mode} onChange={setMode} options={[
            { value: "head", label: "Head Swap" },
            { value: "face", label: "Face Swap" },
          ]} />
          <NumberField label="Seed" value={seed} onChange={(v) => setSeed(v ?? 42)} />
        </div>
      </div>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={loading || !bodyImage || !faceImage}>
          {loading ? <><span className="spinner" /> Swapping...</> : "Swap Face"}
        </button>
      </div>
    </form>
  );
}
