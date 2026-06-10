import React, { useEffect, useState, useCallback } from "react";

interface GalleryImage {
  name: string;
  url: string;
  size: number;
  createdAt: string;
  manifest: any | null;
  run: any | null;
}

interface GalleryProps {
  onImageClick: (img: GalleryImage) => void;
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

function getManifestSummary(manifest: any): string | null {
  if (!manifest) return null;
  const parts: string[] = [];
  if (manifest.command) parts.push(manifest.command);
  if (manifest.pipeline) parts.push(manifest.pipeline);
  if (manifest.seed != null) parts.push(`seed:${manifest.seed}`);
  return parts.join(" · ");
}

export function Gallery({ onImageClick }: GalleryProps) {
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;

  const loadPage = useCallback(async (p: number, append: boolean) => {
    try {
      if (append) setLoadingMore(true); else setLoading(true);
      const res = await fetch(`/api/gallery?page=${p}&limit=${PAGE_SIZE}`);
      const data = await res.json();
      if (append) {
        setImages((prev) => [...prev, ...(data.images || [])]);
      } else {
        setImages(data.images || []);
      }
      setTotal(data.total || 0);
      setPage(p);
    } catch (err) {
      console.error("Failed to load gallery:", err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    loadPage(1, false);
  }, [loadPage]);

  const hasMore = images.length < total;

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
            onClick={() => onImageClick(img)}
          >
            <div className="gallery-card-image">
              <img src={img.url} alt={img.name} loading="lazy" />
            </div>
            <div className="gallery-card-info">
              <div className="gallery-card-name">{img.name}</div>
              <div className="gallery-card-meta">
                {formatSize(img.size)} · {formatDate(img.createdAt)}
              </div>
              {getManifestSummary(img.manifest) && (
                <div className="gallery-card-meta" style={{ color: "var(--accent)", marginTop: 2 }}>
                  {getManifestSummary(img.manifest)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {hasMore && (
        <div style={{ textAlign: "center", padding: "24px 0" }}>
          <button
            className="btn"
            disabled={loadingMore}
            onClick={() => loadPage(page + 1, true)}
          >
            {loadingMore ? (
              <><span className="spinner" /> Loading...</>
            ) : (
              `Load more (${images.length}/${total})`
            )}
          </button>
        </div>
      )}
    </div>
  );
}
