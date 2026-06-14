import fs from "fs";
import path from "path";
import { loadConfig } from "../lib/config";
import { isPathAllowed } from "../lib/paths";
import { readJsonFile } from "../lib/fsUtils";
import { parsePostJson } from "../lib/requestUtils";

/**
 * Run caption (VLM analysis) on an image via `run.py caption`.
 * Uses SubprocessManager pattern but simpler — caption is a quick one-shot call
 * (not a long-running job), so we await the subprocess directly.
 */
export async function handleCaptionRun(req: Request): Promise<Response> {
  const body = await parsePostJson<{ image?: string; style?: string; prompt?: string }>(req);
  if (body instanceof Response) return body;
  const { image, style, prompt } = body;
  if (!image) {
    return Response.json({ ok: false, error: "Missing 'image' path" }, { status: 400 });
  }
  // image is forwarded as run.py caption's POSITIONAL arg. A leading-dash value
  // (e.g. "--steps") bypasses isPathAllowed — path.resolve("--steps") lands under
  // REPO_DIR, so the directory-prefix check passes — and argparse then treats it
  // as a flag, not a positional. Reject it explicitly to close the
  // argument-injection gap (same class as the selftest test_name fix). prompt and
  // style are safe: they follow value-taking flags, so argparse consumes the next
  // token as their value even if it looks like a flag.
  if (image.trimStart().startsWith("-")) {
    return Response.json({ ok: false, error: "Invalid 'image' path" }, { status: 400 });
  }

  if (!isPathAllowed(image)) {
    return Response.json({ ok: false, error: "Image path outside allowed directories" }, { status: 403 });
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

    const captionResult = captionPath && fs.existsSync(captionPath)
      ? readJsonFile(captionPath)
      : null;

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
    return Response.json({ ok: false, error: "Missing 'image' query param" }, { status: 400 });
  }

  if (!isPathAllowed(imagePath)) {
    return Response.json({ ok: false, error: "Image path outside allowed directories" }, { status: 403 });
  }
  const resolvedImage = path.resolve(imagePath);

  // Derive caption path: image.png → image.caption.json
  const base = resolvedImage.replace(/\.[^.]+$/, "");
  const captionPath = `${base}.caption.json`;

  if (!fs.existsSync(captionPath)) {
    return Response.json({ ok: true, caption: null });
  }

  const caption = readJsonFile(captionPath);
  if (caption === null) return Response.json({ ok: true, caption: null });
  return Response.json({ ok: true, caption, captionPath });
}
