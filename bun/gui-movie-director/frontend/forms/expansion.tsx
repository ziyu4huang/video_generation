import React, { useState } from "react";
import { TextField, NumberField, RangeField, ToggleField } from "../components/FieldComponents";
import { FileUpload } from "../components/FileUpload";

interface ExpansionFormProps {
  onJobStart: (job: any) => void;
  loading: boolean;
}

export function ExpansionForm({ onJobStart, loading }: ExpansionFormProps) {
  const [inputImage, setInputImage] = useState<string | null>(null);
  const [mode, setMode] = useState<"direction" | "aspect">("direction");
  // Direction mode
  const [expandLeft, setExpandLeft] = useState(false);
  const [expandRight, setExpandRight] = useState(true);
  const [expandUp, setExpandUp] = useState(false);
  const [expandDown, setExpandDown] = useState(true);
  const [pixels, setPixels] = useState(1024);
  // Aspect mode
  const [aspect, setAspect] = useState("16:9");
  // Shared
  const [feather, setFeather] = useState(96);
  const [overlap, setOverlap] = useState(128);
  const [longest, setLongest] = useState(1024);
  const [refStrength, setRefStrength] = useState(1.0);
  const [prompt, setPrompt] = useState("");
  const [seed, setSeed] = useState(42);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputImage) { alert("Input image is required"); return; }

    const expandDirs = [expandLeft && "left", expandRight && "right", expandUp && "up", expandDown && "down"].filter(Boolean).join(",");

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "expansion",
          params: {
            input_image: inputImage,
            expand: mode === "direction" ? expandDirs : undefined,
            aspect: mode === "aspect" ? aspect : undefined,
            pixels: mode === "direction" ? pixels : undefined,
            expansion_feather: feather !== 96 ? feather : undefined,
            overlap: overlap !== 128 ? overlap : undefined,
            longest,
            expansion_ref_strength: refStrength !== 1.0 ? refStrength : undefined,
            prompt: prompt.trim() || undefined,
            seed,
          },
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        onJobStart({
          id: data.jobId, command: "image expansion", status: "running",
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
          <label>Source Image *</label>
          <FileUpload value={inputImage} onChange={setInputImage} />
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-title">Expansion Mode</div>
        <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
          <button type="button" className={`btn ${mode === "direction" ? "btn-primary" : ""}`} onClick={() => setMode("direction")}>
            Direction
          </button>
          <button type="button" className={`btn ${mode === "aspect" ? "btn-primary" : ""}`} onClick={() => setMode("aspect")}>
            Aspect Ratio
          </button>
        </div>
        {mode === "direction" ? (
          <>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <ToggleField label="Left" checked={expandLeft} onChange={setExpandLeft} />
              <ToggleField label="Right" checked={expandRight} onChange={setExpandRight} />
              <ToggleField label="Up" checked={expandUp} onChange={setExpandUp} />
              <ToggleField label="Down" checked={expandDown} onChange={setExpandDown} />
            </div>
            <div className="form-row" style={{ marginTop: 12 }}>
              <NumberField label="Pixels per Direction" value={pixels} onChange={(v) => setPixels(v ?? 1024)} min={256} max={2048} step={64} />
            </div>
          </>
        ) : (
          <TextField label="Target Aspect Ratio (W:H)" value={aspect} onChange={setAspect} placeholder="16:9" />
        )}
      </div>

      <div className="form-section">
        <div className="form-section-title">Settings</div>
        <div className="form-row">
          <NumberField label="Feather" value={feather} onChange={(v) => setFeather(v ?? 96)} min={0} max={512} />
          <NumberField label="Overlap" value={overlap} onChange={(v) => setOverlap(v ?? 128)} min={0} max={512} />
          <NumberField label="Longest Side" value={longest} onChange={(v) => setLongest(v ?? 1024)} min={256} max={4096} />
        </div>
        <RangeField label="Reference Strength" value={refStrength} onChange={setRefStrength} min={0} max={1} step={0.05} />
        <TextField label="Prompt (optional)" value={prompt} onChange={setPrompt} placeholder="Guide the expanded content..." multiline />
        <div className="form-row" style={{ marginTop: 12 }}>
          <NumberField label="Seed" value={seed} onChange={(v) => setSeed(v ?? 42)} />
        </div>
      </div>

      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={loading || !inputImage}>
          {loading ? <><span className="spinner" /> Expanding...</> : "Expand"}
        </button>
      </div>
    </form>
  );
}
