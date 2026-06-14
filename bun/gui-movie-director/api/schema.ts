import { RUN_PY } from "../lib/paths";
import { resolvePythonBin } from "../lib/pythonBin";

let _schemaCache: Record<string, any> | null = null;
let _defaultsCache: Record<string, any> | null = null;

interface FetchOptions {
  subcommand: string;
  extraFlags?: string[];
  cache: () => Record<string, any> | null;
  setCache: (v: Record<string, any> | null) => void;
  logOk: string;
  logWarn: string;
}

function _fetchFromRunPy(opts: FetchOptions): Promise<void> {
  const pythonBin = resolvePythonBin();
  try {
    const args = [pythonBin, RUN_PY, opts.subcommand, ...(opts.extraFlags ?? [])];
    const proc = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    const out = new TextDecoder().decode(proc.stdout).trim();
    if (out) {
      opts.setCache(JSON.parse(out));
      console.log(opts.logOk);
    } else {
      const err = new TextDecoder().decode(proc.stderr).trim();
      console.warn(opts.logWarn, err);
    }
  } catch (e) {
    console.warn(opts.logWarn, e);
  }
}

// -- CLI schema (run.py schema --compact) --

export async function fetchCliSchema(): Promise<void> {
  return _fetchFromRunPy({
    subcommand: "schema",
    extraFlags: ["--compact"],
    cache: () => _schemaCache,
    setCache: (v) => { _schemaCache = v; },
    logOk: "📋 CLI schema loaded from run.py",
    logWarn: "⚠️  CLI schema unavailable:",
  });
}

export function getCliSchema(): Record<string, any> | null {
  return _schemaCache;
}

export async function handleGetCliSchema(_req: Request): Promise<Response> {
  if (_schemaCache) return Response.json({ ok: true, schema: _schemaCache });
  return Response.json({ ok: false, error: "CLI schema not loaded" }, { status: 503 });
}

// -- Schema defaults (run.py schema-defaults) --

export async function fetchSchemaDefaults(): Promise<void> {
  return _fetchFromRunPy({
    subcommand: "schema-defaults",
    cache: () => _defaultsCache,
    setCache: (v) => { _defaultsCache = v; },
    logOk: "📋 Schema defaults loaded from Python",
    logWarn: "⚠️  schema-defaults unavailable:",
  });
}

export async function handleGetSchemaDefaults(_req: Request): Promise<Response> {
  if (_defaultsCache) return Response.json({ ok: true, defaults: _defaultsCache });
  return Response.json({ ok: false, error: "Schema defaults not loaded" }, { status: 503 });
}
