import React, { useState, useEffect, useRef, useCallback } from "react";
import { Gallery } from "../../components/Gallery";
import { ImagePreview } from "../../components/ImagePreview";
import type { GalleryImage } from "../../types";

interface GalleryViewProps {
  highlight?: string[];
  onHighlightConsumed?: () => void;
}

export function GalleryView({ highlight, onHighlightConsumed }: GalleryViewProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewManifest, setPreviewManifest] = useState<Record<string, any> | null>(null);
  const [previewRun, setPreviewRun] = useState<Record<string, any> | null>(null);
  const [previewManifestPath, setPreviewManifestPath] = useState<string | null>(null);
  const [previewRunPath, setPreviewRunPath] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const highlightConsumedRef = useRef(false);

  useEffect(() => {
    const connect = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "job_complete") {
            if (refreshTimer.current) clearTimeout(refreshTimer.current);
            refreshTimer.current = window.setTimeout(() => setRefreshKey((k) => k + 1), 800);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        reconnectTimer.current = window.setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      wsRef.current?.close();
    };
  }, []);

  // Reset consumed flag when highlight changes
  useEffect(() => {
    if (highlight?.length) {
      highlightConsumedRef.current = false;
    }
  }, [highlight]);

  const handleImageClick = useCallback((img: GalleryImage) => {
    setPreviewImage(img.url);
    setPreviewManifest(img.manifest);
    setPreviewRun(img.run);
    setPreviewManifestPath(img.manifestPath ?? null);
    setPreviewRunPath(img.runPath ?? null);
  }, []);

  const handleClose = useCallback(() => {
    setPreviewImage(null);
    setPreviewManifest(null);
    setPreviewRun(null);
    setPreviewManifestPath(null);
    setPreviewRunPath(null);
  }, []);

  const handleImagesReady = useCallback((images: GalleryImage[]) => {
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
      <Gallery
        key={refreshKey}
        onImageClick={handleImageClick}
        highlight={highlightConsumedRef.current ? undefined : highlight}
        onImagesReady={handleImagesReady}
      />
      {previewImage && (
        <ImagePreview
          url={previewImage}
          manifest={previewManifest}
          run={previewRun}
          manifestPath={previewManifestPath}
          runPath={previewRunPath}
          onClose={handleClose}
        />
      )}
    </>
  );
}
