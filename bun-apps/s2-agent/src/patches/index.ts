/**
 * Patch registry — every monkey-patch lives behind an env gate so behavior is
 * reversible and debuggable. Add a new patch = add one entry here.
 *
 * IMPORTANT (bundling): dynamic imports must use static string literals so bun
 * can trace and include the modules at bundle time. Do NOT use a variable path
 * like `import(def.module)` — bun cannot statically analyze that and the module
 * will be missing from the bundle.
 */
// envFlag moved to the zero-import leaf ../env-flag.ts (round-2 ticket 05) so
// cli/sessions and the e2e harness share the one definition without importing
// the patch index; re-exported below — still the decision primitive for every
// patch gate.
import { envFlag } from "../env-flag.ts";

/** Literal union of registered patch names. Keep in sync with PATCH_TABLE + the
 *  `switch` in applyPatches() — the `default: never` guard catches a missing case. */
export type PatchName =
	| "skip-update-check"
	| "pre-load-providers"
	| "load-run-dir-resources"
	| "default-model-env"
	| "subagent-model-floor"
	| "ensure-model-tiers"
	| "in-memory-models-store"
	| "ensure-extension-deps"
	| "ext-context-get-system-prompt-options"
	| "ext-api-get-all-tool-definitions"
	| "colliding-command-dispatch"
	| "force-response-language"
	| "editor-history-restore"
	| "startup-history-hint"
	| "autocomplete-source-extension";

export interface AppliedPatch {
  name: PatchName;
  env: string;
  defaultValue: boolean;
  applied: boolean;
}

/** Metadata for each patch: its env gate + the default when the env is unset. */
export interface PatchEntry {
  name: PatchName;
  env: string;
  defaultValue: boolean;
}

/**
 * The patch registry as data. Order = execution order. The module to import per
 * entry is resolved by name in applyPatches()
 * via a static-literal switch (bun needs literal import paths to bundle — see
 * the file header). Adding a patch = add a PatchName literal, an entry here,
 * AND a `case` below (the `default: never` guard enforces the third).
 */
