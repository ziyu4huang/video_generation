import fs from "fs";
import path from "path";
import { loadConfig } from "../lib/config";
import { isPathAllowed, OUTPUT_DIRS, RUN_PY } from "../lib/paths";
import { readJsonFile } from "../lib/fsUtils";
import { parsePostJson } from "../lib/requestUtils";

/**
 * Run caption (VLM analysis) on an image via `run.py caption`.
 * Uses SubprocessManager pattern but simpler — caption is a quick one-shot call
 * (not a long-running job), so we await the subprocess directly.
 */
export async function handleCaptionRun(req: Request): Promise<Response> {
  const body = await parsePostJson<{ image?: string; style?: string; prompt?: string; url?: string }>(req);
  if (body instanceof Response) return body;
  let { image, style, prompt, url } = body;

  // Resolve url → image when frontend sends /output/N/filename
  if (!image && url) {
    const m = url.match(/^\/output\/(\d+)\/(.+)/);
    if (!m) {
      return Response.json({ ok: false, error: "Invalid 'url' — expected /output/<N>/<filename>" }, { status: 400 });
    }
    const dirIdx = parseInt(m[1], 10);
    if (dirIdx < 0 || dirIdx >= OUTPUT_DIRS.length) {
      return Response.json({ ok: false, error: "Invalid output directory index" }, { status: 400 });
    }
    image = path.join(OUTPUT_DIRS[dirIdx], m[2]);
  }

  if (!image) {
    return Response.json({ ok: false, error: "Missing 'image' path or 'url'" }, { status: 400 });
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

  // Only check isPathAllowed when image was provided directly (not resolved from url)
  // URL-resolved paths come from server-known directories and are safe.
  if (!url && !isPathAllowed(image)) {
    return Response.json({ ok: false, error: "Image path outside allowed directories" }, { status: 403 });
  }
  if (url) {
    // Still verify the resolved path is under one of the output dirs
    const resolved = path.resolve(image);
    if (!OUTPUT_DIRS.some((d) => resolved.startsWith(d + path.sep) || resolved === d)) {
      return Response.json({ ok: false, error: "Resolved image path outside output directories" }, { status: 403 });
    }
  }

  const cfg = loadConfig();
  const args = [
    RUN_PY,
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
 * Accepts ?image=<path> (filesystem) or ?url=/output/N/<filename>.
 */
export async function handleCaptionGet(req: Request): Promise<Response> {
  const reqUrl = new URL(req.url);
  let imagePath = reqUrl.searchParams.get("image");
  const imageUrl = reqUrl.searchParams.get("url");

  // Resolve url → image when frontend sends /output/N/filename
  if (!imagePath && imageUrl) {
    const m = imageUrl.match(/^\/output\/(\d+)\/(.+)/);
    if (!m) {
      return Response.json({ ok: false, error: "Invalid 'url' — expected /output/<N>/<filename>" }, { status: 400 });
    }
    const dirIdx = parseInt(m[1], 10);
    if (dirIdx < 0 || dirIdx >= OUTPUT_DIRS.length) {
      return Response.json({ ok: false, error: "Invalid output directory index" }, { status: 400 });
    }
    imagePath = path.join(OUTPUT_DIRS[dirIdx], m[2]);
  }

  if (!imagePath) {
    return Response.json({ ok: false, error: "Missing 'image' or 'url' query param" }, { status: 400 });
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
