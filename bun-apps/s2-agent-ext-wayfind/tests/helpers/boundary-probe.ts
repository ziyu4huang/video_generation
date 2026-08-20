/**
 * Child-process probe for the effort-folder-date vs manifest-`created` UTC-
 * boundary consistency test (see wayfinder.test.ts → "Ticket 06").
 *
 * WHY A SEPARATE PROCESS: Bun honors the `TZ` environment variable, so the
 * parent test spawns this probe with TZ=America/New_York pinned on it — forcing
 * the child into EDT (UTC-4) regardless of the host's own zone (the host tz is
 * irrelevant; this is NOT a UTC pin). Because TZ is process-global, mutating it
 * leaks across every test file in the run, so the process-local mutation stays
 * confined to the child, leaving the host suite untouched.
 *
 * WHAT IT DOES: under a zone BEHIND UTC (EDT, UTC-4) it pins a local-evening
 * clock where local-date ≠ utc-date, runs effortSlug + chartMap + readMap, and
 * prints `{ folderDate, created }` as JSON on stdout's last line. The parent
 * asserts folderDate === created (the consistency invariant — breaks when the
 * manifest `created` uses UTC while the folder name uses local time).
 *
 * Debug it directly:  TZ=America/New_York bun tests/helpers/boundary-probe.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMap } from "../../src/map.js";
import { chartMap, effortSlug } from "../../src/wayfinder.js";

// America/New_York in August is EDT (UTC-4): local 2026-08-04 23:30 == UTC
// 2026-08-05 03:30 → local-date 2026-08-04, utc-date 2026-08-05 (diverges +1).
const now = new Date(2026, 7, 4, 23, 30);
const cwd = mkdtempSync(join(tmpdir(), "wf-boundary-"));
try {
  const effort = effortSlug("boundary demo", now); // folder name → LOCAL date
  chartMap(cwd, effort, "a UTC-boundary probe", "", now); // created → today(now)
  const created = readMap(cwd, effort)?.meta?.created ?? null;
  console.log(JSON.stringify({ folderDate: effort.slice(0, 10), created }));
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
