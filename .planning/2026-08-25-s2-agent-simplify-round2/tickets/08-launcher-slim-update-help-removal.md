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

- [x] grep proof recorded in-ticket: `update-help` refs outside `.planning/` = exactly ONE intentional self-reference (run.sh:60's passthrough comment pointing `--help` at where the old flag's guidance lives) — criterion AMENDED from Scope's "zero": the pointer note is deliberate, recorded here and in the Outcome
- [x] `bash -n run.sh` clean; `PI_AGENT_E2E=1 bun test src/__tests__/e2e-launcher.test.ts` **12/12** (mandatory — run.sh is DEPLOY_SENSITIVE; was 13/13, the --update-help describe deleted WITH the flag)
- [x] manual: `./s2-agent.sh --list-models` exit 0; `PIAGENT_DEBUG=1 ./s2-agent.sh -p …` prints mode/entry and completes a real one-shot; `--upgrade` passthrough covered by the e2e fixture (live `--check` needs network — skipped on this box)
- [x] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green (976 pass / 3 pre-existing cli-sh fails); reviewer pass
- [ ] local_ci green on a macOS box / PR merged — Linux box: only the documented macOS-only `sandbox-exec` Deploy-sh L1 gate fails; merge via Linux-box policy

## Outcome (2026-08-25)

- run.sh **206 → 132 LOC** (target ~150-160 beaten — the user's ask was less code; extra compression confirmed intentional). Deleted: the `--update-help` block (:75-107) + header mention. Compressed (reviewer-corrected counts): header UPGRADING 22→10, entry-detection comment 9→2, check-deps comment 12→10, link-farm comment 23→12 — **KEEPING the regular-file reclaim-safety invariant verbatim in substance** (zero regular files ⇒ provably a farm; ANY real content ⇒ leave it alone — deleting a user's real tree is far worse than leaving the farm).
- Logic byte-verbatim EXCEPT one undisclosed-at-first delta the reviewer's comment-stripped diff caught: the dead pre-init `ENTRY=""`/`MODE=""` (old :118-119, multi-arm-era leftovers) was also deleted. Behaviorally inert — under `set -u`, both variables are assigned on the sole continuing path before their first read and the else branch exits 1, so nounset can never trip (e2e 12/12 + live launch confirm). Kept deleted (dead code); recorded here. Equivalence-proof method adopted for future launcher work: the comment-stripped diff (`grep -vE '^\s*#' old | diff - new`) IS the receipt. Everything else verbatim: pi-agent.sh deprecation case, symlink-resolution loop, bun PATH check, `--upgrade`/`-U` passthrough, entry detection, `PIAGENT_DEBUG` echo, check-deps invocation, reclaim+symlink block, `exec bun`.
- Paired deletions: `e2e-launcher.test.ts` `describe("--update-help")` + header list entry; `run-test.ts:15` tier doc parenthetical.
- **Behavior delta (flagged per D9/user approval)**: `--update-help` now falls through to pi's unknown-flag error; replacement path `./s2-agent.sh --upgrade --help` reaches the wrapper's full docs (its header prints on `--help`).
- Version 0.7.16 → 0.7.17.
