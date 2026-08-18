import fs from "fs";
import path from "path";
import { OUTPUT_DIRS, RUN_PY } from "../lib/paths";
import { loadConfig, vlmModelIsAuto } from "../lib/config";
import { readJsonFile } from "../lib/fsUtils";
import { normalizeCaptionFile } from "../lib/captionFormat";
import { parsePostJson } from "../lib/requestUtils";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v"]);

const T2I2V_SUBDIR_RE = /^t2i2v_\d/;
// Exclude the downscaled LTX input image (intermediate file, not for display)
const T2I2V_LTX_RESCALE_RE = /^output_.*_ltx_\d+x\d+\.\w+$/;

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
  variants?: ImageEntry[];
}

/**
 * Try progressively shorter base names to find companion manifest/run JSON.
 * Handles: base, base_seg01, base_relay, base_seg01_relay patterns.
 */
export function findCompanionJson(dir: string, base: string, suffix: ".manifest.json" | ".run.json" | ".caption.json"): string | null {
  const candidates = [
    base,                              // full base: output_20260611_193630_seg01
    base.replace(/_relay$/, ""),       // strip _relay
    base.replace(/_seg\d+$/, ""),      // strip _segXX
    base.replace(/_s\d+$/, ""),        // strip _s42 / _s43 (seed suffix)
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
type RawEntry = {
  name: string;       // display + URL path relative to rootDir: "front.png" or "profile_TS/front.png"
  base: string;       // filename stem for companion lookup: "front" (never includes the subpath)
  dir: string;        // actual dir holding the file (subfolder for profile_*) — companion + dirFileCache lookups
  rootDir: string;    // OUTPUT_DIR root — for dirIdx
  fullPath: string;
  mtime: number;
  size: number;
  t2i2vManifestPath?: string | null;  // set for files in t2i2v_* subdirs; used as group key
};

const MEDIA_GLOB = new Bun.Glob("*.{png,jpg,jpeg,mp4,mov,webm,m4v}");

function scanRawEntries(): { entries: RawEntry[]; dirFileCache: Map<string, Set<string>> } {
  const entries: RawEntry[] = [];
  const dirFileCache = new Map<string, Set<string>>();

  // Media files written DIRECTLY into a profile_* subfolder (output/profile_TS/front.png)
  // are invisible to the flat glob below. Surface them one level deep. The serving side
  // (handleGalleryImage) already serves subpath names like "profile_TS/front.png".
  const PROFILE_SUBDIR_RE = /^profile_/;
  const PROFILE_EXCLUDE = new Set(["reference.png", "strip.png"]);  // input ref + composite (redundant)

  const addMedia = (fileDir: string, rootDir: string, sub: string, opts?: {
    excludeRe?: RegExp;
    t2i2vManifestPath?: string | null;
  }) => {
    if (!fs.existsSync(fileDir)) return;
    dirFileCache.set(fileDir, new Set(fs.readdirSync(fileDir)));
    const media = [...MEDIA_GLOB.scanSync({ cwd: fileDir, onlyFiles: true })]
      .filter((f) => !f.endsWith("_relay.png"))
      .filter((f) => !(sub && PROFILE_EXCLUDE.has(f)))
      .filter((f) => !opts?.excludeRe?.test(f));
    for (const f of media) {
      const fullPath = path.join(fileDir, f);
      try {
        const stat = fs.statSync(fullPath);
        entries.push({
          name: sub ? `${sub}/${f}` : f,
          base: f.replace(/\.[^.]+$/, ""),
          dir: fileDir,
          rootDir,
          fullPath,
          mtime: stat.mtimeMs,
          size: stat.size,
          t2i2vManifestPath: opts?.t2i2vManifestPath ?? null,
        });
      } catch { /* skip unreadable */ }
    }
  };

  for (const dir of OUTPUT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    // Flat media directly in the output root
    addMedia(dir, dir, "");
    // One level into profile_* subfolders (multi-view: front/side/back) AND the
    // uploads/ subdir — tool outputs on an uploaded input (e.g. image purify,
    // faceswap) are saved next to the input in uploads/, so without this they'd
    // never surface in the gallery.
    // Dirent[], not string[] — `withFileTypes: true` is what the loop below
    // needs (.isDirectory()/.name). The annotation said string[] and the code
    // used Dirent members, so 8 of this file's type errors were that one word.
    let allFiles: fs.Dirent[] = [];
    try { allFiles = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of allFiles) {
      if (!ent.isDirectory()) continue;
      const isProfile = PROFILE_SUBDIR_RE.test(ent.name) || ent.name === "uploads";
      const isT2i2v = T2I2V_SUBDIR_RE.test(ent.name);
      if (!isProfile && !isT2i2v) continue;
      const subPath = path.join(dir, ent.name);
      if (isT2i2v) {
        const t2i2vManPath = path.join(subPath, "t2i2v_manifest.json");
        addMedia(subPath, dir, ent.name, {
          excludeRe: T2I2V_LTX_RESCALE_RE,
          t2i2vManifestPath: fs.existsSync(t2i2vManPath) ? t2i2vManPath : null,
        });
      } else {
        addMedia(subPath, dir, ent.name);
      }
    }
  }

  entries.sort((a, b) => b.mtime - a.mtime);
  return { entries, dirFileCache };
}

function buildImageEntry(entry: RawEntry, dirFileCache: Map<string, Set<string>>): ImageEntry {
    const base = entry.base;
    const mediaType = getMediaType(entry.name);

    // T2I2V entries: use t2i2v_manifest.json as the primary manifest (shows full pipeline info)
    const manifestPath = entry.t2i2vManifestPath ?? findCompanionJson(entry.dir, base, ".manifest.json");
    const manifest = manifestPath ? readJsonFile<Record<string, any>>(manifestPath) : null;

    const runPath = findCompanionJson(entry.dir, base, ".run.json");
    const run = runPath ? readJsonFile<Record<string, any>>(runPath) : null;

    const dirIdx = OUTPUT_DIRS.indexOf(entry.rootDir);
    let thumbnailUrl: string | null = null;
    if (mediaType === "video") {
      const fileIndex = dirFileCache.get(entry.dir) ?? new Set<string>();
      if (entry.t2i2vManifestPath) {
        // T2I2V video: use the T2I image (the PNG without _ltx_ rescale suffix) as thumbnail
        const pngName = [...fileIndex].find(f => f.endsWith(".png") && !T2I2V_LTX_RESCALE_RE.test(f));
        if (pngName) {
          const subPrefix = entry.name.includes("/") ? entry.name.split("/")[0] + "/" : "";
          thumbnailUrl = `/output/${dirIdx}/${subPrefix}${pngName}`;
        }
      } else {
        for (const c of [`${base}_relay.png`, `${base}.png`]) {
          if (fileIndex.has(c)) { thumbnailUrl = `/output/${dirIdx}/${c}`; break; }
        }
      }
    }

    const captionPath = findCompanionJson(entry.dir, base, ".caption.json");
    const caption = captionPath ? normalizeCaptionFile(readJsonFile(captionPath)) : null;

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

// Group raw entries by shared manifest path. Returns primaries (newest first)
// with siblings attached as `variants`. Entries with no manifest are standalone.
function groupEntries(entries: RawEntry[], dirFileCache: Map<string, Set<string>>): ImageEntry[] {
  // entries are already sorted newest-first
  const manifestGroups = new Map<string, RawEntry[]>();
  const entryManifestPaths: (string | null)[] = entries.map((e) =>
    // T2I2V entries share t2i2v_manifest.json as group key so image + video appear together
    e.t2i2vManifestPath ?? findCompanionJson(e.dir, e.base, ".manifest.json")
  );

  for (let i = 0; i < entries.length; i++) {
    const mPath = entryManifestPaths[i];
    if (!mPath) continue;
    if (!manifestGroups.has(mPath)) manifestGroups.set(mPath, []);
    manifestGroups.get(mPath)!.push(entries[i]);
  }

  const seenManifest = new Set<string>();
  const result: ImageEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const mPath = entryManifestPaths[i];

    if (!mPath) {
      result.push(buildImageEntry(entry, dirFileCache));
      continue;
    }
    if (seenManifest.has(mPath)) continue;
    seenManifest.add(mPath);

    const group = manifestGroups.get(mPath)!;
    const primary = buildImageEntry(group[0], dirFileCache);
    if (group.length > 1) {
      primary.variants = group.slice(1).map((e) => buildImageEntry(e, dirFileCache));
    }
    result.push(primary);
  }

  return result;
}

// Scan all images without pagination — used by the search index builder (flat, no grouping)
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
  const grouped = groupEntries(entries, dirFileCache);

  const total = grouped.length;
  const images = grouped.slice((page - 1) * limit, page * limit);

  return gzipJsonResponse(req, { images, total, page, limit });
}

// MIME allowlist for served gallery files. Unknown extensions get
// application/octet-stream (a forced download, never sniffed into HTML/SVG).
// Combined with X-Content-Type-Options: nosniff on every serve response below,
// this closes the stored-XSS vector where an uploaded evil.png (whose bytes
// are actually HTML/SVG) would be content-sniffed and executed in the
// localhost:3099 origin — reachable from the network while the server bound
// 0.0.0.0 and the API had no auth.
// Keep in sync with VIDEO_EXTENSIONS + MEDIA_GLOB above — every extension the
// glob scans / VIDEO_EXTENSIONS classifies must map here, else contentTypeFor
// falls through to application/octet-stream and the browser forces a download
// instead of inline playback (.webm/.m4v were missing → broken video preview).
const GALLERY_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
};
function contentTypeFor(filename: string): string {
  return GALLERY_MIME[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
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
            "Content-Type": contentTypeFor(name),
            "X-Content-Type-Options": "nosniff",
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
      headers: {
        "Content-Type": contentTypeFor(name),
        "X-Content-Type-Options": "nosniff",
        ETag: etag,
        "Cache-Control": "no-cache",
        "Accept-Ranges": "bytes",
      },
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

  // Restrict to actual gallery media files — blocks deleting arbitrary files. Allow flat
  // names ("front.png") and one-level subpaths surfaced by scanRawEntries — the profile_*
  // multi-view folders AND uploads/ (where tool outputs on an uploaded input land, e.g.
  // image purify). Reject "..", backslashes, and unknown subfolders.
  const subMatch = name.match(/^([^/]+)\/([^/]+)$/);  // sub/file
  const fileName = subMatch ? subMatch[2] : name;
  const subName = subMatch ? subMatch[1] : "";
  if (name.includes("\\") || name.includes("..") || !MEDIA_GLOB.match(fileName) ||
      (subName && subName !== "uploads" && !/^profile_\w+$/.test(subName) && !T2I2V_SUBDIR_RE.test(subName))) {
    return Response.json({ error: "Invalid 'name': not a gallery media file" }, { status: 400 });
  }

  const dir = OUTPUT_DIRS[dirIdx];
  if (!dir) {
    return Response.json({ error: "Invalid dirIdx" }, { status: 400 });
  }
  // Actual file dir: the profile_* subfolder if a subpath was given, else the output root.
  // (actualDir is always under dir, so the tryDelete containment guard below still holds.)
  const actualDir = subName ? path.join(dir, subName) : dir;
  const base = fileName.replace(/\.[^.]+$/, "");

  const deleted: string[] = [];
  const failed: string[] = [];

  // Helper to delete a file if it exists
  const tryDelete = (filePath: string) => {
    const resolved = path.normalize(filePath);
    if (!resolved.startsWith(path.resolve(dir) + path.sep)) return; // prevent path traversal
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
  const mainPath = path.join(actualDir, fileName);
  tryDelete(mainPath);

  // Delete companion JSON files. Reuse findCompanionJson (the same multi-base
  // resolver the gallery READS with) so segmented/relay media — e.g.
  // base_seg01_relay.png whose companion is base.manifest.json — get their
  // companions deleted too. Previously only the exact base was stripped, which
  // orphaned companion JSON whenever the media name carried _segNN/_relay
  // (findCompanionJson would still resolve and DISPLAY them on next scan).
  for (const suffix of [".manifest.json", ".run.json", ".caption.json"] as const) {
    const companion = findCompanionJson(actualDir, base, suffix);
    if (companion) tryDelete(companion);
  }

  // Delete thumbnail if exists
  tryDelete(path.join(actualDir, ".thumbs", `${base}_thumb.jpg`));

  // Delete video relay thumbnail if exists
  for (const c of [`${base}_relay.png`, `${base}.png`]) {
    const thumbPath = path.join(actualDir, c);
    if (c !== fileName) tryDelete(thumbPath);
  }

  return Response.json({ ok: failed.length === 0, deleted, failed });
}

/**
 * Batch-caption gallery images that lack a .caption.json — the orphan gap.
 * Unlike /api/knowledge/caption-missing (which scans ONLY run.json-backed T2I
 * records for DeepSeek analysis), this covers EVERY gallery image including
 * test/self-test/comparison outputs that have no run.json (cnet_*, i2i_selftest_*,
 * lora-review-*, profile subfolders). Style is "score" (view-agnostic, no prompt
 * needed) so orphans get a quality bar + become searchable. Reuses scanRawEntries
 * (orphan + profile-subfolder aware) + findCompanionJson (same companion resolver
 * the gallery READS with).
 */
export async function handleGalleryCaptionMissing(req: Request): Promise<Response> {
  const body = await parsePostJson<{ limit?: number }>(req);
  if (body instanceof Response) return body;

  const cfg = loadConfig();
  const { entries } = scanRawEntries();
  const missing = entries.filter(
    (e) => !findCompanionJson(e.dir, e.base, ".caption.json"),
  );
  // Default batch when no limit: 50 (each Gemma score call is ~10-30s, so 50 ≈
  // 10-25 min — a no-limit call against a large backlog would hang for hours).
  // `missing` always reports the FULL backlog so the caller knows to page.
  const batch = missing.slice(0, body.limit ?? 50);

  let generated = 0;
  let failed = 0;
  const logs: string[] = [];

  for (let i = 0; i < batch.length; i++) {
    const e = batch[i];
    logs.push(`[${i + 1}/${batch.length}] ${e.name}`);
    const args = [
      cfg.pythonPath, RUN_PY, "caption", e.fullPath,
      "--style", "score", "--api-url", cfg.vlmApiUrl, "--lang", "en",
    ];
    if (!vlmModelIsAuto(cfg.vlmModel)) args.push("--model", cfg.vlmModel);
    try {
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
      const stdoutP = new Response(proc.stdout).text();
      const stderrP = new Response(proc.stderr).text();
      const code = await proc.exited;
      await stdoutP;
      const stderr = await stderrP;
      if (code === 0) generated++;
      else { failed++; console.error(`[gallery] caption failed for ${e.name}:`, stderr.slice(0, 300)); }
    } catch (err: any) {
      failed++;
      console.error(`[gallery] caption error for ${e.name}:`, err.message);
    }
  }

  return Response.json({
    ok: true,
    total: entries.length,
    missing: missing.length,
    generated,
    failed,
    logs: logs.slice(-30),
  });
}
