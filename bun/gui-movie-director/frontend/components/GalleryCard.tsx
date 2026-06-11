import React, { useRef } from "react";
import type { GalleryImage } from "../types";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getManifestSummary(manifest: any): string | null {
  if (!manifest) return null;
  const parts: string[] = [];
  if (manifest.command) parts.push(manifest.command);
  if (manifest.pipeline) parts.push(manifest.pipeline);
  if (manifest.seed != null) parts.push(`seed:${manifest.seed}`);
  return parts.join(" · ") || null;
}

export function GalleryCard({ img, onClick, highlighted }: { img: GalleryImage; onClick?: () => void; highlighted?: boolean }) {
  const summary = getManifestSummary(img.manifest);
  const isVideo = img.mediaType === "video";
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleVideoEnter = () => {
    videoRef.current?.play().catch(() => { /* ignore autoplay rejection */ });
  };

  const handleVideoLeave = () => {
    const v = videoRef.current;
    if (v) { v.pause(); v.currentTime = 0; }
  };

  return (
    <div
      className={`gallery-card${highlighted ? " gallery-card-highlighted" : ""}${isVideo ? " gallery-card-video" : ""}`}
      data-image-name={img.name}
      onClick={onClick}
      style={{ cursor: onClick ? "pointer" : undefined }}
    >
      <div className="gallery-card-image">
        {isVideo ? (
          <>
            <video
              ref={videoRef}
              src={img.url}
              poster={img.thumbnailUrl || undefined}
              preload="none"
              muted
              loop
              playsInline
              onMouseEnter={handleVideoEnter}
              onMouseLeave={handleVideoLeave}
            />
            <span className="gallery-card-play-badge">▶</span>
          </>
        ) : (
          <img src={img.url} alt={img.name} loading="lazy" />
        )}
      </div>
      <div className="gallery-card-info">
        <div className="gallery-card-name">{img.name}</div>
        <div className="gallery-card-meta">
          {formatSize(img.size)} · {formatDate(img.createdAt)}
        </div>
        {summary && (
          <div className="gallery-card-meta" style={{ color: "var(--accent)", marginTop: 2 }}>
            {summary}
          </div>
        )}
      </div>
    </div>
  );
}
