// src/image/ocr.ts — one-shot macOS Vision OCR bridge (ticket 07 #4/#5).
// Spawns swift/vision-ocr-cli (built via `swift build -c release`) via
// Bun.spawn and parses its JSON stdout. NEVER touches swift/embed-mlx-server.
import { existsSync } from "node:fs";

export interface OcrResult {
  text: string;
  width: number;
  height: number;
  format: string;
}

/** Repo-root-relative default binary path (src/image → pkg → bun-apps → root). */
export const DEFAULT_OCR_CLI = new URL(
  "../../../../swift/vision-ocr-cli/.build/release/vision-ocr-cli",
  import.meta.url,
).pathname;

export interface OcrOpts {
  /** Path to the vision-ocr-cli binary. Default: $VISION_OCR_CLI, then DEFAULT_OCR_CLI. */
  cliPath?: string;
}

/** Run OCR on one image. Returns undefined (never throws) when the CLI is
 *  missing or fails — callers degrade gracefully. */
export async function runVisionOcr(imagePath: string, opts: OcrOpts = {}): Promise<OcrResult | undefined> {
  const cli = opts.cliPath ?? process.env.VISION_OCR_CLI ?? DEFAULT_OCR_CLI;
  if (!existsSync(cli)) {
    process.stderr.write(
      `[file2md] vision-ocr-cli not found at ${cli} — build it with ( cd swift/vision-ocr-cli && swift build -c release )\n`,
    );
    return undefined;
  }
  const proc = Bun.spawn([cli, imagePath], { stdout: "pipe", stderr: "pipe" });
  const [stdout, , exitCode] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    process.stderr.write(`[file2md] vision-ocr-cli exited ${exitCode} for ${imagePath}\n`);
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout) as OcrResult;
    if (
      typeof parsed.text !== "string" ||
      typeof parsed.width !== "number" ||
      typeof parsed.height !== "number"
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
