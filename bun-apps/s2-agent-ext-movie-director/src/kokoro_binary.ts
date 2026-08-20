/**
 * kokoro_binary.ts — resolve + auto-build the `kokoro-tts` Swift CLI.
 *
 * The binary lives at <repoRoot>/swift/musicgen-director/.build/release/kokoro-tts
 * — same Swift PACKAGE as `musicgen` (see swift/musicgen-director/Package.swift's
 * KokoroTTSCLI target), but a distinct binary/product, hence a distinct resolver
 * rather than generalizing the already-shipped musicgen_binary.ts.
 *
 * Mirrors musicgen_binary.ts's shape (env-var names swapped
 * KOKORO_BIN/KOKORO_REPO_ROOT for MUSICGEN_BIN/MUSICGEN_REPO_ROOT), with two
 * deliberate deviations: buildBinary scopes to `--product kokoro-tts` (avoids
 * rebuilding the unrelated musicgen binary), and the source-mtime staleness
 * check narrows to Sources/KokoroTTSCLI (avoids false-staleness from
 * unrelated MusicGenDirector changes).
 */
import { dirname, join, resolve as pResolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";

export interface ProgressFn {
  (update: { kind: "progress"; text: string }): void;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

let _cachedBin: string | null = null;

function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "swift", "musicgen-director", "Package.swift"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveRepoRoot(): string {
  if (process.env.KOKORO_REPO_ROOT) return pResolve(process.env.KOKORO_REPO_ROOT);
  const here: string =
    (import.meta as any).dir ?? (typeof __dirname === "string" ? __dirname : process.cwd());
  const found = findRepoRoot(here);
  if (!found) {
    throw new Error(
      "s2-agent-ext-movie-director: cannot locate repo root (swift/musicgen-director not found).\n" +
        "Set KOKORO_REPO_ROOT to the repo root, or KOKORO_BIN to the kokoro-tts binary.",
    );
  }
  return found;
}

export function defaultBinaryPath(repoRoot: string): string {
  return join(repoRoot, "swift", "musicgen-director", ".build", "release", "kokoro-tts");
}

export function resolveBinaryPath(): string {
  if (process.env.KOKORO_BIN && existsSync(process.env.KOKORO_BIN)) {
    return pResolve(process.env.KOKORO_BIN);
  }
  return defaultBinaryPath(resolveRepoRoot());
}

export async function buildBinary(repoRoot: string, onProgress?: ProgressFn): Promise<void> {
  const pkgPath = join(repoRoot, "swift", "musicgen-director");
  onProgress?.({ kind: "progress", text: "kokoro-tts binary missing — building (swift build -c release, ~minutes)…" });
  await new Promise<void>((resolveP, rejectP) => {
    const proc = spawn("swift", ["build", "-c", "release", "--product", "kokoro-tts", "--package-path", pkgPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lineBuf = { out: "", err: "" };
    const handle = (stream: NodeJS.ReadableStream, key: "out" | "err") => {
      stream.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        lineBuf[key] += text;
        let nl: number;
        while ((nl = lineBuf[key].indexOf("\n")) >= 0) {
          const line = lineBuf[key].slice(0, nl).trim();
          lineBuf[key] = lineBuf[key].slice(nl + 1);
          if (line) onProgress?.({ kind: "progress", text: line });
        }
      });
    };
    handle(proc.stdout!, "out");
    handle(proc.stderr!, "err");
    proc.on("error", (err) => rejectP(new Error(`swift build failed to spawn: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        onProgress?.({ kind: "progress", text: "kokoro-tts build complete." });
        resolveP();
      } else {
        const tail = (lineBuf.out + lineBuf.err).slice(-2000);
        rejectP(new Error(`swift build exited ${code}\n${tail}`));
      }
    });
  });
  await buildMetallib(repoRoot, onProgress);
}

/** Build mlx.metallib and place it next to the kokoro-tts binary. Idempotent, best-effort. */
export async function buildMetallib(repoRoot: string, onProgress?: ProgressFn): Promise<void> {
  const script = join(repoRoot, "swift", "musicgen-director", "scripts", "build-metallib.sh");
  if (!existsSync(script)) return;
  onProgress?.({ kind: "progress", text: "building mlx.metallib (Metal shaders)…" });
  await new Promise<void>((resolveP) => {
    const proc = spawn("bash", [script], { stdio: ["ignore", "pipe", "pipe"] });
    const lineBuf = { out: "", err: "" };
    const handle = (stream: NodeJS.ReadableStream, key: "out" | "err") => {
      stream.on("data", (chunk: Buffer) => {
        lineBuf[key] += chunk.toString();
        let nl: number;
        while ((nl = lineBuf[key].indexOf("\n")) >= 0) {
          const line = lineBuf[key].slice(0, nl).trim();
          lineBuf[key] = lineBuf[key].slice(nl + 1);
          if (line) onProgress?.({ kind: "progress", text: line });
        }
      });
    };
    handle(proc.stdout!, "out");
    handle(proc.stderr!, "err");
    proc.on("error", () => resolveP()); // metallib build is best-effort; don't fail the run
    proc.on("close", () => resolveP());
  });
}

function newestSourceMtimeMs(repoRoot: string): number {
  const sourcesDir = join(repoRoot, "swift", "musicgen-director", "Sources", "KokoroTTSCLI");
  let newest = 0;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith(".swift") && stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
  };
  walk(sourcesDir);
  return newest;
}

export function isBinaryStale(repoRoot: string, bin: string): boolean {
  if (!isFile(bin)) return true;
  const binMtime = statSync(bin).mtimeMs;
  return newestSourceMtimeMs(repoRoot) > binMtime;
}

/** Ensure the kokoro-tts binary exists, building it once if missing. Cached for the process lifetime. */
export async function ensureBinary(onProgress?: ProgressFn): Promise<string> {
  if (_cachedBin && isFile(_cachedBin)) return _cachedBin;

  const explicit = process.env.KOKORO_BIN;
  if (explicit && existsSync(explicit)) {
    _cachedBin = pResolve(explicit);
    return _cachedBin;
  }

  const repoRoot = resolveRepoRoot();
  const bin = defaultBinaryPath(repoRoot);
  if (isFile(bin)) {
    const metallib = join(dirname(bin), "mlx.metallib");
    if (!isFile(metallib)) {
      try {
        await buildMetallib(repoRoot, onProgress);
      } catch {
        /* best-effort */
      }
    }
    _cachedBin = bin;
    return bin;
  }
  await buildBinary(repoRoot, onProgress);
  if (!isFile(bin)) {
    throw new Error(
      `kokoro-tts build reported success but binary not found at ${bin}. ` +
        "Check swift build output; set KOKORO_BIN to override.",
    );
  }
  _cachedBin = bin;
  return bin;
}
