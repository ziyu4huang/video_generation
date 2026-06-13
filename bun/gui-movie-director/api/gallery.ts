import fs from "fs";
import path from "path";
import { OUTPUT_DIRS } from "../lib/paths";
import { readJsonFile } from "../lib/fsUtils";

const MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".mp4", ".mov", ".webm", ".m4v"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v"]);

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

/** Build a name→url map for companion lookups (thumbnails, manifest, etc.) */
function buildFileIndex(dir: string): Set<string> {
  try { return new Set(fs.readdirSync(dir)); } catch { return new Set(); }
}

// Shared: scan raw filesystem entries across all output dirs
type RawEntry = { name: string; dir: string; fullPath: string; mtime: number; size: number };

function scanRawEntries(): { entries: RawEntry[]; dirFileCache: Map<string, Set<string>> } {
  const entries: RawEntry[] = [];
  const dirFileCache = new Map<string, Set<string>>();

  for (const dir of OUTPUT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const allFiles = fs.readdirSync(dir);
    dirFileCache.set(dir, new Set(allFiles));

    const dirEntries = allFiles
      .filter((f) => {
        const ext = path.extname(f).toLowerCase();
        if (!MEDIA_EXTENSIONS.has(ext)) return false;
        if (ext === ".png" && f.endsWith("_relay.png")) return false;
        return true;
      })
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
  return Response.json({ images, total: images.length });
}

export async function handleGallery(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);

  const { entries, dirFileCache } = scanRawEntries();

  const total = entries.length;
  const paged = entries.slice((page - 1) * limit, page * limit);

  const images: ImageEntry[] = paged.map((entry) => buildImageEntry(entry, dirFileCache));

  return Response.json({ images, total, page, limit });
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
    if (!filePath.startsWith(path.resolve(dir))) continue;
    if (fs.existsSync(filePath)) return new Response(Bun.file(filePath));
  }
  return new Response("Not found", { status: 404 });
}
