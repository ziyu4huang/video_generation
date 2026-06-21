import { RUN_PY } from "../lib/paths";
import { resolvePythonBin } from "../lib/pythonBin";

// Schema caches MUST live on globalThis, NOT module scope. Bun's `--hot` reload
// (any backend file change) re-evaluates this module, resetting module-level `let`
// bindings to null. fetchCliSchema / fetchSchemaDefaults run only at cold start
// (server.ts), so a module-level cache stays null after the first reload →
// /api/cli-schema and /api/schema-defaults return 503. Persisting on globalThis
// (same pattern as api/bundle.ts _guiBundle and server.ts _devServer) keeps the
// cached schema alive across route swaps. See memory bun-hot-reload-resets-bundle-state.
declare global {
  var _guiSchemaCache: {
    schema: Record<string, any> | null;
    defaults: Record<string, any> | null;
  } | undefined;
}

function schemaStore() {
  if (!globalThis._guiSchemaCache) {
    globalThis._guiSchemaCache = { schema: null, defaults: null };
  }
  return globalThis._guiSchemaCache;
}

interface FetchOptions {
  subcommand: string;
  extraFlags?: string[];
  cache: () => Record<string, any> | null;
  setCache: (v: Record<string, any> | null) => void;
  logOk: string;
  logWarn: string;
}

function _fetchFromRunPy(opts: FetchOptions): void {
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
    cache: () => schemaStore().schema,
    setCache: (v) => { schemaStore().schema = v; },
    logOk: "📋 CLI schema loaded from run.py",
    logWarn: "⚠️  CLI schema unavailable:",
  });
}

export function getCliSchema(): Record<string, any> | null {
  return schemaStore().schema;
}

export async function handleGetCliSchema(_req: Request): Promise<Response> {
  const schema = schemaStore().schema;
  if (schema) return Response.json({ ok: true, schema });
  return Response.json({ ok: false, error: "CLI schema not loaded" }, { status: 503 });
}

// -- Schema defaults (run.py schema-defaults) --

export async function fetchSchemaDefaults(): Promise<void> {
  return _fetchFromRunPy({
    subcommand: "schema-defaults",
    cache: () => schemaStore().defaults,
    setCache: (v) => { schemaStore().defaults = v; },
    logOk: "📋 Schema defaults loaded from Python",
    logWarn: "⚠️  schema-defaults unavailable:",
  });
}

export async function handleGetSchemaDefaults(_req: Request): Promise<Response> {
  const defaults = schemaStore().defaults;
  if (defaults) return Response.json({ ok: true, defaults });
  return Response.json({ ok: false, error: "Schema defaults not loaded" }, { status: 503 });
}
