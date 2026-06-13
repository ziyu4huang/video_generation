import fs from "fs";
import path from "path";
import { GUI_DIR_ABS } from "./config";
import type { Job } from "./subprocess";
import { readJsonFile, writeJsonFile } from "./fsUtils";

const DATA_DIR = path.join(GUI_DIR_ABS, "data");
const JOBS_PATH = path.join(DATA_DIR, "jobs.json");
const MAX_JOBS = 500;

export function saveJobs(jobs: Job[]): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const capped = [...jobs]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, MAX_JOBS);
  writeJsonFile(JOBS_PATH, capped);
}

export function loadJobs(): Job[] {
  const loaded = readJsonFile<Job[]>(JOBS_PATH) ?? [];
  // Migrate old string[] logs to LogLine[] format
  for (const job of loaded) {
    if (job.logs.length > 0 && typeof (job.logs as any)[0] === "string") {
      (job as any).logs = (job.logs as unknown as string[]).map((t) => ({ text: t, stream: "stdout" }));
    }
  }
  return loaded;
}
