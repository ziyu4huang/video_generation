/**
 * ensure-models-store — seed ~/.pi/agent/models-store.json at startup if it
 * does not yet exist, from the typed DEFAULT_MODELS_STORE catalog.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * pi core's ModelRuntime resolves provider/model catalogs through a
 * FileModelsStore rooted at ~/.pi/agent/models-store.json (see
 * model-runtime.js: modelsStorePath ?? dirname(models.json)/models-store.json).
 * The zai / deepseek / huggingface providers this repo depends on (zai/glm-5.3
 * is the BUILT-IN default model — src/builtin-model-default.ts) exist ONLY as
 * store entries; without the file, a fresh ~/.pi has no zai provider at all
 * and every session falls back to whatever pi's builtin catalog happens to
 * offer. Materializing the curated catalog at startup makes the package's
 * model config fully built-in: no personal ~/.pi file required.
 *
 * WHAT IT DOES
 * ------------
 * At import time (run inside applyPatches()), if
 * ~/.pi/agent/models-store.json does NOT exist and the gate is enabled, write
 * DEFAULT_MODELS_STORE (from ../models-store-default.ts) to that path. It
 * NEVER overwrites, mutates, or reads an existing file's contents — existence
 * alone is the gate. pi's own catalog refresh (which updates
 * checkedAt/etag/lastModified per provider) keeps working on top of the seed.
 *
 * SAFETY
 * ------
 *   - Idempotent: the existence check short-circuits every later startup.
 *   - Never clobbers: any pre-existing catalog (refreshed by pi, hand-edited)
 *     is left completely untouched.
 *   - Best-effort: the write is wrapped in try/catch — a seed failure must
 *     never block startup.
 *
 * ORDERING
 * --------
 * Deliberately self-contained (node builtins + the local
 * models-store-default.ts only, NO @earendil-works import), so it has no
 * dependency on ensure-extension-deps' repo-root symlinks — same property as
 * ensure-model-tiers. Runs early in PATCH_TABLE.
 *
 * TESTABILITY
 * -----------
 * `buildModelsStoreJson()` and `shouldEnsureModelsStore()` in
 * ../models-store-default.ts are pure (serialization + decision only); the
 * import-time side effect here is a thin wrapper. The real fs write to the
 * user's home is intentionally NOT tested (it would mutate the user's live
 * catalog).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_MODELS_STORE,
	buildModelsStoreJson,
	shouldEnsureModelsStore,
} from "../models-store-default.ts";

const MODELS_STORE_PATH = join(
	homedir(),
	".pi",
	"agent",
	"models-store.json",
);

const debug =
	process.env.BUN_PI_DEBUG_PATCHES === "1" ||
	process.env.BUN_PI_DEBUG_PATCHES === "true";
const enabled = process.env.BUN_PI_ENSURE_MODELS_STORE !== "0";

// Import-time side effect: materialize the catalog before main() if (and only
// if) it is absent. Runs inside applyPatches().
if (
	shouldEnsureModelsStore({
		fileExists: existsSync(MODELS_STORE_PATH),
		enabled,
	})
) {
	try {
		mkdirSync(dirname(MODELS_STORE_PATH), { recursive: true });
		writeFileSync(
			MODELS_STORE_PATH,
			buildModelsStoreJson(DEFAULT_MODELS_STORE),
			"utf8",
		);
		if (debug) {
			console.error("[bun-pi] ensure-models-store seeded:", MODELS_STORE_PATH);
		}
	} catch {
		// best-effort — never block startup on a catalog-seed failure
		if (debug) {
			console.error(
				"[bun-pi] ensure-models-store seed FAILED for:",
				MODELS_STORE_PATH,
			);
		}
	}
}
