import fs from "fs";
import path from "path";
import { loadConfig } from "../lib/config";

/**
 * Run caption (VLM analysis) on an image via `run.py caption`.
 * Uses SubprocessManager pattern but simpler — caption is a quick one-shot call
 * (not a long-running job), so we await the subprocess directly.
 */
export async function handleCaptionRun(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: { image?: string; style?: string; prompt?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { image, style, prompt } = body;
  if (!image) {
    return Response.json({ error: "Missing 'image' path" }, { status: 400 });
  }

  const cfg = loadConfig();
  const args = [
    path.resolve(import.meta.dir, "../../python/mlx-movie-director/run.py"),
    "caption",
    image,
    "--style", style || "score",
    "--api-url", cfg.vlmApiUrl,
    "--model", cfg.vlmModel,
    "--lang", "en",
  ];
  if (prompt) {
    args.push("--prompt", prompt);
  }

  try {
    const proc = Bun.spawn([cfg.pythonPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return Response.json({
        ok: false,
        error: stderr.trim() || `Caption failed (exit ${exitCode})`,
      }, { status: 500 });
    }

    // Parse the output to find the saved caption JSON path
    const savedMatch = stdout.match(/Saved:\s+(.+)/);
    const captionPath = savedMatch ? savedMatch[1].trim() : null;

    // Try to read the caption JSON if available
    let captionResult = null;
    if (captionPath && fs.existsSync(captionPath)) {
      try {
        captionResult = JSON.parse(fs.readFileSync(captionPath, "utf-8"));
      } catch { /* ignore parse errors */ }
    }

    return Response.json({ ok: true, captionPath, caption: captionResult });
  } catch (err: any) {
    return Response.json({
      ok: false,
      error: err.message || "Caption failed",
    }, { status: 500 });
  }
}

/**
 * Read an existing .caption.json file for a given image.
 */
export async function handleCaptionGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const imagePath = url.searchParams.get("image");
  if (!imagePath) {
    return Response.json({ error: "Missing 'image' query param" }, { status: 400 });
  }

  // Derive caption path: image.png → image.caption.json
  const base = imagePath.replace(/\.[^.]+$/, "");
  const captionPath = `${base}.caption.json`;

  if (!fs.existsSync(captionPath)) {
    return Response.json({ ok: true, caption: null });
  }

  try {
    const caption = JSON.parse(fs.readFileSync(captionPath, "utf-8"));
    return Response.json({ ok: true, caption, captionPath });
  } catch {
    return Response.json({ ok: true, caption: null });
  }
}
