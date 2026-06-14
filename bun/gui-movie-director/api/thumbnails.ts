import fs from "fs";
import path from "path";
import { OUTPUT_DIRS } from "../lib/paths";

const THUMB_DIR = ".thumbs";
const THUMB_MAX_PX = 300; // max width/height for thumbnail, maintaining aspect ratio
const THUMB_QUALITY = 85; // JPEG quality %

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

/**
 * Get the thumbnail path for a given image file.
 * Returns { thumbPath, thumbRelPath } where thumbPath is the absolute
 * filesystem path and thumbRelPath is the URL-relative path.
 */
function getThumbPaths(dir: string, filename: string): { thumbPath: string; thumbRelPath: string } {
  const base = filename.replace(/\.[^.]+$/, "");
  const thumbName = `${base}_thumb.jpg`;
  const thumbDir = path.join(dir, THUMB_DIR);
  const thumbPath = path.join(thumbDir, thumbName);
  const dirIdx = OUTPUT_DIRS.indexOf(dir);
  const thumbRelPath = `/thumbs/${dirIdx}/${thumbName}`;
  return { thumbPath, thumbRelPath };
}

/**
 * Generate a thumbnail for an image using sips (macOS built-in).
 * Falls back to ffmpeg if sips is unavailable.
 * Returns true on success, false on failure.
 */
function generateThumbnail(sourcePath: string, thumbPath: string): boolean {
  try {
    // Ensure thumb directory exists
    const thumbDir = path.dirname(thumbPath);
    if (!fs.existsSync(thumbDir)) {
      fs.mkdirSync(thumbDir, { recursive: true });
    }

    // Use sips (built-in on macOS) — fast, no deps needed
    const sipsResult = Bun.spawnSync([
      "sips", "-Z", String(THUMB_MAX_PX),
      "-s", "format", "jpeg",
      "-s", "formatOptions", String(THUMB_QUALITY),
      sourcePath,
      "--out", thumbPath,
    ], { timeout: 15_000 });

    if (sipsResult.exitCode === 0 && fs.existsSync(thumbPath)) {
      return true;
    }

    // Fallback: ffmpeg (commonly available)
    console.warn(`[thumbnails] sips failed for ${sourcePath}, trying ffmpeg fallback`);
    const ffResult = Bun.spawnSync([
      "ffmpeg", "-y", "-i", sourcePath,
      "-vf", `scale='min(${THUMB_MAX_PX},iw)':min'(${THUMB_MAX_PX},ih)':force_original_aspect_ratio=decrease`,
      "-q:v", "3", // JPEG quality scale (2-5 is good)
      thumbPath,
    ], { timeout: 30_000 });

    if (ffResult.exitCode === 0 && fs.existsSync(thumbPath)) {
      return true;
    }

    console.error(`[thumbnails] Failed to generate thumbnail for ${sourcePath}: sips exit=${sipsResult.exitCode}, ffmpeg exit=${ffResult.exitCode}`);
    return false;
  } catch (err) {
    console.error(`[thumbnails] Error generating thumbnail for ${sourcePath}:`, err);
    return false;
  }
}

/**
 * Ensure a thumbnail exists for the given image. Returns the thumbnail URL
 * path if successful, null on failure.
 */
export function ensureThumbnail(dir: string, filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null; // only images get thumbnails

  const { thumbPath, thumbRelPath } = getThumbPaths(dir, filename);
  if (fs.existsSync(thumbPath)) {
    return thumbRelPath; // already exists
  }

  const sourcePath = path.join(dir, filename);
  if (!fs.existsSync(sourcePath)) return null;

  const ok = generateThumbnail(sourcePath, thumbPath);
  return ok ? thumbRelPath : null;
}

/**
 * Serve a thumbnail image. Lazy-generates if missing.
 * Supports ETag / 304 / range requests (same pattern as handleGalleryImage).
 */
export async function handleThumbnail(req: Request, filepath: string): Promise<Response> {
  const decoded = decodeURIComponent(filepath);
  // Format: "N/filename_thumb.jpg"
  const slashIdx = decoded.indexOf("/");
  const dirIdx = slashIdx !== -1 ? parseInt(decoded.slice(0, slashIdx), 10) : NaN;
  const validDirIdx = !isNaN(dirIdx) && dirIdx >= 0 && dirIdx < OUTPUT_DIRS.length;
  const name = validDirIdx ? decoded.slice(slashIdx + 1) : decoded;
  const dirsToSearch = validDirIdx ? [OUTPUT_DIRS[dirIdx]] : OUTPUT_DIRS;

  for (const dir of dirsToSearch) {
    const thumbPath = path.join(dir, THUMB_DIR, name);
    const resolved = path.normalize(thumbPath);
    if (!resolved.startsWith(path.resolve(dir))) continue;

    // Lazy generation: if thumbnail doesn't exist, try to derive source and generate
    if (!fs.existsSync(resolved)) {
      // Derive source filename from thumbnail name: "base_thumb.jpg" -> "base.png|jpg|jpeg"
      const thumbBase = name.replace(/_thumb\.jpg$/, "");
      let generated = false;
      for (const ext of IMAGE_EXTENSIONS) {
        const sourcePath = path.join(dir, `${thumbBase}${ext}`);
        if (fs.existsSync(sourcePath)) {
          generated = generateThumbnail(sourcePath, resolved);
          break;
        }
      }
      if (!generated) continue;
    }

    const stat = fs.statSync(resolved);
    const etag = `"${Bun.hash(`${stat.mtimeMs}:${stat.size}`).toString(16)}"`;

    if (req.headers.get("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }

    const rangeHeader = req.headers.get("Range");
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (m) {
        const totalSize = stat.size;
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), totalSize - 1) : totalSize - 1;
        if (start > end || start >= totalSize) {
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${totalSize}` } });
        }
        return new Response(Bun.file(resolved).slice(start, end + 1), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${totalSize}`,
            "Content-Length": String(end - start + 1),
            "Accept-Ranges": "bytes",
            ETag: etag,
            "Cache-Control": "no-cache",
          },
        });
      }
    }

    return new Response(Bun.file(resolved), {
      headers: { ETag: etag, "Cache-Control": "no-cache", "Accept-Ranges": "bytes",
                 "Content-Type": "image/jpeg" },
    });
  }
  return new Response("Not found", { status: 404 });
}

/**
 * Rebuild all thumbnails for all output directories.
 * Scans for images and generates missing thumbnails.
 * Returns { generated, failed, total }.
 */
export async function handleThumbnailRebuild(_req: Request): Promise<Response> {
  const results = { generated: 0, failed: 0, total: 0, skipped: 0 };

  for (const dir of OUTPUT_DIRS) {
    if (!fs.existsSync(dir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      // Skip files that end with _relay.png (video relay thumbnails)
      if (file.endsWith("_relay.png")) continue;

      results.total++;
      const { thumbPath } = getThumbPaths(dir, file);
      if (fs.existsSync(thumbPath)) {
        results.skipped++;
        continue;
      }

      const sourcePath = path.join(dir, file);
      if (!fs.existsSync(sourcePath)) continue;

      const ok = generateThumbnail(sourcePath, thumbPath);
      if (ok) results.generated++;
      else results.failed++;
    }
  }

  return Response.json(results);
}
