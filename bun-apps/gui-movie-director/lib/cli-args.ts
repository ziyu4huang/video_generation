/**
 * Server CLI argument parsing.
 *
 * The app resolves several settings through a 4-level priority chain:
 *   cli arg  >  env var  >  config.json  >  built-in default
 *
 * `--gen-output-dir` and `--port` are parsed here (pure, memoized) and consumed
 * directly by loadConfig (output dir) and server.ts (port). When bun spawns
 * run.py it passes the resolved output dir EXPLICITLY via `--gen-output-dir`
 * (see lib/subprocess.ts) rather than relying on env inheritance — the spawn
 * command is self-describing and the two sides cannot drift.
 *
 * Supported flags (both accept `--flag value` and `--flag=value`):
 *   --gen-output-dir <path>   primary output dir (run.py's dirs[0])
 *   --port <n>                server listen port
 */

export interface ServerArgs {
  genOutputDir?: string;
  port?: number;
}

/** Pure parser — no side effects, safe to unit-test. */
export function parseServerArgs(argv: string[] = process.argv): ServerArgs {
  const out: ServerArgs = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];

    if (a === "--gen-output-dir") {
      if (v !== undefined) { out.genOutputDir = v; i++; }
    } else if (a?.startsWith("--gen-output-dir=")) {
      out.genOutputDir = a.slice("--gen-output-dir=".length);
    } else if (a === "--port") {
      if (v !== undefined) { out.port = Number(v); i++; }
    } else if (a?.startsWith("--port=")) {
      out.port = Number(a.slice("--port=".length));
    }
  }

  // Drop empties / out-of-range port so callers see a clean optional.
  if (out.genOutputDir !== undefined && out.genOutputDir.trim() === "") {
    delete out.genOutputDir;
  }
  if (out.port !== undefined &&
      (!Number.isFinite(out.port) || out.port <= 0 || out.port > 65535)) {
    delete out.port;
  }

  return out;
}

let _cached: ServerArgs | null = null;

/** Memoized parse of process.argv — call from anywhere, parses once. */
export function getServerArgs(): ServerArgs {
  if (_cached === null) _cached = parseServerArgs();
  return _cached;
}
