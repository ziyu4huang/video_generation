import { RUN_PY } from "../lib/paths";
import { resolvePythonBin } from "../lib/pythonBin";

let _cache: Record<string, any> | null = null;

export async function fetchSchemaDefaults(): Promise<void> {
  const pythonBin = resolvePythonBin();
  try {
    const proc = Bun.spawnSync(
      [pythonBin, RUN_PY, "schema-defaults"],
      { stdout: "pipe", stderr: "pipe", timeout: 15_000 },
    );
    const out = new TextDecoder().decode(proc.stdout).trim();
    if (out) {
      _cache = JSON.parse(out);
      console.log("📋 Schema defaults loaded from Python");
    } else {
      const err = new TextDecoder().decode(proc.stderr).trim();
      console.warn("⚠️  schema-defaults produced no output:", err);
    }
  } catch (e) {
    // Non-fatal: frontend falls back to static defaults in schemas/index.ts
    console.warn("⚠️  Schema defaults unavailable:", e);
  }
}

export async function handleGetSchemaDefaults(_req: Request): Promise<Response> {
  if (_cache) return Response.json({ ok: true, defaults: _cache });
  return Response.json({ ok: false, error: "Schema defaults not loaded" }, { status: 503 });
}
