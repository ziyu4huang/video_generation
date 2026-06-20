import React, { useState, useEffect } from "react";
import { GalleryCard } from "./GalleryCard";
import { ImagePreview } from "./ImagePreview";
import type { GalleryImage, JobInfo } from "../types";
import { toast } from "../utils/toast";
import { fetchGallery, } from "../api/gallery";
import { runJob } from "../api/jobs";

interface Props {
  job: JobInfo;
  onViewInGallery: () => void;
}

export function JobOutputPreview({ job, onViewInGallery }: Props) {
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [preview, setPreview] = useState<GalleryImage | null>(null);

  useEffect(() => {
    if (job.status !== "completed") return;
    fetchGallery(20)
      .then((data) => {
        const jobStart = new Date(job.startedAt).getTime();
        setImages(
          data.images.filter(
            (img) => new Date(img.createdAt).getTime() >= jobStart
          )
        );
      })
      .catch(() => {});
  }, [job.status, job.startedAt]);

  if (images.length === 0) return null;

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <h3 style={{ fontSize: 14, color: "var(--text-bright)" }}>
          Output ({images.length})
        </h3>
        {job.action && (
          <button
            className="btn"
            onClick={async () => {
              try {
                const data = await runJob(job.action!, job.params ?? {});
                if (data.jobId) {
                  toast.success("Run started");
                } else if (data.error) {
                  toast.error(data.error);
                }
              } catch (err) {
                toast.error(`Failed: ${err}`);
              }
            }}
            style={{ marginLeft: "auto", fontSize: 12, padding: "4px 14px" }}
          >
            🔁 Run Again
          </button>
        )}
        <button
          className="btn btn-primary"
          onClick={onViewInGallery}
          style={{ marginLeft: job.action ? 8 : "auto", fontSize: 12, padding: "4px 14px" }}
        >
          View in Gallery →
        </button>
      </div>
      <div className="gallery-grid">
        {images.map((img) => (
          <GalleryCard key={img.url} img={img} onClick={() => setPreview(img)} />
        ))}
      </div>
      {preview && (
        <ImagePreview
          url={preview.url}
          manifest={preview.manifest}
          run={preview.run}
          manifestPath={preview.manifestPath}
          runPath={preview.runPath}
          caption={preview.caption}
          captionPath={preview.captionPath}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
