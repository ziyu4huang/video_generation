import React, { useRef } from "react";
import s from "./GalleryCard.module.css";
import type { GalleryImage } from "../types";
import { formatSize, formatDate } from "../utils/format";
import { parseCaptionScores } from "./CaptionScoreBar";
import { Tip } from "./Tip";

export type ViewMode = "s" | "m" | "l" | "list";

export function getManifestSummary(manifest: any): string | null {
  if (!manifest) return null;
  const parts: string[] = [];
  if (manifest.command) parts.push(manifest.command);
  if (manifest.pipeline) parts.push(manifest.pipeline);
  if (manifest.seed != null) parts.push(`seed:${manifest.seed}`);
  return parts.join(" · ") || null;
}

export function GalleryCard({ img, onClick, highlighted, viewMode = "m" }: { img: GalleryImage; onClick?: () => void; highlighted?: boolean; viewMode?: ViewMode }) {
  const summary = getManifestSummary(img.manifest);
  const isVideo = img.mediaType === "video";
  const videoRef = useRef<HTMLVideoElement>(null);

  // Derive average caption score for badge
  const captionScores = img.caption ? parseCaptionScores(img.caption.caption) : null;
  const avgScore = captionScores
    ? ["overall", "detail", "sharpness", "composition", "prompt_adherence", "artifacts"]
        .reduce((s, k) => s + ((captionScores[k] as number) || 0), 0) / 6
    : null;

  const handleVideoEnter = () => {
    videoRef.current?.play().catch(() => { /* ignore autoplay rejection */ });
  };

  const handleVideoLeave = () => {
    const v = videoRef.current;
    if (v) { v.pause(); v.currentTime = 0; }
  };

  if (viewMode === "list") {
    return (
      <div
        className={`${s.galleryCardList}${highlighted ? " " + s.galleryCardHighlighted : ""}`}
        data-image-name={img.name}
        onClick={onClick}
        style={{ cursor: onClick ? "pointer" : undefined }}
      >
        <img src={img.url} alt={img.name} loading="lazy" className={s.galleryCardListThumb} />
        <span className={s.galleryCardListName}>{img.name}</span>
        <span className={s.galleryCardListMeta}>{formatSize(img.size)} · {formatDate(img.createdAt)}</span>
      </div>
    );
  }

  return (
    <div
      className={`${s.galleryCard}${highlighted ? " " + s.galleryCardHighlighted : ""}${isVideo ? " " + s.galleryCardVideo : ""}${viewMode === "s" ? " " + s.galleryCardSmall : ""}`}
      data-image-name={img.name}
      onClick={onClick}
      style={{ cursor: onClick ? "pointer" : undefined }}
    >
      <div className={s.galleryCardImage}>
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
            <span className={s.galleryCardPlayBadge}>▶</span>
          </>
        ) : (
          <img src={img.url} alt={img.name} loading="lazy" />
        )}
        {avgScore !== null && (
          <Tip label={`Caption quality: ${avgScore.toFixed(1)}/10`}>
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
              cursor: "default",
            }}>
              {avgScore.toFixed(1)}
            </span>
          </Tip>
        )}
      </div>
      <div className={s.galleryCardInfo}>
        <div className={s.galleryCardName}>{img.name}</div>
        <div className={s.galleryCardMeta}>
          {formatSize(img.size)} · {formatDate(img.createdAt)}
        </div>
        {summary && (
          <div className={s.galleryCardMeta} style={{ color: "var(--accent)", marginTop: 2 }}>
            {summary}
          </div>
        )}
      </div>
    </div>
  );
}