export const PATCH_TABLE: readonly PatchEntry[] = [
  { name: "skip-update-check", env: "BUN_PI_SKIP_UPDATE_CHECK", defaultValue: true },
  { name: "pre-load-providers", env: "BUN_PI_PRE_LOAD_PROVIDERS", defaultValue: true },
  { name: "load-run-dir-resources", env: "BUN_PI_LOAD_RUN_DIR", defaultValue: true },
  { name: "default-model-env", env: "BUN_PI_DEFAULT_MODEL_ENV", defaultValue: true },
  // subagent-model-floor: reads obsidian.subagentModel from ~/.pi/agent/settings.json
  // and publishes it as OB_SUBAGENT_MODEL before main(). The real pi TUI does NOT
  // set OB_PARENT_MODEL/OB_SUBAGENT_MODEL, so without this every distill/garden
  // subagent (zk_card / zk_ask / obsidian_distill) with no --model
  // hits the pi default path → the "no subagent model configured" warning + a
  // slow inherited model → distill timeouts. No ordering dependency on
  // ensure-extension-deps: the settings read goes through the
  // node-builtins-only leaf ../paths.ts (no @earendil-works import at all).
  // Disable with BUN_PI_SUBAGENT_MODEL_FLOOR=0.
  { name: "subagent-model-floor", env: "BUN_PI_SUBAGENT_MODEL_FLOOR", defaultValue: true },
  // ensure-model-tiers: the model-tiers resolver (in s2-agent-ext-subagent)
  // reads ~/.pi/workflows/model-tiers.json per-dispatch with NO env/cascade
  // fallback, so on a fresh machine it returns null and silently falls back to
  // the session model. This patch seeds that file at startup IF absent, from
  // the typed DEFAULT_MODEL_TIER_CONFIG in src/pre-load-providers.ts (the
  // glm-lmstudio mapping). Self-contained — imports only the local
  // pre-load-providers.ts + node builtins (no @earendil-works import), so no
  // ordering dependency on ensure-extension-deps. Idempotent (existence-only
  // gate, never clobbers) + best-effort (write wrapped in try/catch). Disable
  // with BUN_PI_ENSURE_MODEL_TIERS=0.
  { name: "ensure-model-tiers", env: "BUN_PI_ENSURE_MODEL_TIERS", defaultValue: true },
  // in-memory-models-store: forces ModelRuntime.create() to use an
  // InMemoryModelsStore unless the caller passes one, so pi-ai catalog
  // refresh NEVER persists to ~/.pi/agent/models-store.json. Replaces the
  // retired ensure-models-store seed (pi 0.84.2's builtin catalog already
  // ships zai/deepseek/huggingface — models.generated.js — so the file
  // catalog is redundant). Wrap order vs pre-load-providers does not matter:
  // each wrap passes options through, and the mutation lands before the real
  // create() runs either way. Disable with BUN_PI_IN_MEMORY_MODELS_STORE=0.
  { name: "in-memory-models-store", env: "BUN_PI_IN_MEMORY_MODELS_STORE", defaultValue: true },
  // ensure-extension-deps runs LAST among setup patches: it materializes the
  // repo-root node_modules symlinks that let Bun native-import every extension
  // graph (so try-native succeeds and jiti never transforms — see the patch
  // file for the >4 KB tempfile bug this sidesteps). Still before main().
  { name: "ensure-extension-deps", env: "BUN_PI_ENSURE_EXT_DEPS", defaultValue: true },
  // ext-context-get-system-prompt-options: patches ExtensionRunner.prototype.createContext
  // so getSystemPromptOptions() is available on ExtensionContext (not just
  // ExtensionCommandContext). Must run after ensure-extension-deps (which sets up
  // the repo-root symlinks needed to import @earendil-works/pi-coding-agent).
  { name: "ext-context-get-system-prompt-options", env: "BUN_PI_EXT_CTX_GET_SYSTEM_PROMPT_OPTIONS", defaultValue: true },
  // ext-api-get-all-tool-definitions: patches ExtensionRunner.prototype.bindCore
  // so ExtensionRuntime gets getAllToolDefinitions(): ToolDefinition[] for passing
  // full tool definitions (with execute) to WorkflowAgent child sessions.
  { name: "ext-api-get-all-tool-definitions", env: "BUN_PI_EXT_API_GET_ALL_TOOL_DEFS", defaultValue: true },
  // colliding-command-dispatch: patches ExtensionRunner.prototype.getCommand so
  // a command name registered by MULTIPLE extensions still resolves by its
  // plain name (upstream suffixes colliding registrations to name:1/name:2,
  // leaving getCommand("name") undefined — and prompt()'s slash dispatch then
  // falls through, sending the literal "/cmd …" text to the model; measured
  // 2026-08-23, headless-dispatch-hang ticket 03/B4, the repo's `loop` pair).
  // Fallback is deterministic first-registration; the palette is unaffected
  // (it lists resolveRegisteredCommands() directly). Must run after
  // ensure-extension-deps (imports @earendil-works/pi-coding-agent). Disable
  // with BUN_PI_COLLIDING_COMMAND_DISPATCH=0.
  { name: "colliding-command-dispatch", env: "BUN_PI_COLLIDING_COMMAND_DISPATCH", defaultValue: true },
  // force-response-language: wraps AgentSession.prototype._installAgentNextTurnRefresh
  // to PREPEND a forced reply-language block (from responseLanguage in
  // ~/.pi/agent/settings.json) to every TURN's system prompt (per-turn, not
  // cached) — main, subagent subprocess, workflow agent, obsidian/zk child all
  // construct an AgentSession, so it reaches all of them by construction.
  // Per-turn re-reads settings.json, so /response-language flips live with NO
  // reload. Replaces the drift-able AGENTS.md/CLAUDE.md prose with a
  // top-of-prompt, non-negotiable block that survives role labels + the model's
  // English default. Must run after ensure-extension-deps (imports
  // @earendil-works/pi-coding-agent). Disable with BUN_PI_FORCE_RESPONSE_LANGUAGE=0.
  { name: "force-response-language", env: "BUN_PI_FORCE_RESPONSE_LANGUAGE", defaultValue: true },
  // editor-history-restore: wraps InteractiveMode.prototype.init to hydrate
  // this.editor.history from the per-cwd prompt-history.jsonl (written by the
  // s2-agent-ext-prompt-history extension) so Up/Down recalls prior sessions.
  // Must run after ensure-extension-deps (imports @earendil-works/pi-coding-agent
  // + the sibling prompt-history store). Disable with BUN_PI_EDITOR_HISTORY_RESTORE=0.
  { name: "editor-history-restore", env: "BUN_PI_EDITOR_HISTORY_RESTORE", defaultValue: true },
  // startup-history-hint: wraps InteractiveMode.prototype.init to append
  // "↑/↓ to browse history" to the expanded startup keybinding strip (the hint
  // otherwise lives only in the help table). No extension hook exists to
  // contribute startup hints (setHeader is full-replace), so a patch is needed.
  // Disable with BUN_PI_STARTUP_HISTORY_HINT=0.
  { name: "startup-history-hint", env: "BUN_PI_STARTUP_HISTORY_HINT", defaultValue: true },
  // autocomplete-source-extension: wraps InteractiveMode.prototype.prefixAutocompleteDescription
  // so the /<cmd> and /skill: picker shows the OWNING extension inside each entry's
  // scope marker — locally-loaded s2-agent-ext-<name> resources render a bare marker
  // (e.g. [t]) with no package; this injects " · <name>" → "[t · wayfind] desc". npm/git
  // sources are left unchanged (they already self-attribute). Must run after
  // ensure-extension-deps (imports @earendil-works/pi-coding-agent). Disable with
  // BUN_PI_AUTOCOMPLETE_SOURCE_EXTENSION=0.
  { name: "autocomplete-source-extension", env: "BUN_PI_AUTOCOMPLETE_SOURCE_EXTENSION", defaultValue: true },
];

