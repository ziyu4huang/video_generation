# Ticket 01 — Test-hermeticity guard

**Status:** ADOPT (2026-07-30). Hands off to a build session.

## Decision

Adopt a static source-analysis guard for the **non-hermetic real-config / real-env
read** failure class — the axis that sank the watchdog tests (#937, CI red on
`loadModelTierConfig()` reading the real `~/.pi/workflows/model-tiers.json`) and
the hermes/archify test-stability cluster on `main`. This is the natural successor
to the config-parity guard (#928) and closes a gap in the existing test-portability
audit.

## Mechanism — extend `scripts/test-portability-audit.sh` (a new P5 class)

Add a fifth pattern class to the existing audit (same family as P1-P4; same
`scan_pattern` machinery; same `GUARD_RE` exemption model). **Not** a new
standalone guard — the failure is pattern-based (grep-able), and the audit's
file-level guard-signal model already fits.

### P5 patterns — CALL-based (avoid string-literal false positives)

```
P5_RE='loadModelTierConfig\s*\(|getModelTierConfigPath\s*\(|os\.homedir\s*\(|\bloadConfig\s*\('
```

Key refinement vs. a naive grep: **match calls (with parens), not string
literals**. `assert.equal(c.USER_WORKFLOW_SAVED_DIR, "~/.pi/workflows/saved")`
(workflow `utils.test.ts:144`) is a constant-equality assertion, NOT a read → must
NOT match. `loadModelTierConfig(join(tmpdir(), ...))` (subagent
`model-tier-config.test.ts:81`) IS a call but the arg is an injected tmpdir →
handled by the guard-signal exemption (below), not by weakening the pattern.

> `loadConfig\s*\(` is broad and will match `pi-agent-ext-hermes-memory`'s
> `loadConfig` (the config loader) — that's intended (it's the same failure
> class). The guard file itself (`tests/config-parity.test.ts`) reads SOURCE via
> `readFileSync`, does not call `loadModelTierConfig(`/`loadConfig(`/`os.homedir(`
> — it will not self-match; if it does, exclude the guard file explicitly
> (`--exclude=config-parity.test.ts` in `GREP_FILTERS`).

### Guard signals — reuse `GUARD_RE` + add hermeticity signals

The existing `GUARD_RE` (process.env.CI, `.skipIf(`, PI_* opt-ins,
`__setVaultResolverForTest`, `testWithoutEnv`, `process.execPath`) carries over
unchanged. **Add** hermeticity-specific signals so injected-path / mocked-config
tests are recognized as GUARDED:

```
GUARD_RE='…existing…|mkdtempSync|tmpdir\(|process\.env\.HOME|loadConfig\s*:|mockCfg|mockConfig|cfgPath'
```

- `loadConfig\s*:` — the param-injection seam (the watchdog `model-review.ts`
  `loadConfig?: () => ModelTierConfig` pattern; tests pass an inline `mockCfg`).
- `mkdtempSync|tmpdir(|process\.env\.HOME` — path mocking (workflow tests set
  HOME to a tmpdir).
- `cfgPath` — the injected-path idiom (`loadModelTierConfig(cfgPath)` where
  `cfgPath` is a tmpdir).

### Blocks under `--strict`

Like P1/P2, a P5 UNGATED hit blocks under `--strict` (added to `block_files`).
P3/P4 remain review-only.

## Enforcement — strict from start

Ship P5 under `--strict` immediately; fix the real violations **in the same PR**
(config-parity #928 precedent). The post-refine violation surface is tiny (see
triage below), so warn-only v1 is not warranted.

## Triage — real violations to fix in the PR (build-session confirms)

Researched on `origin/main @ 0a4a93ec`:

| File | P5 hit? | Real violation? | Action |
| --- | --- | --- | --- |
| `pi-agent-ext-workflow/tests/utils.test.ts` | no (string literal `"~/.pi/..."`) | NO (false positive of naive grep) | none — call-based P5 won't match |
| `pi-agent-ext-subagent/tests/model-tier-config.test.ts` | yes (`loadModelTierConfig(`) | NO (injects tmpdir `cfgPath`) | GUARDED via `cfgPath`/`tmpdir` signal |
| `pi-agent-ext-subagent/tests/model-role-config.test.ts` | yes (`loadModelTierConfig(`) | **VERIFY** — likely uses the real loader ungated | fix (inject cfg) OR confirm guarded |
| `pi-agent-ext-workflow/tests/workflow-pack-id.test.ts` | yes (`os.homedir(`) | **YES (UNGATED)** | fix (inject HOME / tmpdir) |
| `tests/config-parity.test.ts` | no (reads source) | NO (guard itself) | exclude if it self-matches |

Build-session steps: run the new P5 --strict, fix each UNGATED hit (inject a seam
or add an env guard), prove disable→fail→restore→pass.

## CI wiring

No new wiring — `scripts/test-portability-audit.sh --strict` already runs in the
`regression gates` job (`.github/workflows/ci.yml`). Adding P5 makes it stricter
automatically.

## Out of scope

- String-literal `~/.pi/...` / `.pi/...` matches (P5 is call-based; matching
  path strings produces too many false positives — constant assertions, fixture
  paths).
- A structural/AST guard (the pattern-based audit is sufficient; a structural
  guard is over-engineering for this failure class).
- Extending to `pi-agent-cli` e2e tests that legitimately need real `~/.pi`
  (they're already gated by `process.env.CI`/opt-in env vars → GUARDED).

## Verification (build session)

1. Add P5_RE + guard signals; run `bash scripts/test-portability-audit.sh --strict`
   → must block on the real UNGATED hits.
2. Fix each (inject seam / env guard) → `--strict` exit 0.
3. Disable P5 → the fixed files would pass without the guard (regression-proof).
4. Full regression-gates CI green.
