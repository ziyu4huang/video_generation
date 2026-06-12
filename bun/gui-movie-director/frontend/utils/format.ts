/**
 * Shared formatting utilities used across multiple components.
 * Extracted to avoid duplication — single source of truth for format logic.
 */

/** Format byte count to human-readable string (B / KB / MB / GB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Alias for formatBytes — used by GalleryCard and similar components. */
export { formatBytes as formatSize };

/** Relative time from ISO timestamp (e.g. "just now", "5m ago", "2h ago"). */
export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Locale-formatted date (e.g. "Jun 12, 3:45 PM"). */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Extract the last segment of a file path. */
export function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}
