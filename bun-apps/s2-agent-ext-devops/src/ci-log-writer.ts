/**
 * ci-log-writer — the live MC-2 failureLogWriter: persists every FAILED step's
 * full output under `<repoRoot>/output/ci-logs/<label>-<timestamp>/<step>.log`.
 *
 * - LAZY: the directory is created on the FIRST write, so green runs leave no
 *   empty dirs behind ("green runs write nothing").
 * - DEDUPLICATED: two failures with the same step name get `-2`, `-3`, … files
 *   instead of overwriting (parallel phases can genuinely produce them).
 * - SANITIZED: step names are reduced to `[a-z0-9._-]` — they embed package
 *   names and gate descriptions with slashes/colons.
 *
 * `output/` is repo-gitignored, so these logs never reach a commit.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CiFailureLogWriter {
  /** Persist one failed step's full output; resolves to the written path. */
  write: (step: string, content: string) => Promise<string>;
  /** The directory this writer persists into (created lazily). */
  dir: string;
}

/** Reduce a step label to a safe file stem; empty input becomes "step". */
export function sanitizeStepName(step: string): string {
  const cleaned = step
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "step";
}

function timestamp(now: () => Date = () => new Date()): string {
  const d = now();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Build the writer for one local-CI run. Deterministic per (label, time). */
export async function createCiLogWriter(repoRoot: string, label: string): Promise<CiFailureLogWriter> {
  const dir = join(repoRoot, "output", "ci-logs", `${sanitizeStepName(label)}-${timestamp()}`);
  const used = new Set<string>();
  return {
    dir,
    write: async (step: string, content: string) => {
      await mkdir(dir, { recursive: true });
      const base = sanitizeStepName(step);
      let name = `${base}.log`;
      let n = 2;
      while (used.has(name)) {
        name = `${base}-${n}.log`;
        n += 1;
      }
      used.add(name);
      const path = join(dir, name);
      await writeFile(path, content, "utf8");
      return path;
    },
  };
}
