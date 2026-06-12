import React, { useRef, useState } from "react";
import { InlineError } from "./InlineError";

interface FileUploadProps {
  value: string | null;
  onChange: (path: string | null) => void;
  multiple?: boolean;
}

export function FileUpload({ value, onChange, multiple }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uploadFile = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (data.path) {
        onChange(data.path);
        if (data.url) setPreviewUrl(data.url);
      } else {
        setError(data.error || "Upload failed");
      }
    } catch (err) {
      setError(`Upload error: ${err}`);
    } finally {
      setUploading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    if (multiple) {
      // Upload all files
      Array.from(files).forEach(uploadFile);
    } else {
      uploadFile(files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length === 0) return;
    if (multiple) {
      Array.from(files).forEach(uploadFile);
    } else {
      uploadFile(files[0]);
    }
  };

  const filename = value ? value.split("/").pop() : null;

  return (
    <div>
      <div
        className={`file-upload ${dragOver ? "drag-over" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          type="file"
          className="file-upload-input"
          accept="image/png,image/jpeg,image/webp"
          multiple={multiple}
          onChange={handleFileSelect}
        />
        {uploading ? (
          <div className="file-upload-text">
            <span className="spinner" /> Uploading...
          </div>
        ) : filename ? (
          <div className="file-upload-preview">
            <div style={{ fontSize: 12, color: "var(--success)", marginBottom: 4 }}>✓ {filename}</div>
            {value && (
              <img
                src={previewUrl || `/output/${value.split("/").pop()}`}
                alt="Preview"
                style={{ maxWidth: 200, maxHeight: 150, borderRadius: 4, border: "1px solid var(--border)" }}
              />
            )}
          </div>
        ) : (
          <div className="file-upload-text">
            Drop image here or click to browse
          </div>
        )}
      </div>
      <InlineError message={error} onDismiss={() => setError(null)} />
    </div>
  );
}
