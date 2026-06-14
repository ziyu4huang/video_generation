import React from "react";
import s from "./Skeleton.module.css";

/**
 * Skeleton card placeholder for gallery grids.
 * Matches the aspect ratio and info layout of GalleryCard.
 */
export function SkeletonCard() {
  return (
    <div className={s.skeletonCard}>
      <div className={`${s.skeleton} ${s.skeletonCardImage}`} />
      <div className={s.skeletonCardText}>
        <div className={`${s.skeleton} ${s.skeletonCardLine} ${s.skeletonCardLineLong}`} />
        <div className={`${s.skeleton} ${s.skeletonCardLine} ${s.skeletonCardLineShort}`} />
      </div>
    </div>
  );
}

/**
 * Skeleton row placeholder for list views (list mode, job history).
 */
export function SkeletonRow() {
  return (
    <div className={s.skeletonRow}>
      <div className={`${s.skeleton} ${s.skeletonRowThumb}`} />
      <div className={s.skeletonRowContent}>
        <div className={`${s.skeleton} ${s.skeletonRowLine} ${s.skeletonRowLineTitle}`} />
        <div className={`${s.skeleton} ${s.skeletonRowLine} ${s.skeletonRowLineMeta}`} />
      </div>
      <div className={`${s.skeleton} ${s.skeletonRowBadge}`} />
    </div>
  );
}

/**
 * Skeleton form section placeholder for settings panels.
 * Resembles the FormSection structure with title + fields.
 */
export function SkeletonFormSection() {
  return (
    <div className={s.skeletonFormSection}>
      <div className={`${s.skeleton} ${s.skeletonFormSectionTitle}`} />
      <div className={s.skeletonFormBody}>
        <div className={s.skeletonFormField}>
          <div className={`${s.skeleton} ${s.skeletonFormLabel}`} />
          <div className={`${s.skeleton} ${s.skeletonFormInput}`} />
        </div>
        <div className={s.skeletonFormRow}>
          <div className={s.skeletonFormField}>
            <div className={`${s.skeleton} ${s.skeletonFormLabel}`} />
            <div className={`${s.skeleton} ${s.skeletonFormInput}`} />
          </div>
          <div className={s.skeletonFormField}>
            <div className={`${s.skeleton} ${s.skeletonFormLabel}`} />
            <div className={`${s.skeleton} ${s.skeletonFormInput}`} />
          </div>
        </div>
      </div>
    </div>
  );
}
