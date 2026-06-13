export interface LogLine {
  text: string;
  stream: "stdout" | "stderr";
}

export interface JobInfo {
  id: string;
  command: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  outputFiles: string[];
  manifestPath?: string;
  runPath?: string;
  action?: string;
  params?: Record<string, any>;
  logs: LogLine[];
}

export interface GalleryImage {
  name: string;
  url: string;
  size: number;
  createdAt: string;
  mediaType?: "image" | "video";
  thumbnailUrl?: string | null;
  manifest: Record<string, any> | null;
  run: Record<string, any> | null;
  manifestPath?: string | null;
  runPath?: string | null;
  caption?: Record<string, any> | null;
  captionPath?: string | null;
}
