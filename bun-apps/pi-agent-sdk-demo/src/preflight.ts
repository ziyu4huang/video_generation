/**
 * Runtime preflight checks.
 *
 * Runs before any agent mode and prints dynamic warnings based on how the CLI
 * is actually being executed. Detection is best-effort and dependency-free.
 *
 * Detected conditions:
 *   - run source:  dev (src) | bundle (dist) | compiled exe
 *   - sourcemaps:  *.map next to the running file (reverse minify/obfuscation)
 *   - distribution leak: running from dist/ → remind it's debug-only
 *   - credentials: no API key resolvable for the default model
 *
 * Use:
 *   import { preflight } from "./preflight.ts";
 *   const diag = await preflight();
 *   diag.print();               // prints warnings to stderr
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Severity = "info" | "warn" | "error";

export interface Warning {
  severity: Severity;
  message: string;
}

export interface PreflightResult {
  runSource: "dev" | "bundle" | "exe";
  here: string;                 // directory of the running entry
  entry: string;                // resolved entry path / "<compiled>"
  warnings: Warning[];
  print: () => void;
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function isCompiled(): boolean {
  // bun --compile: process.argv[0] is the binary path and there's no source module
  // to resolve. Bun leaves process.execPath / process.argv[0] pointing at the exe.
  const arg0 = process.argv[0] ?? "";
  try {
    // In a compiled binary, import.meta.url is still resolvable but lives inside
    // the embedded snapshot — heuristic: the entry basename is not a .ts/.js on disk.
    if (process.execPath && existsSync(process.execPath) && /pi-cli$/.test(arg0)) return true;
  } catch { /* ignore */ }
  return false;
}

export async function preflight(): Promise<PreflightResult> {
  const warnings: Warning[] = [];

  // --- resolve where we are running from ---
  let entry = "<compiled>";
  let here = process.cwd();
  let runSource: PreflightResult["runSource"] = "dev";

  if (isCompiled()) {
    runSource = "exe";
    here = dirname(process.execPath);
    entry = process.execPath;
  } else {
    try {
      entry = fileURLToPath(import.meta.url);
      here = dirname(entry);
      if (/[\\/](?:dist|build|out)[\\/]/.test(entry) || /\.[cm]?js$/.test(entry)) {
        runSource = "bundle";
      }
    } catch {
      runSource = "bundle";
    }
  }

  // --- check 1: sourcemaps next to the running file (bundle/exe only) ---
  if (runSource !== "dev") {
    try {
      const siblings = [
        entry.replace(/\.[cm]?js$/, ".js.map"),
        join(here, "cli.js.map"),
        join(here, "cli.js.obf.map"),
      ].filter((p) => /\.map$/i.test(p));
      const maps = [...new Set(siblings)].filter((p) => existsSync(p));
      if (maps.length > 0) {
        warnings.push({
          severity: "warn",
          message:
            `Sourcemap${maps.length > 1 ? "s" : ""} present (${maps.map((m) => m.replace(here + "/", "")).join(", ")}).\n` +
            `  These reverse minification/obfuscation and reconstruct your source.\n` +
            `  Debug only — do NOT distribute to users.`,
        });
      }
    } catch { /* ignore */ }
  }

  // --- check 2: running from a build/dist directory → leak reminder ---
  if (runSource === "bundle") {
    warnings.push({
      severity: "info",
      message:
        `Running a bundled artifact (${entry.replace(here + "/", "")}).\n` +
        `  dist/ is for local debugging only, not for distribution.`,
    });
  }

  // --- check 3: credentials for the default model ---
  try {
    const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
    const auth = AuthStorage.create();
    const reg = ModelRegistry.create(auth);
    const available = await reg.getAvailable();
    if (available.length === 0) {
      warnings.push({
        severity: "error",
        message:
          `No models with valid API keys found.\n` +
          `  Set an env var (e.g. ANTHROPIC_API_KEY, ZAI_API_KEY) or configure ~/.pi/agent/auth.json.`,
      });
    }
  } catch (e) {
    warnings.push({
      severity: "warn",
      message: `Could not probe model availability: ${(e as Error).message}`,
    });
  }

  return {
    runSource,
    here,
    entry,
    warnings,
    print() {
      const tag =
        runSource === "exe" ? "compiled exe" :
        runSource === "bundle" ? "bundle" : "dev";
      console.error(`${DIM}[preflight] run: ${tag}${RESET}`);
      for (const w of warnings) {
        const color = w.severity === "error" ? RED : w.severity === "warn" ? YELLOW : CYAN;
        const label = w.severity.toUpperCase();
        console.error(`${color}[${label}]${RESET} ${w.message}`);
      }
    },
  };
}