/** Re-export of the leaf definition — see ../env-flag.ts (round-2 ticket 05). */
export { envFlag };

/** The one literal `"1" | "true"` check every debug gate shares. Case-sensitive
 *  on purpose — this is the exact legacy spelling, not envFlag's wider set. */
function isOneOrTrue(env: Record<string, string | undefined>, name: string): boolean {
  return env[name] === "1" || env[name] === "true";
}

/**
 * Is patch debug logging on? Deliberately NOT envFlag: it preserves the exact
 * legacy semantics of the copy-pasted checks it replaced ("1"/"true" only, no
 * "yes") so rewiring the call sites changed nothing about who logs.
 */
export function isPatchDebug(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isOneOrTrue(env, "BUN_PI_DEBUG_PATCHES");
}

/**
 * isPatchDebug OR the older model-debug flag — the exact union the three
 * model-touching patches (default-model-env, subagent-model-floor,
 * ensure-model-tiers) have always logged under. Both env names predate envFlag;
 * a single widened gate would silently change who logs.
 */
export function isPatchOrModelsDebug(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isPatchDebug(env) || isOneOrTrue(env, "PI_DEBUG_MODELS");
}

/**
 * Outcome report for a patch gated by its own env opt-out, replacing the
 * copy-pasted `enabled ? outcome : true`. When disabled, the patch did exactly
 * what it was asked to do (nothing), so its self-report must read `true` —
 * `readPatchOutcome` treats a `false` as a BROKEN patch, and a disabled patch
 * is not broken (`applyPatches` never even imports the module). When enabled,
 * the wrap's own boolean flows through unchanged.
 */
export function gatedPatchOutcome(enabled: boolean, outcome: boolean): boolean {
  return enabled ? outcome : true;
}

/**
 * Pure: which patches WOULD apply for a given env, without executing any.
 * Returns the AppliedPatch[] (decision only). Separating decision from
 * execution makes the gating unit-testable without triggering real patch
 * side effects (monkey-patching, argv splicing, env mutation).
 *
 * NOTE this is INTENT, not outcome. `applyPatches()` downgrades `applied` to
 * false for any patch that was enabled here but did not actually bind.
 */
export function resolvePatchPlan(
  table: readonly PatchEntry[] = PATCH_TABLE,
  env: Record<string, string | undefined> = process.env,
): AppliedPatch[] {
  return table.map((e) => ({ ...e, applied: envFlag(e.env, e.defaultValue, env) }));
}

