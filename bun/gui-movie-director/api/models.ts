import fs from "fs";
import path from "path";
import { MODELS_DIR } from "../lib/paths";

interface LoraInfo {
  name: string;
  path: string;
  description?: string;
  arch?: string;
  format?: string;
  pipeline?: string[];
  rank?: number;
  size_bytes?: number;
  folder_size_bytes?: number;
  recommended_scale?: number;
  trigger_words?: string[];
  compatible_with?: string[];
  source?: string;
  source_url?: string;
  created_at?: string;
  weight_file?: string;
  test_prompt?: string;
  notes?: string;
  converted_from?: { format?: string; size_bytes?: number };
}

interface VaeInfo {
  name: string;
  path: string;
}

function getFolderSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) total += fs.statSync(path.join(dir, entry.name)).size;
    }
  } catch {}
  return total;
}

export async function handleListLoras(req: Request): Promise<Response> {
  const loraDir = path.join(MODELS_DIR, "lora");
  if (!fs.existsSync(loraDir)) {
    return Response.json([]);
  }

  const lorals: LoraInfo[] = [];
  const entries = fs.readdirSync(loraDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(loraDir, entry.name, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        const loraPath = path.join(loraDir, entry.name);
        lorals.push({
          name: manifest.name || entry.name,
          path: loraPath,
          description: manifest.description,
          arch: manifest.arch,
          format: manifest.format,
          pipeline: manifest.pipeline,
          rank: manifest.rank,
          size_bytes: manifest.size_bytes,
          folder_size_bytes: getFolderSize(loraPath),
          recommended_scale: manifest.recommended_scale,
          trigger_words: manifest.trigger_words,
          compatible_with: manifest.compatible_with,
          source: manifest.source,
          source_url: manifest.source_url,
          created_at: manifest.created_at,
          weight_file: manifest.weight_file ?? manifest.file,
          test_prompt: manifest.test_prompt,
          notes: manifest.notes,
          converted_from: manifest.converted_from,
        });
      } catch {
        lorals.push({ name: entry.name, path: path.join(loraDir, entry.name) });
      }
    }
  }

  return Response.json(lorals);
}

export async function handleListVaes(req: Request): Promise<Response> {
  const vaeDir = path.join(MODELS_DIR, "vae");
  if (!fs.existsSync(vaeDir)) {
    return Response.json([]);
  }

  const vaes: VaeInfo[] = [];
  const entries = fs.readdirSync(vaeDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    vaes.push({ name: entry.name, path: path.join(vaeDir, entry.name) });
  }

  return Response.json(vaes);
}
