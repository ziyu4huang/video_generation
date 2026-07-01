#!/usr/bin/env bun
/**
 * pi-agent — thin wrapper around the REAL pi TUI with monkey-patch hooks.
 *
 * What this does:
 *   1. Apply env-gated monkey-patches (default: force pi to load models ONLY
 *      from ~/.pi/agent/models.json).
 *   2. Delegate everything else — argv parsing, TUI, print/rpc mode, sessions,
 *      tools — to the official `main()` from @earendil-works/pi-coding-agent.
 *
 * It is NOT a re-implementation of pi. It IS pi, lightly patched.
 *
 * Usage (after `bun install` at the repo root):
 *   bun ./pi-agent/src/cli.ts                 # interactive TUI
 *   bun ./pi-agent/src/cli.ts -p "hello"      # print mode
 *   bun ./pi-agent/src/cli.ts --list-models   # list (only models.json entries)
 *
 * Toggle the model patch:
 *   BUN_PI_ONLY_MODELS_JSON=0 bun ./pi-agent/src/cli.ts --list-models
 *
 * Debug which patches ran:
 *   BUN_PI_DEBUG_PATCHES=1 bun ./pi-agent/src/cli.ts
 */
import { main } from "@earendil-works/pi-coding-agent";
import { applyPatches } from "./patches/index.ts";
import { probeWorkspaceDeps } from "./preflight.ts";

// ── Preflight: ensure workspace deps resolve before pi loads extensions ──────
// pi loads every extension in `.pi/settings.json`; those extensions import
// workspace peers as bare specifiers. If `bun install` hasn't been run at the
// monorepo root, pi crashes with "Cannot find module '...'" before the TUI
// starts. We surface an actionable message instead. Skipped for paths that
// don't load extensions, and via BUN_PI_SKIP_PREFLIGHT=1.
const argv = process.argv.slice(2);
const isNoExt = argv.some(
  (a) =>
    a === "-ne" ||
    a === "--no-extensions" ||
    a === "-h" ||
    a === "--help" ||
    a === "-V" ||
    a === "--version",
);
if (!isNoExt && process.env.BUN_PI_SKIP_PREFLIGHT !== "1") {
  const probe = await probeWorkspaceDeps();
  if (probe.repoRoot && !probe.ok) {
    console.error("\x1b[31m✗ pi-agent preflight: workspace deps unresolved.\x1b[0m");
    console.error("  pi's extensions will fail to load. Missing:");
    for (const f of probe.failures) console.error(`    ${f.from} → ${f.dep}`);
    console.error("");
    console.error("  Fix (one of):");
    console.error(`    bun run setup            # from bun-apps/pi-agent`);
    console.error(`    bun install              # at ${probe.repoRoot} (monorepo root)`);
    console.error("  Skip this check: BUN_PI_SKIP_PREFLIGHT=1");
    process.exit(1);
  }
}

// Patches MUST be applied before main() constructs ModelRegistry.
await applyPatches();

// Pass through argv untouched. The official parser handles every pi flag.
await main(argv);
