# 08 — launcher slim: run.sh comment/doc dedup + `--update-help` removal

Source: map Phase D extension (user-confirmed 2026-08-25 full sweep; `--update-help` drop explicitly user-approved). run.sh = repo-front-door `./s2-agent.sh` symlink target; DEPLOY_SENSITIVE pattern #1 — launcher e2e mandatory.

## Scope

- **Delete the `--update-help` block** (`run.sh:75-107`, ~33 LOC heredoc + gate) and the header mention at `:38`. Its content duplicates the header's UPGRADING block; `update-pi.sh -h` prints the same wrapper docs (its header `:2-48`) — upgrade procedure single-sources THERE. Behavior delta (flag in PR body): `--update-help` now falls through to pi's unknown-flag error; replacement path `--upgrade --help` reaches the wrapper docs.
- **Delete the paired test + fix comments**: `src/__tests__/e2e-launcher.test.ts` `describe("--update-help")` `:147-161` + header mention `:4`; `bun-apps/s2-agent-ext-devops/scripts/run-test.ts:15` parenthetical → "(symlink resolution, entry-mode detection, --upgrade passthrough)". Grep proof: repo-wide `update-help` references = zero outside `.planning/` after the change.
- **Compress header UPGRADING block** (`:26-47`, 22 → ~6 lines): keep — pi's own `pi update` disabled (workspace dep), `./run.sh --upgrade|-U` passthrough, wrapper owns pin-rewrite/lock/verify, NEVER `npm install`, symlink note; pointer to `update-pi.sh -h`.
- **Compress comments ONLY** (logic verbatim — the 5 reclaim/link-farm e2e tests pin it): check-deps block `:143-158` (~16→~9), link-farm block `:159-181` (~23→~13) KEEPING the regular-file reclaim-safety rationale (zero regular files ⇒ provably a link farm; any real content ⇒ leave alone — the dangerous invariant), history notes (#1740/Phase 1b) → 1–2 lines.
- **Keep verbatim**: pi-agent.sh deprecation case, symlink-resolution while-loop, bun PATH check, `--upgrade`/`-U` passthrough, entry detection, `PIAGENT_DEBUG` (rename policy keeps PI_* env names; e2e-pinned), check-deps invocation, reclaim+symlink logic, `exec bun`.
- LOC target: 206 → ~150-160.

## Acceptance criteria

- [ ] grep proof recorded in-ticket: zero `update-help` refs outside `.planning/`
- [ ] `bash -n run.sh` clean; `PI_AGENT_E2E=1 bun test src/__tests__/e2e-launcher.test.ts` green (mandatory — run.sh is DEPLOY_SENSITIVE)
- [ ] manual: `./s2-agent.sh --list-models` boots; `PIAGENT_DEBUG=1 ./s2-agent.sh -p hi` prints mode/entry; `--upgrade --check` path intact
- [ ] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; local_ci green; PR merged via Linux-box merge policy; reviewer pass; `--patch` bump
