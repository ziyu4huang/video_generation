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

// Patches MUST be applied before main() constructs ModelRegistry.
await applyPatches();

// Pass through argv untouched. The official parser handles every pi flag.
await main(process.argv.slice(2));
