# 06 — patches boilerplate

Phase B · risk MED · gate: package gates + patch-outcome + opt-off invariant · depends: 02

## Scope

- Adopt patches/index.ts `envFlag` for the ×11 copy-pasted debug checks (`BUN_PI_DEBUG_PATCHES === "1" || === "true" || PI_DEBUG_MODELS …`). NOTE semantic widening: envFlag also accepts "yes" — flag in PR. Alternative if widening is rejected: a local `isPatchDebug(env)` in patches/index.ts (scan-excluded; index.ts is not scanned as a patch module) exported to the 11 sites.
- Shared `patchApplied = enabled ? outcome : true` helper in patches/index.ts (kills ×5 copies + their 4-line explainer comments).
- footer-extension-status-notify patch ("REDUNDANT BUT RETAINED", patches/index.ts:126-137): receipts/docs check; remove if nothing depends on it, else keep with a one-line justification. Removal = PATCH_TABLE edit + patch-outcome scan naturally shrinks + registry untouched.
- patches/index.ts:262 double `break;` — already removed in 01 if landed first; verify.

## Done-when

Package gates green; patch-outcome.test.ts + index.test.ts opt-off-not-opt-in invariant green; grep shows one debug-flag check; footer decision recorded here with evidence.
