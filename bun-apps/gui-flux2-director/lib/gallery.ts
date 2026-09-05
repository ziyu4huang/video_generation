/**
 * gallery.ts — read the flux2 output dir's audit sidecars into gallery items.
 *
 * Every flux2 generation writes `<base>.png` + `<base>.run.json` (RunConfig:
 * prompt/seed/steps/lora_paths/…) + `<base>.manifest.json` (timings, output
 * files, sizes). The gallery is a read-only projection of those sidecars —
 * newest first — so anything the CLI produced (including by hand) shows up.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import path from "path";

import { OUTPUT_DIR } from "./paths";

export interface GalleryItem {
  /** Absolute path of the PNG. */
  png: string;
  baseName: string;
  /** File mtime of the PNG (ms epoch) — sort key. */
  mtimeMs: number;
  width?: number;
  height?: number;
  seed?: string;
  steps?: number;
  prompt?: string;
  negativePrompt?: string;
  cfgScale?: number;
  transformer?: string;
  command?: string;
  loras?: string[];
  /** Per-LoRA scales, parallel to `loras` when the run recorded them. */
  loraScales?: number[];
  elapsedSec?: number;
  /** ISO creation time from the run.json sidecar. */
  createdAt?: string;
}

interface RunConfigShape {
  prompt?: string;
  negative_prompt?: string;
  steps?: number;
  cfg_scale?: number;
  transformer?: string;
  lora_paths?: string[] | null;
  lora_scales?: number[] | null;
  command?: string;
  created_at?: string;
}

interface ManifestShape {
  output_files?: Array<{
    path?: string;
    seed?: number;
    width?: number;
    height?: number;
  }>;
  timings?: Record<string, number>;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Parse one `<base>.png` + sidecars trio into a gallery item (null if no PNG). */
export function parseOutputBase(dir: string, base: string, mtimeMs: number): GalleryItem | null {
  const png = path.join(dir, `${base}.png`);
  if (!existsSync(png)) return null;
  const run = readJson<RunConfigShape>(path.join(dir, `${base}.run.json`));
  const manifest = readJson<ManifestShape>(path.join(dir, `${base}.manifest.json`));
  const of = manifest?.output_files?.[0];
  return {
    png,
    baseName: base,
    mtimeMs,
    width: of?.width,
    height: of?.height,
    seed: of?.seed !== undefined ? String(of.seed) : undefined,
    steps: run?.steps,
    prompt: run?.prompt,
    negativePrompt: run?.negative_prompt,
    cfgScale: run?.cfg_scale,
    transformer: run?.transformer,
    command: run?.command,
    loras: run?.lora_paths ?? undefined,
    loraScales: run?.lora_scales ?? undefined,
    elapsedSec: manifest?.timings?.generation,
    createdAt: run?.created_at,
  };
}

/**
 * List the output dir newest-first. Skips subdirs (uploads/, scratch) and any
 * base whose PNG is missing. Hard-capped so a 10k-image dir can't stall the
 * server: reads only the newest `limit` trios.
 */
export function listGallery(outputDir: string = OUTPUT_DIR, limit = 200): GalleryItem[] {
  if (!existsSync(outputDir)) return [];
  const pngs = readdirSync(outputDir)
    .filter((f) => f.endsWith(".png") && !f.startsWith("."))
    .map((f) => {
      const full = path.join(outputDir, f);
      let mtimeMs = 0;
      let isFile = true;
      try {
        isFile = statSync(full).isFile();
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        /* raced delete — sorts last, parse returns null */
      }
      return { base: f.slice(0, -".png".length), mtimeMs: isFile ? mtimeMs : -1 };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);

  const items: GalleryItem[] = [];
  for (const { base, mtimeMs } of pngs) {
    if (mtimeMs < 0) continue; // directory named *.png
    const item = parseOutputBase(outputDir, base, mtimeMs);
    if (item) items.push(item);
  }
  return items;
}
