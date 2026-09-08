/**
 * Receipt writer (spec §7) — one JSON per tech per case under the sweep dir;
 * screen snaps ride alongside when a screen exists (never committed).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CaseReceipt } from "./types.js";

export function writeCaseReceipt(outDir: string, r: CaseReceipt, screen?: string | null): string {
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `case-${r.case}.json`);
  writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  if (screen != null && screen.trim().length > 0) {
    writeFileSync(path.join(outDir, `case-${r.case}.snap.txt`), `${screen}\n`);
  }
  return file;
}
