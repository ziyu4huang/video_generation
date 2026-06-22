import React, { useState, useRef, useCallback, useEffect } from "react";
import { Gallery } from "../../components/Gallery";
import { GallerySearchBar } from "../../components/GallerySearchBar";
import type { GalleryTypeFilter } from "../../components/Gallery";
import { ImagePreview } from "../../components/ImagePreview";
import { CompareView } from "../../components/CompareView";
import type { GalleryImage } from "../../types";
import { toast } from "../../utils/toast";
import { deleteGalleryItem, captionMissingGallery } from "../../api/gallery";
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
  const [captioning, setCaptioning] = useState(false);

  // Compare-mode: pick up to 2 images, then open them side-by-side.
  const [compareMode, setCompareMode] = useState(false);
  const [compareSel, setCompareSel] = useState<GalleryImage[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);

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

  const handleOpenImage = useCallback((path: string) => {
    const filename = path.split("/").pop();
    const img = allImages.find((i) => i.url.split("/").pop() === filename);
    if (img) {
      setPreviewImage(img);
    } else {
      toast.info("Input image not found in gallery");
    }
  }, [allImages]);

  const handleClose = useCallback(() => setPreviewImage(null), []);

  const handleToggleCompare = useCallback((img: GalleryImage) => {
    setCompareSel((prev) => {
      if (prev.some((p) => p.name === img.name)) {
        return prev.filter((p) => p.name !== img.name);
      }
      if (prev.length >= 2) return [prev[1], img]; // keep the latest two
      return [...prev, img];
    });
  }, []);

  const handleStartCompare = useCallback(() => {
    if (compareSel.length === 2) setCompareOpen(true);
  }, [compareSel.length]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (compareOpen) { setCompareOpen(false); return; }
        if (previewImage) { setPreviewImage(null); return; }
        if (compareMode) { setCompareMode(false); setCompareSel([]); return; }
        return;
      }
      if (!allImages.length || !previewImage) return;
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
  }, [allImages, previewImage, compareOpen, compareMode]);

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

  // Batch-caption gallery images that have no .caption.json yet — covers orphans
  // (test/self-test/comparison outputs with no run.json) that the knowledge
  // caption-missing skips. Gives them a score bar + makes them searchable.
  const handleCaptionMissing = useCallback(async () => {
    if (captioning) return;
    setCaptioning(true);
    try {
      // Batch 20/click (each Gemma score call ≈ 10-30s → ~5-10 min/click). The
      // response reports the FULL backlog (r.missing), so the toast says how much
      // remains; click again to chip away. No client-side timeout on apiFetch.
      const r = await captionMissingGallery(20);
      if (r.missing === 0) {
        toast.info("No missing captions — all gallery images already captioned");
      } else {
        const remaining = Math.max(0, r.missing - r.generated);
        const base = `Captioned ${r.generated}${r.failed ? ` (${r.failed} failed)` : ""}`;
        toast.success(remaining > 0 ? `${base} — ${remaining} still missing, click again for more` : base);
      }
      setRefreshKey((k) => k + 1);  // refresh so new captions/score bars render
    } catch (err: any) {
      toast.error(`Caption failed: ${err?.message || err}`);
    } finally {
      setCaptioning(false);
    }
  }, [captioning]);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <GallerySearchBar
            query={searchQuery}
            onQueryChange={setSearchQuery}
            typeFilter={typeFilter}
            onTypeFilterChange={setTypeFilter}
            resultCount={searchQuery ? allImages.length : null}
          />
        </div>
        <button
          className="btn btn-secondary"
          onClick={handleCaptionMissing}
          disabled={captioning}
          title="Caption gallery images that have no VLM caption yet (orphan test/self-test outputs)"
          style={{ whiteSpace: "nowrap" }}
        >
          {captioning ? "⏳ Captioning…" : "✨ Caption Missing"}
        </button>
      </div>
      <Gallery
        key={refreshKey}
        onImageClick={handleImageClick}
        highlight={highlightConsumedRef.current ? undefined : highlight}
        onImagesReady={handleImagesReady}
        searchQuery={searchQuery}
        typeFilter={typeFilter}
        onDeleteImage={handleDeleteImage}
        compareMode={compareMode}
        onCompareModeChange={(v) => { setCompareMode(v); if (!v) setCompareSel([]); }}
        selectedNames={new Set(compareSel.map((i) => i.name))}
        onToggleCompare={handleToggleCompare}
        onStartCompare={handleStartCompare}
        selectedCount={compareSel.length}
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
          onOpenImage={handleOpenImage}
        />
      )}
      {compareOpen && compareSel.length === 2 && (
        <CompareView
          left={compareSel[0]}
          right={compareSel[1]}
          onClose={() => setCompareOpen(false)}
        />
      )}
    </>
  );
}
