import React, { useState, useRef, useCallback, useEffect } from "react";
import { Gallery } from "../../components/Gallery";
import { GallerySearchBar } from "../../components/GallerySearchBar";
import type { GalleryTypeFilter } from "../../components/Gallery";
import { ImagePreview } from "../../components/ImagePreview";
import type { GalleryImage } from "../../types";
import { toast } from "../../utils/toast";
import { deleteGalleryItem } from "../../api/gallery";
import { useWebSocketEvents } from "../../hooks/ui/useWebSocketEvents";

interface GalleryViewProps {
  highlight?: string[];
  onHighlightConsumed?: () => void;
}

export function GalleryView({ highlight, onHighlightConsumed }: GalleryViewProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [previewImage, setPreviewImage] = useState<GalleryImage | null>(null);
  const [allImages, setAllImages] = useState<GalleryImage[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<GalleryTypeFilter>("all");

  const refreshTimer = useRef<number | null>(null);
  const highlightConsumedRef = useRef(false);

  useWebSocketEvents(
    useCallback((msg) => {
      if (msg.type === "job_complete" || msg.type === "gallery-updated") {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        const delay = msg.type === "gallery-updated" ? 300 : 800;
        refreshTimer.current = window.setTimeout(() => setRefreshKey((k) => k + 1), delay);
      }
    }, []),
  );

  // Reset consumed flag when highlight changes
  useEffect(() => {
    if (highlight?.length) {
      highlightConsumedRef.current = false;
    }
  }, [highlight]);

  const handleImageClick = useCallback((img: GalleryImage) => {
    setPreviewImage(img);
  }, []);

  const handleClose = useCallback(() => setPreviewImage(null), []);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!allImages.length) return;
      if (e.key === "Escape" && previewImage) {
        setPreviewImage(null);
        return;
      }
      if (!previewImage) return;
      const idx = allImages.findIndex((img) => img.url === previewImage.url);
      if (e.key === "ArrowRight") {
        setPreviewImage(allImages[(idx + 1) % allImages.length]);
        e.preventDefault();
      } else if (e.key === "ArrowLeft") {
        setPreviewImage(allImages[(idx - 1 + allImages.length) % allImages.length]);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [allImages, previewImage]);

  const handleDeleteImage = useCallback(async (img: GalleryImage) => {
    if (!confirm(`Delete ${img.name}?`)) return;
    // Parse dirIdx from url: "/output/N/filename"
    const m = img.url.match(/^\/output\/(\d+)\//);
    const dirIdx = m ? parseInt(m[1], 10) : 0;
    try {
      const data = await deleteGalleryItem(img.name, dirIdx);
      if (data.ok) {
        setAllImages((prev) => prev.filter((i) => i.name !== img.name));
        // Close preview if the deleted image is currently shown
        setPreviewImage((prev) => prev?.name === img.name ? null : prev);
        toast.success(`Deleted ${img.name}`);
        // Force gallery refresh
        setRefreshKey((k) => k + 1);
      } else {
        toast.error(data.failed?.join(", ") || "Failed to delete");
      }
    } catch (err) {
      toast.error(`Failed to delete: ${err}`);
    }
  }, []);

  const handleImagesReady = useCallback((images: GalleryImage[]) => {
    setAllImages(images);
    if (!highlight?.length || highlightConsumedRef.current) return;

    const matched = images.filter((img) => highlight.includes(img.name));
    if (matched.length > 0) {
      highlightConsumedRef.current = true;
      // Auto-open preview for first matched image
      handleImageClick(matched[0]);
      // Clear highlight from view state
      onHighlightConsumed?.();
    }
  }, [highlight, handleImageClick, onHighlightConsumed]);

  return (
    <>
      <GallerySearchBar
        query={searchQuery}
        onQueryChange={setSearchQuery}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        resultCount={searchQuery ? allImages.length : null}
      />
      <Gallery
        key={refreshKey}
        onImageClick={handleImageClick}
        highlight={highlightConsumedRef.current ? undefined : highlight}
        onImagesReady={handleImagesReady}
        searchQuery={searchQuery}
        typeFilter={typeFilter}
        onDeleteImage={handleDeleteImage}
      />
      {previewImage && (
        <ImagePreview
          url={previewImage.url}
          manifest={previewImage.manifest}
          run={previewImage.run}
          manifestPath={previewImage.manifestPath ?? null}
          runPath={previewImage.runPath ?? null}
          caption={previewImage.caption ?? null}
          captionPath={previewImage.captionPath ?? null}
          onClose={handleClose}
          onPrev={() => {
            const idx = allImages.findIndex((img) => img.url === previewImage.url);
            if (idx > 0) setPreviewImage(allImages[idx - 1]);
          }}
          onNext={() => {
            const idx = allImages.findIndex((img) => img.url === previewImage.url);
            if (idx < allImages.length - 1) setPreviewImage(allImages[idx + 1]);
          }}
          hasPrev={allImages.findIndex((img) => img.url === previewImage.url) > 0}
          hasNext={allImages.findIndex((img) => img.url === previewImage.url) < allImages.length - 1}
        />
      )}
    </>
  );
}
