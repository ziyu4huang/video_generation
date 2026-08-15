/**
 * ensure-model-tiers — seed ~/.pi/workflows/model-tiers.json at startup if it
 * does not yet exist, from a typed DEFAULT_MODEL_TIER_CONFIG.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The model-tiers resolver (in pi-agent-ext-subagent) reads
 * ~/.pi/workflows/model-tiers.json per-dispatch to pick a tier model
 * (small/medium/big) or a capability model (vision). It has NO env override and
 * NO cascade fallback — when the file is absent it returns null and the caller
 * silently falls back to the session/default model. On a fresh machine (or a
 * fresh ~/.pi) that means tier routing quietly does nothing instead of using the
 * team's preferred glm-lmstudio mapping.
 *
 * Because the resolver only READS the file (never writes it), the only way for
 * the pi-agent host to guarantee a non-null config on a fresh machine is to
 * materialize the file itself, at startup, before any dispatch. This patch does
 * exactly that — idempotently.
 *
 * WHAT IT DOES
 * ------------
 * At import time (run inside applyPatches()), if
 * ~/.pi/workflows/model-tiers.json does NOT exist and the gate is enabled, write
 * the DEFAULT_MODEL_TIER_CONFIG (from ../model-tiers-default.ts — the
 * glm-lmstudio preset: small=glm-4.7, medium/big=glm-5.3,
 * vision=lm-studio google/gemma-4-12b-qat) to that path, creating the parent
 * directory as needed. It NEVER overwrites, mutates, or even reads an existing
 * file's contents — existence alone is the gate.
 *
 * SAFETY
 * ------
 *   - Idempotent: the existence check short-circuits; a second startup is a
 *     no-op (and so is every subsequent one).
 *   - Never clobbers: any pre-existing file (a user's hand-edited config or a
 *     different preset) is left completely untouched.
 *   - Best-effort: the write is wrapped in try/catch — a config-seed failure
 *     must never block startup.
 *
 * MODE GATING
 * -----------
 * Mode-agnostic: a tier config is useful in every mode. No-op when the file
 * already exists. Gated by `BUN_PI_ENSURE_MODEL_TIERS` (default on) via
 * PATCH_TABLE; set `BUN_PI_ENSURE_MODEL_TIERS=0` to disable.
 *
 * TESTABILITY
 * -----------
 * `buildModelTiersJson()` and `shouldEnsureModelTiers()` in
 * ../model-tiers-default.ts are pure (serialization + decision only); the
 * import-time side effect here is a thin wrapper around them. The pure helpers
 * are unit-tested in ensure-model-tiers.test.ts; the real fs write to the user's
 * home is intentionally NOT tested (it would mutate the user's live config).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_MODEL_TIER_CONFIG, buildModelTiersJson, shouldEnsureModelTiers } from "../model-tiers-default.ts";

const MODEL_TIERS_PATH = join(homedir(), ".pi", "workflows", "model-tiers.json");

const debug =
	process.env.BUN_PI_DEBUG_PATCHES === "1" ||
	process.env.BUN_PI_DEBUG_PATCHES === "true";
const enabled = process.env.BUN_PI_ENSURE_MODEL_TIERS !== "0";

// Import-time side effect: materialize the config file before main() if (and
// only if) it is absent. Runs inside applyPatches(). The DEFAULT_MODEL_TIER_CONFIG
// is referenced to keep it live-linked (a tree-shake that dropped an unused
// import would be wrong here — it is used by buildModelTiersJson at runtime).
if (shouldEnsureModelTiers({ fileExists: existsSync(MODEL_TIERS_PATH), enabled })) {
	try {
		mkdirSync(dirname(MODEL_TIERS_PATH), { recursive: true });
		writeFileSync(MODEL_TIERS_PATH, buildModelTiersJson(DEFAULT_MODEL_TIER_CONFIG), "utf8");
		if (debug) {
			console.error("[bun-pi] ensure-model-tiers seeded:", MODEL_TIERS_PATH);
		}
	} catch {
		// best-effort — never block startup on a config-seed failure
		if (debug) {
			console.error("[bun-pi] ensure-model-tiers seed FAILED for:", MODEL_TIERS_PATH);
		}
	}
}

export const ensureModelTiersPatchApplied = true;
