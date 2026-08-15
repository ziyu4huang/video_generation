/**
 * ensure-workspace-dist.ts — self-heal stale `dist/` builds before extensions load.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * Four `@repo/*` packages (workflow, superpowers, wayfind, webui) resolve their
 * package entry to `./dist/index.js` — a GITIGNORED, locally built artifact.
 * When a refactor changes a package's src (or a sibling's exported surface that
 * the dist bundle imports at runtime) without rebuilding, the next boot's
 * native import of an extension graph fails on the removed/renamed export, jiti
 * falls back to transforming the whole graph, the first >4 KB module gets
 * base64-wrapped into a data URL, and Bun dies with the cryptic
 * `ResolveMessage: NameTooLong`. CI can never catch this — dist is gitignored,
 * so CI always builds fresh; only a developer machine with a stale local dist
 * breaks, at boot. (Incident 2026-08-15: cf6f1394 removed `homeDir` from the
 * subagent barrel; workflow's stale dist still imported it; movie-director
 * became un-loadable. See ../workspace-dist-staleness.ts.)
 *
 * WHAT IT DOES
 * ------------
 * At import time (inside applyPatches, before main() and extension loading):
 * for every `@repo/*` package under bun-apps/ whose entry resolves into
 * `./dist/`, compare the newest compilable-src mtime against the newest dist
 * mtime. When stale, print WHY the boot would break and run the package's own
 * `bun run build` (same command as its canonical test script) to self-heal.
 * A failed rebuild never blocks startup — the warning names the manual command.
 *
 * MODE GATING
 * -----------
 * SOURCE mode only (same import.meta.url key as ensure-extension-deps): bundle
 * and binary modes ship their own built artifacts. The rebuild is NOT gated on
 * running-under-tests: Bun sets no detectable test-mode env/argv, and healing a
 * stale dist mid-test-run is the desired outcome anyway (same discipline as
 * ensure-extension-deps, whose symlink side effects also run under tests).
 *
 * SAFETY
 * ------
 *   - Zero cost when nothing is stale (two mtime walks per dist-entry package).
 *   - Best-effort: every step is try/catch'd; a failure warns, never throws.
 *   - Idempotent: after a successful rebuild the dist is fresh and the next
 *     boot is a no-op.
 *
 * Gate: BUN_PI_ENSURE_WORKSPACE_DIST (default on) via PATCH_TABLE.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  distEntryMain,
  newestSrcMtimeMs,
  newestMtimeMs,
  shouldRebuildDist,
} from "../workspace-dist-staleness.ts";

// SOURCE mode only — match the same import.meta.url key the other mode-aware
// patches use. Bundle = /dist/pi-agent/pi-agent.js; binary = $bunfs|~BUN.
const url = import.meta.url;
const isSource = url.includes("/src/patches/");

let patchApplied = false;

if (isSource) {
  const repoRoot = path.resolve(import.meta.dirname, "../../../..");
  const bunAppsDir = path.join(repoRoot, "bun-apps");

  let appDirs: string[] = [];
  try {
    appDirs = readdirSync(bunAppsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    /* bun-apps missing — nothing to check */
  }

  for (const dir of appDirs) {
    const pkgDir = path.join(bunAppsDir, dir);
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (typeof pkg.name !== "string" || !pkg.name.startsWith("@repo/")) continue;
    const entry = distEntryMain(pkg);
    if (!entry) continue; // src-entry package — no build artifact to go stale

    const srcDir = path.join(pkgDir, "src");
    const distDir = path.join(pkgDir, "dist");
    if (!existsSync(srcDir)) continue;
    const stale = shouldRebuildDist({
      newestSrcMs: newestSrcMtimeMs(srcDir),
      newestDistMs: newestMtimeMs(distDir),
    });
    if (!stale) continue;

    const hint = `( cd bun-apps/${dir} && bun run build )`;
    console.error(`[ensure-workspace-dist] ${pkg.name}: dist/ is stale — rebuilding (${hint}) …`);
    try {
      const res = spawnSync("bun", ["run", "build"], {
        cwd: pkgDir,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 180_000,
        env: process.env,
      });
      const stillStale = shouldRebuildDist({
        newestSrcMs: newestSrcMtimeMs(srcDir),
        newestDistMs: newestMtimeMs(distDir),
      });
      if (res.status !== 0 || stillStale) {
        const tail = (res.stderr?.toString() ?? res.stdout?.toString() ?? "").slice(-800);
        console.error(
          `[ensure-workspace-dist] ${pkg.name}: rebuild FAILED (status ${res.status}). ` +
            `Boot may fail with a NameTooLong extension-load error. Run manually: ${hint}\n${tail}`,
        );
      } else {
        console.error(`[ensure-workspace-dist] ${pkg.name}: dist rebuilt OK.`);
      }
    } catch (e) {
      console.error(
        `[ensure-workspace-dist] ${pkg.name}: rebuild spawn failed: ${(e as Error).message}. ` +
          `Run manually: ${hint}`,
      );
    }
  }
  patchApplied = true;
}

export { patchApplied };
