import fs from "fs";
import path from "path";
import { OUTPUT_DIRS } from "../lib/paths";

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
}

/**
 * Try progressively shorter base names to find companion manifest/run JSON.
 * Handles: base, base_seg01, base_relay, base_seg01_relay patterns.
 */
function findCompanionJson(dir: string, base: string, suffix: ".manifest.json" | ".run.json"): string | null {
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

export async function handleGallery(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);

  // Collect media entries from ALL output directories
  type RawEntry = { name: string; dir: string; fullPath: string; mtime: number; size: number };
  const allEntries: RawEntry[] = [];

  for (const dir of OUTPUT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const fileIndex = buildFileIndex(dir);

    const entries = fs.readdirSync(dir)
      .filter((f) => {
        const ext = path.extname(f).toLowerCase();
        if (!MEDIA_EXTENSIONS.has(ext)) return false;
        // Skip relay PNGs — they're companion thumbnails for video segments
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

    allEntries.push(...entries);
  }

  // Sort all entries by mtime descending (newest first)
  allEntries.sort((a, b) => b.mtime - a.mtime);

  const total = allEntries.length;
  const paged = allEntries.slice((page - 1) * limit, page * limit);

  const images: ImageEntry[] = paged.map((entry) => {
    const base = entry.name.replace(/\.[^.]+$/, "");
    const mediaType = getMediaType(entry.name);

    // Manifest / run lookup with progressive base-name stripping
    const manifestPath = findCompanionJson(entry.dir, base, ".manifest.json");
    let manifest: Record<string, any> | null = null;
    if (manifestPath) {
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")); } catch { /* ignore */ }
    }

    const runPath = findCompanionJson(entry.dir, base, ".run.json");
    let run: Record<string, any> | null = null;
    if (runPath) {
      try { run = JSON.parse(fs.readFileSync(runPath, "utf-8")); } catch { /* ignore */ }
    }

    // Thumbnail: for videos, look for companion relay PNG or regular PNG
    let thumbnailUrl: string | null = null;
    if (mediaType === "video") {
      const fileIndex = buildFileIndex(entry.dir);
      const candidates = [
        `${base}_relay.png`,   // output_20260611_193630_seg01_relay.png
        `${base}.png`,         // output_20260611_192957.png
      ];
      for (const c of candidates) {
        if (fileIndex.has(c)) {
          thumbnailUrl = `/output/${c}`;
          break;
        }
      }
    }

    return {
      name: entry.name,
      url: `/output/${entry.name}`,
      size: entry.size,
      createdAt: new Date(entry.mtime).toISOString(),
      mediaType,
      thumbnailUrl,
      manifest,
      run,
      manifestPath: manifest ? manifestPath : null,
      runPath: run ? runPath : null,
    };
  });

  return Response.json({ images, total, page, limit });
}

export async function handleGalleryImage(req: Request, filename: string): Promise<Response> {
  const decoded = decodeURIComponent(filename);
  // Search all output directories for the file
  for (const dir of OUTPUT_DIRS) {
    const filePath = path.normalize(path.join(dir, decoded));
    // Path traversal protection
    if (!filePath.startsWith(path.resolve(dir))) continue;
    if (fs.existsSync(filePath)) {
      const file = Bun.file(filePath);
      return new Response(file);
    }
  }
  return new Response("Not found", { status: 404 });
}
