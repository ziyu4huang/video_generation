# 06 — patches boilerplate

Phase B · risk MED · gate: package gates + patch-outcome + opt-off invariant · depends: 02

## Scope

- Adopt patches/index.ts `envFlag` for the ×11 copy-pasted debug checks (`BUN_PI_DEBUG_PATCHES === "1" || === "true" || PI_DEBUG_MODELS …`). NOTE semantic widening: envFlag also accepts "yes" — flag in PR. Alternative if widening is rejected: a local `isPatchDebug(env)` in patches/index.ts (scan-excluded; index.ts is not scanned as a patch module) exported to the 11 sites.
- Shared `patchApplied = enabled ? outcome : true` helper in patches/index.ts (kills ×5 copies + their 4-line explainer comments).
- footer-extension-status-notify patch ("REDUNDANT BUT RETAINED", patches/index.ts:126-137): receipts/docs check; remove if nothing depends on it, else keep with a one-line justification. Removal = PATCH_TABLE edit + patch-outcome scan naturally shrinks + registry untouched.
- patches/index.ts:262 double `break;` — already removed in 01 if landed first; verify.

## Done-when

Package gates green; patch-outcome.test.ts + index.test.ts opt-off-not-opt-in invariant green; grep shows one debug-flag check; footer decision recorded here with evidence.

## Outcome (2026-08-25)

- **Debug-flag dedup — DONE, no widening.** New `isPatchDebug(env)` +
  `isPatchOrModelsDebug(env)` (single `isOneOrTrue` definition) in
  patches/index.ts; exact legacy semantics per site ("1"/"true" only,
  case-sensitive). Home = index.ts: the index→patch edge is DYNAMIC (static
  string literals inside applyPatches), so a patch STATIC-importing index is
  not a static-graph cycle — precedent: force-response-language.ts already
  imported `envFlag` from ./index.ts pre-change. index.ts:applyPatches' own
  `envFlag("BUN_PI_DEBUG_PATCHES", false)` was rewired to `isPatchDebug()` —
  the one deliberate narrowing: `BUN_PI_DEBUG_PATCHES=yes` no longer enables
  the patch-table dump (undocumented, never used by any other site).
  Census: 11 sites — 8 BUN-only (skip-update-check, ext-api, ext-context,
  autocomplete, force-response-language, editor-history-restore,
  startup-history-hint, footer→removed) → `isPatchDebug()`; 3 both-env
  (default-model-env, subagent-model-floor, ensure-model-tiers) →
  `isPatchOrModelsDebug()`.
- **patchApplied boilerplate — DONE.** `gatedPatchOutcome(enabled, outcome)` in
  index.ts; census found 4 sites (ticket said 5): ext-api, ext-context,
  autocomplete + footer (removed). 4-line explainers collapsed to the canonical
  comment at the helper.
- **footer-extension-status-notify — REMOVED.** Evidence: pinned SDK 0.84.2
  dist (node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/
  interactive-mode.js:1614-1617) — `InteractiveMode.setExtensionStatus` itself
  calls `this.ui.requestRender()` after delegating, and the extension-facing
  `ui.setStatus` binds straight to it (:1877), so every live setStatus caller
  (ultracode ×20+, movie-director, task, wayfind, power-tool, webui) already
  gets live render from the SDK. The patch's subscriber API
  (`onExtensionStatusChange`) had ZERO repo consumers outside its own test.
  power-tool docs/extension-ui-conventions.md updated (it already documented
  the patch as redundant). Stale comment references in
  autocomplete-source-extension.test.ts + prompt-history.ts fixed.
- **Double break — verified gone** (t01).
- Bonus (t05 reviewer nit): check-deps.ts header comment now says deps-probe.ts
  (3 mentions, comment-only).
- Gates: `typecheck` clean; `test` = 1060 pass / 0 fail (patches/ targeted:
  182 pass / 0 fail). Grep receipt: zero literal
  `BUN_PI_DEBUG_PATCHES === "1"` copies outside the single `isOneOrTrue`.
