import React, { useEffect, useState, useCallback } from "react";
import type { GalleryImage } from "../types";
import { GalleryCard } from "./GalleryCard";

interface GalleryProps {
  onImageClick: (img: GalleryImage) => void;
  key?: number; // for refresh
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
          <GalleryCard key={img.name} img={img} onClick={() => onImageClick(img)} />
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
