import React from "react";

interface ImagePreviewProps {
  url: string;
  onClose: () => void;
}

export function ImagePreview({ url, onClose }: ImagePreviewProps) {
  return (
    <div className="image-preview-overlay" onClick={onClose}>
      <button className="image-preview-close" onClick={onClose}>✕</button>
      <div className="image-preview-content">
        <img src={url} alt="Preview" />
      </div>
    </div>
  );
}
