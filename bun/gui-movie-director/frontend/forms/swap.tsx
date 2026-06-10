import React, { useState } from "react";
import { TextField, NumberField, RangeField, ToggleField } from "../components/FieldComponents";
import { FileUpload } from "../components/FileUpload";

interface SwapFormProps {
  onJobStart: (job: any) => void;
  loading: boolean;
}

export function SwapForm({ onJobStart, loading }: SwapFormProps) {
  const [inputImage, setInputImage] = useState<string | null>(null);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [samPrompt, setSamPrompt] = useState("");
  const [refSamPrompt, setRefSamPrompt] = useState("");
  const [samThreshold, setSamThreshold] = useState(0.3);
  const [feather, setFeather] = useState(10);
  const [blend, setBlend] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputImage || !referenceImage || !samPrompt.trim()) {
      alert("Input image, reference image, and SAM prompt are required");
      return;
    }

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "swap",
          params: {
            input_image: inputImage,
            reference: referenceImage,
            sam_prompt: samPrompt.trim(),
            ref_sam_prompt: refSamPrompt.trim() || undefined,
            sam_threshold: samThreshold !== 0.3 ? samThreshold : undefined,
            feather: feather !== 10 ? feather : undefined,
            blend: blend || undefined,
          },
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        onJobStart({ id: data.jobId, command: "image swap", status: "running", startedAt: new Date().toISOString(), outputFiles: [], logs: [] });
      } else if (data.error) { alert(data.error); }
    } catch (err) { alert(`Failed to start job: ${err}`); }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="form-section">
        <div className="form-section-title">Images</div>
        <div className="form-row">
          <div className="form-group">
            <label>Source Image *</label>
            <FileUpload value={inputImage} onChange={setInputImage} />
          </div>
          <div className="form-group">
            <label>Reference Image *</label>
            <FileUpload value={referenceImage} onChange={setReferenceImage} />
          </div>
        </div>
      </div>
      <div className="form-section">
        <div className="form-section-title">SAM Segmentation</div>
        <TextField label="SAM Prompt (what to swap in source) *" value={samPrompt} onChange={setSamPrompt} placeholder="e.g. shirt, car, background" />
        <div style={{ marginTop: 8 }}>
          <TextField label="Reference SAM Prompt (what to extract from reference)" value={refSamPrompt} onChange={setRefSamPrompt} placeholder="Defaults to same as SAM Prompt" />
        </div>
      </div>
      <div className="form-section">
        <div className="form-section-title">Settings</div>
        <div className="form-row">
          <RangeField label="SAM Threshold" value={samThreshold} onChange={setSamThreshold} min={0} max={1} step={0.05} />
          <NumberField label="Feather" value={feather} onChange={(v) => setFeather(v ?? 10)} min={0} max={100} />
        </div>
        <ToggleField label="Blend (smooth composite)" checked={blend} onChange={setBlend} />
      </div>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={loading || !inputImage || !referenceImage || !samPrompt.trim()}>
          {loading ? <><span className="spinner" /> Swapping...</> : "Swap Region"}
        </button>
      </div>
    </form>
  );
}
