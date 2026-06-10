import fs from "fs";
import path from "path";
import { OUTPUT_DIR } from "../lib/paths";

interface ImageEntry {
  name: string;
  url: string;
  size: number;
  createdAt: string;
  width?: number;
  height?: number;
  manifest?: Record<string, any> | null;
  run?: Record<string, any> | null;
}

export async function handleGallery(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);

  if (!fs.existsSync(OUTPUT_DIR)) {
    return Response.json({ images: [], total: 0, page, limit });
  }

  // List .png files sorted by mtime descending
  const entries = fs.readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith(".png"))
    .map((f) => {
      const fullPath = path.join(OUTPUT_DIR, f);
      const stat = fs.statSync(fullPath);
      return { name: f, fullPath, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const total = entries.length;
  const paged = entries.slice((page - 1) * limit, page * limit);

  const images: ImageEntry[] = paged.map((entry) => {
    // Look for companion manifest and run JSON
    const base = entry.name.replace(/\.png$/, "");

    const manifestPath = path.join(OUTPUT_DIR, `${base}.manifest.json`);
    let manifest: Record<string, any> | null = null;
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      } catch {
        // Ignore malformed manifests
      }
    }

    const runPath = path.join(OUTPUT_DIR, `${base}.run.json`);
    let run: Record<string, any> | null = null;
    if (fs.existsSync(runPath)) {
      try {
        run = JSON.parse(fs.readFileSync(runPath, "utf-8"));
      } catch {
        // Ignore malformed run files
      }
    }

    return {
      name: entry.name,
      url: `/output/${entry.name}`,
      size: entry.size,
      createdAt: new Date(entry.mtime).toISOString(),
      manifest,
      run,
    };
  });

  return Response.json({ images, total, page, limit });
}

export async function handleGalleryImage(req: Request, filename: string): Promise<Response> {
  const filePath = path.join(OUTPUT_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) {
    return new Response("Not found", { status: 404 });
  }
  const file = Bun.file(filePath);
  return new Response(file);
}
