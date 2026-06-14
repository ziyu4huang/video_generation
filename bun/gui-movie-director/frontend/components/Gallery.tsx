import React, { useEffect, useState, useCallback, useRef } from "react";
import type { GalleryImage } from "../types";
import { GalleryCard } from "./GalleryCard";
import type { ViewMode } from "./GalleryCard";
import { toast } from "../utils/toast";

const GRID_COLS: Record<ViewMode, string> = {
  s:    "repeat(auto-fill, minmax(80px, 1fr))",
  m:    "repeat(auto-fill, minmax(140px, 1fr))",
  l:    "repeat(auto-fill, minmax(200px, 1fr))",
  list: "1fr",
};

export type GalleryTypeFilter = "all" | "image" | "video";

interface GalleryProps {
  onImageClick: (img: GalleryImage) => void;
  highlight?: string[];
  onImagesReady?: (images: GalleryImage[]) => void;
  searchQuery?: string;
  typeFilter?: GalleryTypeFilter;
  key?: number; // for refresh
  onDeleteImage?: (img: GalleryImage) => void;
}

export function Gallery({ onImageClick, highlight, onImagesReady, searchQuery, typeFilter, onDeleteImage }: GalleryProps) {
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => (localStorage.getItem("gallery-view-mode") as ViewMode) ?? "m"
  );
  const PAGE_SIZE = 100;
  const gridRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const isSearchMode = !!(searchQuery?.trim());

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    if (isSearchMode) return; // search returns all results at once
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingMore && !loading && hasMore) {
          loadData(page + 1, true, "", typeFilter ?? "all");
        }
      },
      { rootMargin: "400px" } // start loading before the sentinel is visible
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [isSearchMode, loadingMore, loading, hasMore, page, loadData, typeFilter]);

  const handleViewMode = (m: ViewMode) => {
    setViewMode(m);
    localStorage.setItem("gallery-view-mode", m);
  };

  const highlightSet = highlight ? new Set(highlight) : null;

  const loadData = useCallback(async (p: number, append: boolean, sq: string, tf: string) => {
    try {
      if (append) setLoadingMore(true); else setLoading(true);
      if (sq.trim()) {
        const params = new URLSearchParams({ q: sq });
        if (tf !== "all") params.set("type", tf);
        const res = await fetch(`/api/gallery/search?${params}`);
        const data = await res.json();
        setImages(data.images || []);
        setTotal(data.total || 0);
        setPage(1);
      } else {
        const res = await fetch(`/api/gallery?page=${p}&limit=${PAGE_SIZE}`);
        const data = await res.json();
        if (append) {
          setImages((prev) => [...prev, ...(data.images || [])]);
        } else {
          setImages(data.images || []);
        }
        setTotal(data.total || 0);
        setPage(p);
      }
    } catch (err) {
      toast.error("Failed to load gallery");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    loadData(1, false, searchQuery ?? "", typeFilter ?? "all");
  }, [loadData, searchQuery, typeFilter]);

  // Notify parent with loaded images (always — needed for keyboard navigation)
  useEffect(() => {
    if (images.length === 0 || loading) return;
    onImagesReady?.(images);

    // Scroll to first highlighted card
    if (highlight?.length && gridRef.current) {
      const cards = gridRef.current.querySelectorAll("[data-image-name]");
      for (const card of cards) {
        const name = card.getAttribute("data-image-name");
        if (name && highlight.includes(name)) {
          card.scrollIntoView({ behavior: "smooth", block: "center" });
          break;
        }
      }
    }
  }, [images, loading, highlight, onImagesReady]);

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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>
          {isSearchMode
            ? `${total} result${total !== 1 ? "s" : ""}`
            : `Gallery (${total} images)`}
        </h2>
        <div style={{ display: "flex", gap: 4 }}>
          {(["s", "m", "l", "list"] as ViewMode[]).map((m) => (
            <button
              key={m}
              className={`btn btn-sm${viewMode === m ? " active" : ""}`}
              onClick={() => handleViewMode(m)}
              style={{ minWidth: 32 }}
            >
              {m === "list" ? "≡" : m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div
        className="gallery-grid"
        style={{ display: "grid", gridTemplateColumns: GRID_COLS[viewMode], gap: viewMode === "list" ? 2 : 16 }}
        ref={gridRef}
      >
        {images.map((img) => (
          <GalleryCard
            key={img.name}
            img={img}
            onClick={() => onImageClick(img)}
            highlighted={highlightSet?.has(img.name) ?? false}
            viewMode={viewMode}
            onDelete={onDeleteImage}
          />
        ))}
      </div>

      {/* Infinite scroll sentinel + fallback Load More button */}
      {!isSearchMode && hasMore && (
        <div style={{ textAlign: "center", padding: "24px 0" }} ref={sentinelRef}>
          {loadingMore ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-dim)" }}>
              <span className="spinner" style={{ width: 16, height: 16 }} />
              Loading...
            </div>
          ) : (
            <button
              className="btn"
              onClick={() => loadData(page + 1, true, "", typeFilter ?? "all")}
              title="Scroll down to auto-load more"
            >
              Load more ({images.length}/{total})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
