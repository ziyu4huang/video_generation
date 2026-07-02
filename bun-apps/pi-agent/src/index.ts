/**
 * pi-agent — public library surface.
 *
 * pi-agent is primarily a thin wrapper around the official pi `main()` (see
 * `src/cli.ts`), but several of its modules are reusable by OTHER consumers in
 * this monorepo — notably `pi-agent-cli`, which builds its own programmatic
 * sessions but wants the SAME provider catalog, patch primitives, run-dir
 * resolver, doctor, and mode detection rather than a parallel re-implementation.
 *
 * This barrel exports the reusable (non-`main`) surface so downstream packages
 * can depend on `pi-agent` as a workspace library instead of duplicating these
 * concerns. `cli.ts` / `main()` / `bin` stay out of the library path.
 *
 * Re-exported groups:
 *   - providers  : the baked LLM provider catalog (PROVIDERS) + apiKey resolver
 *   - patches    : the env-gated monkey-patch registry (applyPatches, envFlag, ...)
 *   - runDir     : the manifest-driven extension/skill argv resolver
 *   - doctor     : the offline self-check (runChecks/runDoctor) + smoke probe
 *   - mode       : bundler-mode detection (source / bundle / binary)
 */
export * as providers from "./pre-load-providers.ts";
export {
	PROVIDERS,
	resolveApiKey,
	type ApiKey,
} from "./pre-load-providers.ts";

export {
	applyPatches,
	resolvePatchPlan,
	envFlag,
	PATCH_TABLE,
	type AppliedPatch,
	type PatchEntry,
} from "./patches/index.ts";

export {
	resolveRunDirArgv,
	rewriteArgvLazyExtensions,
	buildArgvFromManifest,
	buildBundleArgvFromLayout,
	resolveLazyExtension,
	rewriteExtensionArgs,
	looksLikeAlias,
	detectRunDirMode,
	type RunDirLayoutMode,
	type LazySettings,
} from "../run-dir/resolve.ts";

export {
	runDoctor,
	runChecks,
	realContext,
	isFailing,
	type CheckResult,
	type CheckStatus,
	type DoctorContext,
	type DoctorReport,
	type RunOptions,
} from "./doctor.ts";

export { detectMode, isBunBinary, type BundlerMode } from "./mode.ts";
