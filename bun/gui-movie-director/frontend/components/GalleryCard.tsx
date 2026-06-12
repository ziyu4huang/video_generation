import React, { useRef } from "react";
import type { GalleryImage } from "../types";
import { formatSize, formatDate } from "../utils/format";
import { parseCaptionScores } from "./CaptionScoreBar";

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

  // Derive average caption score for badge
  const captionScores = img.caption ? parseCaptionScores(img.caption.caption) : null;
  const avgScore = captionScores
    ? ["overall", "detail", "sharpness", "composition", "prompt_adherence", "artifacts"]
        .reduce((s, k) => s + (captionScores[k] || 0), 0) / 6
    : null;

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
        {avgScore !== null && (
          <span style={{
            position: "absolute",
            top: 6,
            right: 6,
            background: avgScore >= 8 ? "rgba(76,175,80,0.9)" : avgScore >= 5 ? "rgba(255,152,0,0.9)" : "rgba(244,67,54,0.9)",
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            padding: "2px 6px",
            borderRadius: 4,
            lineHeight: 1,
          }}>
            {avgScore.toFixed(1)}
          </span>
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
