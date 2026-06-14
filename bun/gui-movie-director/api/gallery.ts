import fs from "fs";
import path from "path";
import { OUTPUT_DIRS } from "../lib/paths";
import { readJsonFile } from "../lib/fsUtils";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v"]);

function gzipJsonResponse(req: Request, json: unknown): Response {
  const body = JSON.stringify(json);
  if (req.headers.get("Accept-Encoding")?.includes("gzip")) {
    const compressed = Bun.gzipSync(body);
    return new Response(compressed, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
        "Vary": "Accept-Encoding",
      },
    });
  }
  return Response.json(json);
}

interface ImageEntry {
  name: string;
  url: string;
  size: number;
  createdAt: string;
  mediaType: "image" | "video";
  thumbnailUrl?: string | null;
  width?: number;
  height?: number;
  manifest?: Record<string, any> | null;
  run?: Record<string, any> | null;
  manifestPath?: string | null;
  runPath?: string | null;
  caption?: Record<string, any> | null;
  captionPath?: string | null;
}

/**
 * Try progressively shorter base names to find companion manifest/run JSON.
 * Handles: base, base_seg01, base_relay, base_seg01_relay patterns.
 */
function findCompanionJson(dir: string, base: string, suffix: ".manifest.json" | ".run.json" | ".caption.json"): string | null {
  const candidates = [
    base,                              // full base: output_20260611_193630_seg01
    base.replace(/_relay$/, ""),       // strip _relay
    base.replace(/_seg\d+$/, ""),      // strip _segXX
    base.replace(/_relay$/, "").replace(/_seg\d+$/, ""),  // strip both
    base.replace(/_seg\d+_relay$/, ""),                    // strip _segXX_relay in one go
  ];
  // Deduplicate while preserving order
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const p = path.join(dir, `${c}${suffix}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getMediaType(filename: string): "image" | "video" {
  const ext = path.extname(filename).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext) ? "video" : "image";
}

// Shared: scan raw filesystem entries across all output dirs
type RawEntry = { name: string; dir: string; fullPath: string; mtime: number; size: number };

const MEDIA_GLOB = new Bun.Glob("*.{png,jpg,jpeg,mp4,mov,webm,m4v}");

function scanRawEntries(): { entries: RawEntry[]; dirFileCache: Map<string, Set<string>> } {
  const entries: RawEntry[] = [];
  const dirFileCache = new Map<string, Set<string>>();

  for (const dir of OUTPUT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    // dirFileCache needs all files (for thumbnail lookup), media scan uses Glob
    const allFiles = fs.readdirSync(dir);
    dirFileCache.set(dir, new Set(allFiles));

    const mediaFiles = [...MEDIA_GLOB.scanSync({ cwd: dir, onlyFiles: true })]
      .filter((f) => !f.endsWith("_relay.png"));

    const dirEntries = mediaFiles
      .map((f) => {
        const fullPath = path.join(dir, f);
        try {
          const stat = fs.statSync(fullPath);
          return { name: f, dir, fullPath, mtime: stat.mtimeMs, size: stat.size };
        } catch { return null; }
      })
      .filter((e): e is RawEntry => e !== null);

    entries.push(...dirEntries);
  }

  entries.sort((a, b) => b.mtime - a.mtime);
  return { entries, dirFileCache };
}

function buildImageEntry(entry: RawEntry, dirFileCache: Map<string, Set<string>>): ImageEntry {
    const base = entry.name.replace(/\.[^.]+$/, "");
    const mediaType = getMediaType(entry.name);

    const manifestPath = findCompanionJson(entry.dir, base, ".manifest.json");
    const manifest = manifestPath ? readJsonFile(manifestPath) : null;

    const runPath = findCompanionJson(entry.dir, base, ".run.json");
    const run = runPath ? readJsonFile(runPath) : null;

    const dirIdx = OUTPUT_DIRS.indexOf(entry.dir);
    let thumbnailUrl: string | null = null;
    if (mediaType === "video") {
      const fileIndex = dirFileCache.get(entry.dir) ?? new Set<string>();
      for (const c of [`${base}_relay.png`, `${base}.png`]) {
        if (fileIndex.has(c)) { thumbnailUrl = `/output/${dirIdx}/${c}`; break; }
      }
    }

    const captionPath = findCompanionJson(entry.dir, base, ".caption.json");
    const caption = captionPath ? readJsonFile(captionPath) : null;

    return {
      name: entry.name,
      url: `/output/${dirIdx}/${entry.name}`,
      size: entry.size,
      createdAt: new Date(entry.mtime).toISOString(),
      mediaType,
      thumbnailUrl,
      manifest,
      run,
      manifestPath: manifest ? manifestPath : null,
      runPath: run ? runPath : null,
      caption,
      captionPath: caption ? captionPath : null,
    };
}

// Scan all images without pagination — used by the search index builder
export function scanAllImages(): ImageEntry[] {
  const { entries, dirFileCache } = scanRawEntries();
  return entries.map((e) => buildImageEntry(e, dirFileCache));
}

export async function handleGallerySearch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const typeFilter = url.searchParams.get("type") ?? undefined;

  if (!q) return Response.json({ images: [], total: 0 });

  const { isIndexed, buildIndex, searchImages } = await import("../lib/gallery-index");
  if (!isIndexed()) {
    buildIndex(scanAllImages());
  }

  const images = searchImages(q, typeFilter);
  return gzipJsonResponse(req, { images, total: images.length });
}

export async function handleGallery(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);

  const { entries, dirFileCache } = scanRawEntries();

  const total = entries.length;
  const paged = entries.slice((page - 1) * limit, page * limit);

  const images: ImageEntry[] = paged.map((entry) => buildImageEntry(entry, dirFileCache));

  return gzipJsonResponse(req, { images, total, page, limit });
}

export async function handleGalleryImage(req: Request, filename: string): Promise<Response> {
  const decoded = decodeURIComponent(filename);
  // Support dir-indexed format "0/file.png" (new) and plain "file.png" (legacy)
  const slashIdx = decoded.indexOf("/");
  const dirIdx = slashIdx !== -1 ? parseInt(decoded.slice(0, slashIdx), 10) : NaN;
  const validDirIdx = !isNaN(dirIdx) && dirIdx >= 0 && dirIdx < OUTPUT_DIRS.length;
  const name = validDirIdx ? decoded.slice(slashIdx + 1) : decoded;
  const dirsToSearch = validDirIdx ? [OUTPUT_DIRS[dirIdx]] : OUTPUT_DIRS;

  for (const dir of dirsToSearch) {
    const filePath = path.normalize(path.join(dir, name));
    // Containment check MUST include the trailing separator: a bare startsWith
    // lets a sibling named "<dir>something" in the parent (e.g. name="../output-
    // secret" normalizes to /a/b/output-secret which startsWith /a/b/output) slip
    // through and serve a file outside the output dir.
    const resolvedDir = path.resolve(dir) + path.sep;
    if (!filePath.startsWith(resolvedDir)) continue;
    if (!fs.existsSync(filePath)) continue;

    const stat = fs.statSync(filePath);
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
        return new Response(Bun.file(filePath).slice(start, end + 1), {
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

    return new Response(Bun.file(filePath), {
      headers: { ETag: etag, "Cache-Control": "no-cache", "Accept-Ranges": "bytes" },
    });
  }
  return new Response("Not found", { status: 404 });
}

export async function handleGalleryDelete(req: Request): Promise<Response> {
  if (req.method !== "DELETE") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: { name?: string; dirIdx?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { name, dirIdx } = body;
  if (!name || dirIdx == null) {
    return Response.json({ error: "Missing 'name' or 'dirIdx'" }, { status: 400 });
  }

  const dir = OUTPUT_DIRS[dirIdx];
  if (!dir) {
    return Response.json({ error: "Invalid dirIdx" }, { status: 400 });
  }

  const deleted: string[] = [];
  const failed: string[] = [];

  // Helper to delete a file if it exists
  const tryDelete = (filePath: string) => {
    const resolved = path.normalize(filePath);
    if (!resolved.startsWith(path.resolve(dir))) return; // prevent path traversal
    if (fs.existsSync(resolved)) {
      try {
        fs.unlinkSync(resolved);
        deleted.push(path.basename(resolved));
      } catch {
        failed.push(path.basename(resolved));
      }
    }
  };

  // Delete the main image/video file
  const mainPath = path.join(dir, name);
  tryDelete(mainPath);

  // Delete companion JSON files
  const base = name.replace(/\.[^.]+$/, "");
  for (const suffix of [".manifest.json", ".run.json", ".caption.json"]) {
    tryDelete(path.join(dir, `${base}${suffix}`));
  }

  // Delete thumbnail if exists
  tryDelete(path.join(dir, ".thumbs", `${base}_thumb.jpg`));

  // Delete video relay thumbnail if exists
  for (const c of [`${base}_relay.png`, `${base}.png`]) {
    const thumbPath = path.join(dir, c);
    if (c !== name) tryDelete(thumbPath);
  }

  return Response.json({ ok: failed.length === 0, deleted, failed });
}
