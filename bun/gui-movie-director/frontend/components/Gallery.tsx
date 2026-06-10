import React, { useEffect, useState } from "react";

interface GalleryImage {
  name: string;
  url: string;
  size: number;
  createdAt: string;
  manifest: any | null;
}

interface GalleryProps {
  onImageClick: (url: string) => void;
  key?: number; // for refresh
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Gallery({ onImageClick }: GalleryProps) {
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/gallery?limit=100")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setImages(data.images || []);
          setTotal(data.total || 0);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("Failed to load gallery:", err);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="empty-state">
        <div className="spinner" style={{ width: 32, height: 32 }} />
        <div className="empty-state-text" style={{ marginTop: 16 }}>
          Loading gallery...
        </div>
      </div>
    );
  }

  if (images.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📷</div>
        <div className="empty-state-text">
          No images yet. Use a command to generate your first image.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2>Gallery ({total} images)</h2>
      <div className="gallery-grid">
        {images.map((img) => (
          <div
            key={img.name}
            className="gallery-card"
            onClick={() => onImageClick(img.url)}
          >
            <img src={img.url} alt={img.name} loading="lazy" />
            <div className="gallery-card-info">
              <div className="gallery-card-name">{img.name}</div>
              <div className="gallery-card-meta">
                {formatSize(img.size)} · {formatDate(img.createdAt)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
