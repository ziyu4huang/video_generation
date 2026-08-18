/**
 * jsonl-mirror.ts — the ONE shared JSONL persistence pattern (webui-simplify
 * §4). Both per-port mirrors (report-persist, btw-store) previously carried
 * identical best-effort filesystem code: mkdir-on-append, tolerant read,
 * order-preserving rewrite. Contract (inherited from report-persist):
 * BEST-EFFORT — persistence must NEVER break a broadcast or a route; every
 * filesystem error is swallowed here.
 *
 * Line semantics: values are JSON.stringify'd + newline; readLines returns
 * TRIMMED, NON-EMPTY lines (parsing + validation stay with the caller —
 * report validates frames, btw replays create/resolve events); corrupt
 * lines are preserved verbatim so compaction keeps them (loads skip them).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Best-effort append — mkdir -p the parent, one JSON line; never throws. */
export function appendLine(path: string, value: unknown): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, JSON.stringify(value) + "\n", "utf8");
  } catch {
    /* best-effort by contract */
  }
}

/** Tolerant read — missing file -> []; blank lines skipped; never throws. */
export function readLines(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    const out: string[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const s = line.trim();
      if (s !== "") out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

/** Best-effort rewrite — order preserved, single trailing newline; never throws. */
export function rewriteLines(path: string, lines: string[]): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
  } catch {
    /* best-effort by contract */
  }
}
