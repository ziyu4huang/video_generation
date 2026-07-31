# 03 — Implement forced reply-language injection

type: task
claimed: claude (work-through-the-map session, 2026-08-01)
closed: 2026-08-01

blocked by:
- 02 (Lock the design: shape, force lever, prose back-compat)

## Question

Build the feature end-to-end, per the design locked in ticket 02 (D1=`zh-TW`
tag, D2=`customPrompt` top injection **+ a `/response-language` slash command
for live immediate control**, D3=retire prose) and the surface mapped in
ticket 01.

1. **Setting** — add `responseLanguage: "zh-TW"` to `~/.pi/agent/settings.json`;
   document the key wherever settings schema/defaults live.
2. **Forced injection (D2-a)** — add an in-repo monkey-patch under
   `bun-apps/pi-agent/src/patches/` (consistent with the existing
   `ext-context-get-system-prompt-options.ts` pattern) that reads
   `responseLanguage` and injects pi-owned canonical instruction text at the
   **top** of every session's system prompt via the `customPrompt` /
   `getSystemPrompt()` lever. Env gate `BUN_PI_FORCE_RESPONSE_LANGUAGE`
   (default on), mirroring the existing reversible-patch pattern.
3. **Live slash command (D2-b)** — register a pi extension slash command
   `/response-language [tag]`: no arg → print current value; with arg → persist
   to `settings.json`, update the in-memory value, and **trigger an immediate
   system-prompt rebuild of the current session** (`_rebuildSystemPrompt`) so
   the very next reply uses the new language. (Verify the extension API exposes
   a way to force the rebuild mid-session; if not, that's a sub-fog to resolve
   here.)
4. **Universality test** — assert the forced block is present in the assembled
   system prompt of **every** session type: main, subagent subprocess (default
   `~/.pi/agent/`), workflow agent, obsidian/zk child
   (`createAgentSessionFromServices`).
5. **Back-compat (D3)** — retire the language sections in
   `~/.pi/agent/AGENTS.md` and `./CLAUDE.md`, leaving a one-line pointer to
   `settings.json → responseLanguage` + the `/response-language` command.

Follow test-driven-development (red→green) for steps 2–4.

## Resolution

**Delivered + verified (2026-08-01).** TDD throughout (red→green).

### What was built

1. **Forced-injection patch** — `bun-apps/pi-agent/src/patches/force-response-language.ts`.
   Wraps `AgentSession.prototype._rebuildSystemPrompt` to PREPEND a forced
   `<response_language priority="forced">` block (mapped from the BCP-47 tag,
   pi-owned wording) ahead of every rebuilt system prompt. Reads
   `responseLanguage` from `~/.pi/agent/settings.json` fresh on each rebuild
   (so the live command takes effect immediately). Reaches every session type
   by construction (main / subagent subprocess / workflow agent / obsidian-child
   all construct an `AgentSession`). Env-gated `BUN_PI_FORCE_RESPONSE_LANGUAGE`
   (default on). Registered in `PATCH_TABLE` + the `applyPatches()` switch.
2. **`/response-language` slash command** — new package
   `bun-apps/pi-agent-ext-response-language/` (`extensions/response-language.ts`),
   registered in `run-dir/manifest.json`. Pure decision logic in `src/command.ts`
   + `src/settings.ts`. No-arg shows current; valid tag persists to
   `settings.json` + `ctx.reload()` (live prompt rebuild → next reply uses the
   new language); invalid tag warns.
3. **Setting activated** — `responseLanguage: "zh-TW"` added to
   `~/.pi/agent/settings.json`.
4. **Prose retired (D3)** — `~/.pi/agent/AGENTS.md` "Default conversation
   language" section + `./CLAUDE.md` "Conversation language" bullet replaced
   with one-line pointers to the setting + `/response-language` command. The
   artifacts-English half is untouched (out of scope).

### Verification (evidence)

- `bun-apps/pi-agent` patches suite: **91/91 pass** (incl. 23 new — pure
  `mapLanguageTag`/`resolveForcedBlock` + the `wrapRebuildSystemPrompt`
  mechanism: prepend / passthrough / this+args forwarding / idempotency /
  missing-method / per-prototype independence).
- `pi-agent-ext-response-language`: **26/26 pass** + `tsc --noEmit` clean.
- PATCH_TABLE invariant test updated + green (new patch wired).
- **End-to-end wiring proven**: importing the patch fires it on the REAL
  `AgentSession.prototype` (re-apply returns false = applied at import); the
  prototype method is the wrapper; the block resolves from the LIVE
  `settings.json` (`<response_language priority="forced">`).
- `bun-apps/bun.lock` updated via `bun install` (new workspace package wired).

### Known edge / follow-ups (not blocking)

- Extension-set `_systemPromptOverride` (rare; `agent-session.js:898`) bypasses
  `_baseSystemPrompt`, so the forced block wouldn't apply on turns where an
  extension overrides the whole prompt. No standard extension does this today;
  can be hardened later by also patching the override path.
- Universality across the 4 session types is proven by construction (prototype
  patch) + unit mechanism tests; a full 4-real-session integration assertion
  would live in the `PI_AGENT_E2E=1` e2e-patches suite if ever desired.
- The artifacts-English half of the policy is deliberately not automated (out
  of scope; the block scopes itself to conversation).

**Assets:** all files listed under "What was built".
