import fs from "fs";
import path from "path";
import { MODELS_DIR } from "../lib/paths";

interface LoraInfo {
  name: string;
  path: string;
  description?: string;
  arch?: string;
  pipeline?: string[];
  size_bytes?: number;
}

interface VaeInfo {
  name: string;
  path: string;
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
        lorals.push({
          name: manifest.name || entry.name,
          path: path.join(loraDir, entry.name),
          description: manifest.description,
          arch: manifest.arch,
          pipeline: manifest.pipeline,
          size_bytes: manifest.size_bytes,
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
