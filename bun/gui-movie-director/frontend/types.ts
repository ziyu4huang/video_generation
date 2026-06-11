export interface JobInfo {
  id: string;
  command: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  outputFiles: string[];
  logs: string[];
}

export interface GalleryImage {
  name: string;
  url: string;
  size: number;
  createdAt: string;
  manifest: Record<string, any> | null;
  run: Record<string, any> | null;
  manifestPath?: string | null;
  runPath?: string | null;
}
