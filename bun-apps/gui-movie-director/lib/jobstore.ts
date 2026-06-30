import fs from "fs";
import path from "path";
import { GUI_DIR_ABS } from "./config";
import type { Job } from "./subprocess";
import { readJsonFile } from "./fsUtils";

const DATA_DIR = path.join(GUI_DIR_ABS, "data");
const JOBS_PATH = path.join(DATA_DIR, "jobs.json");
const MAX_JOBS = 500;

// Serializes saveJobs writes: each call chains off the previous so concurrent
// saveJobs invocations flush to disk in call order. Without this, overlapping
// Bun.write promises resolve non-deterministically and an older snapshot can
// clobber a newer one (last-write-wins on disk).
let saveChain: Promise<void> = Promise.resolve();

export function saveJobs(jobs: Job[]): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const capped = [...jobs]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, MAX_JOBS);
  // Non-blocking to the caller, but serialized so writes flush in order.
  saveChain = saveChain
    .then(() => Bun.write(JOBS_PATH, JSON.stringify(capped, null, 2) + "\n"))
    .then(() => undefined)
    .catch(() => {});
}

export function loadJobs(): Job[] {
  const loaded = readJsonFile<Job[]>(JOBS_PATH) ?? [];
  // Migrate old string[] logs to LogLine[] format
  for (const job of loaded) {
    // Guard logs like outputUrls below: a persisted job with a missing or
    // non-array logs field (external edit, older/partial format) would throw a
    // TypeError on job.logs.length and crash server boot (loadJobs runs
    // unguarded at startup). Coerce to [] first.
    if (!Array.isArray((job as any).logs)) (job as any).logs = [];
    if (job.logs.length > 0 && typeof (job.logs as any)[0] === "string") {
      (job as any).logs = (job.logs as unknown as string[]).map((t) => ({ text: t, stream: "stdout" }));
    }
    if (!Array.isArray((job as any).outputUrls)) {
      (job as any).outputUrls = [];
    }
  }
  return loaded;
}
