> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-07-23-self-reflection-to-improve-these-related-pi-agen

## Destination

Vault writes from `pi-agent-ext-research-tool` never silently land in the wrong place: vault resolution either **succeeds** (hitting the same active vault the obsidian tools see), **errors loudly** with an actionable message, or is **explicitly overridden** via `output_path`/`outputPath`. No silent `<cwd>` fallback. Scope: the silent-cwd-fallback footgun AND its root cause (why resolution misses the configured vault).

## Notes

- **Domain**: `pi-agent-ext-research-tool` vault resolution (`lib/vault.ts`) vs the canonical resolver in `pi-agent-ext-obsidian/src/obsidian-lib.ts`. The two have **drifted**.
- **Skills every session should consult**: `grilling` + `domain-modeling` for [03 — fix approach](tickets/03-fix-approach-drifted-resolver.md) (a scope/refactor trade-off). `librarian` if provenance on obsidian-lib's export-API stability is needed.
- **Standing preference** (grilled 2026-07-23): this effort is **reliability**-focused. Convention-discipline work (`_Source:` propagation, liveness automation, Shared-State guard) is a *separate* effort — see Out of scope.
- **Fact freshness**: charted on `scratch/post-754` @ `5fda11e6` = `origin/main` (current as of charting).

## Decisions so far

- [root cause: research-tool's resolver is a drifted copy missing the ~/.pi tier](tickets/01-root-cause-obsidian-config-tier-drift.md) — research-tool vendored obsidian-lib's resolver "decoupled"; it omits the `~/.pi/obsidian_config.json` personal tier and replaces obsidian-lib's `mode="app"` tier with a silent cwd fallback. Missing the personal tier is exactly why a user-global vault config goes unseen.
- [cwd-fallback caller audit: nothing relies on it](tickets/02-cwd-fallback-caller-audit.md) — all 4 call sites (collect_videos, organize_vault_notes, import_memory_to_vault, arxiv_fetch2md) expect a real vault; the cwd fallback is pure silent degradation, safe to remove.
- [fix approach: re-align in place + drift-detector test](tickets/03-fix-approach-drifted-resolver.md) — keep research-tool's resolver self-contained (extension independence preserved) but re-align tiers (add `~/.pi` personal, cwd→loud error) + add a dev-only contract test asserting parity with obsidian-lib's `resolveVault`. Broader DRY stays out of scope.

## Not yet specified

- Whether other per-package copies of vault resolution exist elsewhere ([01] only inspected research-tool + obsidian-lib; the broad audit was scoped out but the drift pattern may recur — suspected, not confirmed).

_(Two patches of fog graduated and cleared by [03]: obsidian-lib's resolver IS exported/importable — `resolveVault(cwd)` at `obsidian-lib.ts:356`; and the test strategy IS decided — a dev-only parity contract test. Both now live only in [03]'s resolution.)_

## Out of scope

- **Convention-discipline work** — `_Source:` propagation across packages, automating the liveness check into a hook/CI, adding a liveness guard to the Shared State Index, documenting stealth-trim. That was Q1 option B; this effort chose reliability. Separate effort.
- **Broad audit of all `obsidian_config` consumers** (knowledge-card, pi-agent-cli commands) for the same footgun — Q2 option D, not chosen. Flagged in Not-yet-specified as suspected-recurring.
- **Full cross-package DRY/unification** — [03] resolved "fix in place + drift test", so broader DRY (depend on obsidian-lib / extract a shared resolver) is confirmed OUT of scope. The one known drift site is fixed with a recurrence guard. If "other per-package copies" (Not-yet-specified) later proves real and recurrent, that graduates as a **fresh** DRY effort, not a resumption of this one.
