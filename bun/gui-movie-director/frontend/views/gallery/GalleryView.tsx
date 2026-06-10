import React, { useState, useEffect, useRef, useCallback } from "react";
import { Gallery } from "../../components/Gallery";
import { ImagePreview } from "../../components/ImagePreview";
import type { GalleryImage } from "../../types";

export function GalleryView() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewManifest, setPreviewManifest] = useState<Record<string, any> | null>(null);
  const [previewRun, setPreviewRun] = useState<Record<string, any> | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const refreshTimer = useRef<number | null>(null);

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

  const handleImageClick = useCallback((img: GalleryImage) => {
    setPreviewImage(img.url);
    setPreviewManifest(img.manifest);
    setPreviewRun(img.run);
  }, []);

  const handleClose = useCallback(() => {
    setPreviewImage(null);
    setPreviewManifest(null);
    setPreviewRun(null);
  }, []);

  return (
    <>
      <Gallery key={refreshKey} onImageClick={handleImageClick} />
      {previewImage && (
        <ImagePreview
          url={previewImage}
          manifest={previewManifest}
          run={previewRun}
          onClose={handleClose}
        />
      )}
    </>
  );
}
