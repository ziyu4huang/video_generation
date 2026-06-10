import fs from "fs";
import path from "path";
import { GUI_DIR_ABS } from "./config";
import type { Job } from "./subprocess";

const DATA_DIR = path.join(GUI_DIR_ABS, "data");
const JOBS_PATH = path.join(DATA_DIR, "jobs.json");
const MAX_JOBS = 500;

export function saveJobs(jobs: Job[]): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const capped = [...jobs]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, MAX_JOBS);
  fs.writeFileSync(JOBS_PATH, JSON.stringify(capped, null, 2) + "\n");
}

export function loadJobs(): Job[] {
  try {
    if (fs.existsSync(JOBS_PATH)) return JSON.parse(fs.readFileSync(JOBS_PATH, "utf-8"));
  } catch { /* ignore corrupt file */ }
  return [];
}