/**
 * Read a patch module's self-reported outcome.
 *
 * Contract: a patch module MAY export `patchApplied: boolean` saying whether its
 * wrap actually bound. `undefined` means the module makes no claim (an
 * unconditional side effect, where there is nothing to fail) and is treated as
 * applied.
 *
 * WHY: `applied` used to be a pure function of the environment — it said the
 * module was IMPORTED, never that the patch took hold. That is precisely the
 * bug class this package has already been bitten by once: pre-0.80,
 * `ModelRegistry.prototype.loadModels` vanished upstream, the patch installed a
 * method nothing called, and every check stayed green because models.json
 * happened to duplicate the catalog. Six modules also hardcoded
 * `…PatchApplied = true` regardless of their own return value, and two printed
 * "patch applied" under debug even when the wrap had failed. So the reporting
 * chain built AFTER that incident could not have detected a recurrence — and
 * neither could e2e-patches.test.ts, which asserts every entry reports
 * `✓ applied`.
 *
 * Both patterns are now structurally blocked: patch-outcome.test.ts scans every
 * module in this directory and fails on a hardcoded `…PatchApplied = true` or a
 * top-level call that discards its own `: boolean` return. The list of modules
 * held to the `patchApplied` contract is DERIVED from those sources, not typed
 * out — `force-response-language` was missing from the hand-written roster from
 * the day it was written until 2026-08-19.
 */
export function readPatchOutcome(mod: unknown): boolean | undefined {
  const v = (mod as { patchApplied?: unknown } | null)?.patchApplied;
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Apply all enabled patches. Must run *before* `main()` is called, because
 * `main()` constructs the `ModelRegistry` instance whose prototype we patch.
 *
 * Each patch is gated on an env flag (resolvePatchPlan); a disabled patch is
 * never executed. The per-patch import is a static string literal inside a
 * switch case so bun can trace + bundle it — do NOT replace with a variable
 * `import(entry.module)` (see file header).
 */
export async function applyPatches(): Promise<AppliedPatch[]> {
  const debug = isPatchDebug();
  const applied = resolvePatchPlan();

  for (const p of applied) {
    if (!p.applied) continue;
    let mod: unknown;
    switch (p.name) {
      case "skip-update-check":
        mod = await import("./skip-update-check.ts");
        break;
      case "pre-load-providers":
        mod = await import("./pre-load-providers.ts");
        break;
      case "load-run-dir-resources":
        mod = await import("./load-run-dir-resources.ts");
        break;
      case "default-model-env":
        mod = await import("./default-model-env.ts");
        break;
      case "subagent-model-floor":
        mod = await import("./subagent-model-floor.ts");
        break;
      case "ensure-model-tiers":
        mod = await import("./ensure-model-tiers.ts");
        break;
      case "in-memory-models-store":
        mod = await import("./in-memory-models-store.ts");
        break;
      case "ensure-extension-deps":
        mod = await import("./ensure-extension-deps.ts");
        break;
      case "ext-context-get-system-prompt-options":
        mod = await import("./ext-context-get-system-prompt-options.ts");
        break;
      case "ext-api-get-all-tool-definitions":
        mod = await import("./ext-api-get-all-tool-definitions.ts");
        break;
      case "colliding-command-dispatch":
        mod = await import("./colliding-command-dispatch.ts");
        break;
      case "force-response-language":
        mod = await import("./force-response-language.ts");
        break;
      case "editor-history-restore":
        mod = await import("./editor-history-restore.ts");
        break;
      case "startup-history-hint":
        mod = await import("./startup-history-hint.ts");
        break;
      case "autocomplete-source-extension":
        mod = await import("./autocomplete-source-extension.ts");
        break;
      default: {
        // Exhaustiveness guard — a PATCH_TABLE entry with no matching case.
        const _exhaustive: never = p.name;
        throw new Error(`unhandled patch: ${_exhaustive}`);
      }
    }

    // Intent -> outcome. A patch that was enabled but did not bind is reported
    // as NOT applied, and says so on stderr rather than only under a debug flag:
    // a silently no-op'd patch is the failure mode that has actually cost this
    // package, and it is invisible by construction unless something shouts.
    if (readPatchOutcome(mod) === false) {
      p.applied = false;
      console.error(
        `[bun-pi] patch "${p.name}" was enabled but did NOT bind — its hook target ` +
          `is missing or already wrapped. Expect the behaviour it provides to be absent. ` +
          `(pinned pi core: check for an upstream rename; disable with ${p.env}=0 to silence)`,
      );
    }
  }

  if (debug) {
    console.error("[bun-pi] patches:");
    for (const p of applied) {
      console.error(
        `  ${p.applied ? "✓" : "·"} ${p.name}  (env ${p.env}, default ${p.defaultValue})`,
      );
    }
  }

  return applied;
}
