import React, { useState } from "react";
import { FileUpload } from "../components/FileUpload";

interface QualityFormProps {
  onJobStart: (job: any) => void;
  loading: boolean;
}

export function QualityForm({ onJobStart, loading }: QualityFormProps) {
  const [images, setImages] = useState<string[]>([]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (images.length === 0) { alert("At least one image is required"); return; }

    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "quality",
          params: { quality_inputs: images },
        }),
      });
      const data = await res.json();
      if (data.jobId) {
        onJobStart({ id: data.jobId, command: "image quality", status: "running", startedAt: new Date().toISOString(), outputFiles: [], logs: [] });
      } else if (data.error) { alert(data.error); }
    } catch (err) { alert(`Failed to start job: ${err}`); }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="form-section">
        <div className="form-section-title">Images to Analyze</div>
        <div className="form-group">
          <label>Add images for quality analysis</label>
          <FileUpload
            value={null}
            onChange={(path) => { if (path) setImages((prev) => [...prev, path]); }}
            multiple
          />
        </div>
        {images.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <label style={{ fontSize: 12, color: "var(--text-dim)" }}>{images.length} image(s) selected</label>
            <ul style={{ marginTop: 4, paddingLeft: 16, fontSize: 12, color: "var(--text)" }}>
              {images.map((img, i) => (
                <li key={i}>{img.split("/").pop()}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={loading || images.length === 0}>
          {loading ? <><span className="spinner" /> Analyzing...</> : "Analyze Quality"}
        </button>
      </div>
    </form>
  );
}
