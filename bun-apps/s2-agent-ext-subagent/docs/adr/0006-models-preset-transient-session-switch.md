**ID:** `ADR-subagent-0006` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# 0006 — `/models-preset` is a transient session switch; `~/.pi` stays built-in-pure

**Status:** accepted
**Date:** 2026-08-22
**Supersedes the persistent-write behavior shipped with the model-preset system (spec c080d67f, implementation 044da027), which wrote the chosen preset into `~/.pi/workflows/model-tiers.json` with a `.bak` backup.**

## Context

`/models-preset` was built as a setup-time configurator: it wrote a named
preset's full `{tiers, capabilities}` to `~/.pi/workflows/model-tiers.json`.
That file drives **subagent tier routing only** — it never touches the main
session's model, which pi resolves from `~/.pi/agent/settings.json`
(`defaultModel`/`defaultProvider`), env, flags, or the host package's built-in
default. Two consequences, both observed live:

1. **The user-visible "current model" never changed.** Running
   `/models-preset glm-lmstudio` while settings.json pinned
   `deepseek/deepseek-v4-flash` left the chat model exactly where it was. The
   command looked broken even though it did precisely what it was designed to
   do — write a routing file.
2. **It violated the intended `~/.pi` hygiene.** The user's stance: `~/.pi`
   carries NO model customization — the only acceptable content is what the
   host package's built-ins materialize (the `ensure-model-tiers` startup seed
   of `DEFAULT_MODEL_TIER_CONFIG`, the built-in model default splice). Every
   file the old command wrote (`.bak`s included) was customization drift.

## Decision

1. **`/models-preset` is transient.** Applying a preset:
   - switches the main session model live via `pi.setModel` (headline model =
     the preset's `big` tier — see `mainModelSpec` in `src/presets.ts`), and
   - installs the preset's full tier/capability routing as an **in-memory,
     process-scope override** (`setTransientModelTierConfig` in
     `@repo/s2-agent-core-runtime`), so subagents dispatched during the session
     follow the preset.
2. **The command never writes anywhere.** No `~/.pi/workflows/model-tiers.json`,
   no `.bak`, no settings.json keys. The command module's DI surface has no
   save/write dependency at all — a regression must ADD one and show up in
   `tests/models-preset-command.test.ts` as an untested side effect.
3. **Resolution reads the effective config; file readers do not.**
   `getEffectiveModelTierConfig()` = transient override ?? on-disk file, and
   only resolution consumers (`agent-model.ts`, `agent.ts`,
   `budget-defaults.ts`, `spawn-subagent-subprocess.ts`) use it.
   `loadModelTierConfig()` stays FILE-ONLY so `/workflows-models` shows exactly
   what a save would write.
4. **Session boundary resets the override.** The subagent extension clears the
   transient config on `session_start`; process exit does the rest. Restart or
   session switch = back to built-in/file routing.
5. **`~/.pi` stays built-in-pure.** The only writer of
   `~/.pi/workflows/model-tiers.json` is the `ensure-model-tiers` startup seed
   (which never clobbers an existing file); the only main-model default source
   is `BUILTIN_MODEL_DEFAULT` when nothing personal/env/flag overrides it.
   Users who want a persistent tier edit use `/workflows-models` explicitly.

## Consequences

- `/models-preset glm-lmstudio` now visibly switches the chat model to
  `zai/glm-5.3` on the next turn, and in-session subagent tiers follow glm
  routing — with zero bytes written to `~/.pi`.
- The old `.bak` artifacts left on machines by the previous behavior are stale
  customization and should be deleted (machine cleanup, not code).
- Adding a preset stays data-only (`MODEL_PRESETS`); its `big` tier is the
  headline model users read in the label.
- Child processes spawned as subprocesses resolve their model in the parent,
  so the transient override propagates through dispatch; anything that
  re-reads config from disk in a fresh process correctly sees the built-in
  seed instead.
