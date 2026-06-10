import React, { useState } from "react";
import { TextField, NumberField, SelectField } from "../components/FieldComponents";

interface ProfileFormProps {
  onJobStart: (job: any) => void;
  loading: boolean;
}

export function ProfileForm({ onJobStart, loading }: ProfileFormProps) {
  const [prompt, setPrompt] = useState("");
  const [views, setViews] = useState("front,back,side");
  const [ratio, setRatio] = useState("standing");
  const [basePrompt, setBasePrompt] = useState("");
  const [refCount, setRefCount] = useState(3);
  const [seed, setSeed] = useState(42);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) { alert("Prompt is required"); return; }

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "profile",
          params: {
            prompt: prompt.trim(),
            views,
            ratio,
            base_prompt: basePrompt.trim() || undefined,
            ref_count: refCount !== 3 ? refCount : undefined,
            seed,
          },
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        onJobStart({ id: data.jobId, command: "image profile", status: "running", startedAt: new Date().toISOString(), outputFiles: [], logs: [] });
      } else if (data.error) { alert(data.error); }
    } catch (err) { alert(`Failed to start job: ${err}`); }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="form-section">
        <div className="form-section-title">Character</div>
        <TextField label="Character Description *" value={prompt} onChange={setPrompt} placeholder="Describe the character in detail..." multiline required />
        <div style={{ marginTop: 8 }}>
          <TextField label="Base Prompt Override" value={basePrompt} onChange={setBasePrompt} placeholder="Override the default photographic base prompt..." />
        </div>
      </div>
      <div className="form-section">
        <div className="form-section-title">Settings</div>
        <div className="form-row">
          <SelectField label="Views" value={views} onChange={setViews} options={[
            { value: "front,back,side", label: "All Views" },
            { value: "front", label: "Front Only" },
            { value: "front,back", label: "Front + Back" },
          ]} />
          <SelectField label="Pose" value={ratio} onChange={setRatio} options={[
            { value: "standing", label: "Standing" },
            { value: "sitting", label: "Sitting" },
          ]} />
        </div>
        <div className="form-row">
          <NumberField label="Reference Count" value={refCount} onChange={(v) => setRefCount(v ?? 3)} min={1} max={4} />
          <NumberField label="Seed" value={seed} onChange={(v) => setSeed(v ?? 42)} />
        </div>
      </div>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={loading || !prompt.trim()}>
          {loading ? <><span className="spinner" /> Generating...</> : "Generate Profile"}
        </button>
      </div>
    </form>
  );
}
