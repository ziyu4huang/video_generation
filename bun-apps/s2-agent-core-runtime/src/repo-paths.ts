/**
 * repo-paths.ts — shared repo-root / MLX-runpy path resolution.
 *
 * The media extensions (ltx, flux2, krea2, movie-director/kokoro) each shipped
 * a byte-identical "walk up from this module to the dir containing my marker,
 * unless an env var overrides it" walker plus the same MLX venv/run.py
 * resolver. This module is the shared contract (self-arc-20 ticket 02): the
 * caller names its env var, marker path, and error text, so each extension
 * keeps ITS domain identity (message, env names) while the walk + resolution
 * logic lives in exactly one place.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve as pResolve } from "node:path";

/** Walk up from `start` until a dir contains `markerSegments` (default 12 levels, matching the original per-package walkers). */
export function walkUpToMarker(start: string, markerSegments: string[], maxLevels = 12): string | null {
  let dir = start;
  for (let i = 0; i < maxLevels; i++) {
    if (existsSync(join(dir, ...markerSegments))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface RepoRootByMarkerOptions {
  /** Env var consulted first as an absolute override (e.g. `LTX_VIDEO_REPO_ROOT`). */
  envVar: string;
  /** Marker path segments relative to the repo root (e.g. `["swift", "ltx-video-director", "Package.swift"]`). */
  markerSegments: string[];
  /** Package label the error names (e.g. `s2-agent-ext-ltx`). */
  label: string;
  /**
   * Trailing error clause after "or " (e.g. `LTX_VIDEO_BIN to the ltx-video
   * binary`) — kept caller-owned so each package's remediation text stays
   * byte-identical to what it printed before delegating here.
   */
  hint: string;
  /**
   * Where to walk UP from — the CALLER's module dir. This module deliberately
   * does NOT read `import.meta.dir` itself: Bun's bundler inlines that as a
   * build-machine absolute path, and anything bundled into the standalone shim
   * would fail the relocatability gate (ADR-file2md-0001 class). Callers pass
   * their own `(import.meta as any).dir` (bundled callers in the deploy tree
   * already resolve `#pi/ext-dir`-style relocation); absent, cwd is used.
   */
  from?: string;
}

/**
 * Resolve a repo root the way every media extension does: an explicit env
 * override wins; otherwise walk up from `from` (caller's module dir) to the
 * dir containing the package's marker. The thrown error matches the
 * historical per-package text shape exactly:
 *   `<label>: cannot locate repo root (<markerPath not found>).\nSet <envVar> to the repo root, or <hint>.`
 */
export function resolveRepoRootByMarker(opts: RepoRootByMarkerOptions): string {
  const override = process.env[opts.envVar];
  if (override) return pResolve(override);
  const here = opts.from ?? process.cwd();
  const found = walkUpToMarker(here, opts.markerSegments);
  if (!found) {
    const markerPath = opts.markerSegments.join("/");
    throw new Error(
      `${opts.label}: cannot locate repo root (${markerPath} not found).\n` +
        `Set ${opts.envVar} to the repo root, or ${opts.hint}.`,
    );
  }
  return found;
}

/** Resolve the MLX venv python + run.py from the repo root (env-overridable). */
export function resolveRunPyPaths(repoRoot: string): { python: string; runPy: string } {
  const python = process.env.MLX_VENV_PYTHON ?? join(repoRoot, "python", "venv", "bin", "python");
  const runPy = process.env.RUN_PY ?? join(repoRoot, "python", "mlx-movie-director", "run.py");
  return { python, runPy };
}
