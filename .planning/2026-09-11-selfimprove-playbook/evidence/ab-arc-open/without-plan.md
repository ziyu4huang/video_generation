# Plan: `2026-09-11-spwf-ab-gemma-fill`

## Verified current state (measured this session, not assumed)

| Check | Result |
|---|---|
| `output/LATEST-next-goal.md` | → `next-goal-20260910-224230.md`; item 1 = fill gemma column, receipts under `output/spwf-ab-closing/gemma-fill/`, blocker escalation allowed ("second dated note") |
| Closing arc | Merged as #2266 (`8596f802`); harness promoted to `wayfind/scripts/drive-case.ts` + `spwf-battery.sh` + `tests/drive-case-detector.test.ts`; allowlist lines 90–93 in devops `scripts-dir-contract.test.ts` |
| Deploy pin | `dist/s2-agent-sh/darwin-arm64/0.10.3+gc172fd3` exists; `grep -c "check the available skills list" ext/superpowers/ext.cjs` = **1** (battery's own trust check passes). `current` has moved to `g6423400` (sibling #2269) — pinned dir immune |
| Closing map in tree | t08 shows open + `PR <impl>` placeholder although #2266 is merged — **re-verify on origin/main at t01**; fold any missing `Completed-by`/ledger bits into this arc's close-out |
| Working tree | On sibling branch `selfimprove-playbook` (ahead 1/behind 1, dirty devops-skills + subagent files) — sync to main first; no file overlap with this arc |
| LM Studio | **The headline — see below** |

**Headline finding (Learning #2 applied — "the label is not the content"):** the D5 precondition as executed polls `/v1/models`. Measured just now: `/v1/models` returns **7 models** (the downloaded catalog: bonsai-27b, gemma-4-12b-qat, qwen3.8-27b, gemma-4-12b + 3 embedders), while `lms ps` shows **only `text-embedding-bge-m3` loaded (634 MB, IDLE)**. On this endpoint `/v1/models` is a *catalog*, not *residency* — an oracle that counts "4 large models" can **never** pass ≤1 on this machine, so the closing session's 3/3 fail and defer may have been an instrumentation artifact. The endpoint is likely quiet *right now*. The same over-counting oracle lives in `drive-case.ts`'s `contentionPrecheck` (informational-only today, but it pollutes receipts).

## Destination

The gemma column of the `2026-09-10-spwf-drive-ab` verdict matrix is filled with honest, triple-pinned behavioral verdicts (C2/C3/C5/C8 + C4 stretch; C1 gemma already = YES) run on the **same immutable pin `0.10.3+gc172fd3`** under the frozen neutral prompts — or, failing 2 quiet windows, a second dated defer with escalated blocker evidence. The quiet-window oracle is corrected to true residency (`lms ps`) so pass/defer measures sibling churn, not the download catalog. Matrix deltas + findings committed; receipts and load-bearing session JSONLs under the effort's `evidence/` dir; loop ritual closed per CONVENTIONS.

## Precondition check (amended D5 — record the amendment as a map decision with today's measurement)

1. Poll 3×, ≥60 s apart; each poll records raw `lms ps` output **and** `/v1/models` JSON under `evidence/polls/` (continuity with the closing protocol).
2. **QUIET ⟺** (a) ≤1 large chat model **loaded** (≥7 B, non-embedding, per `lms ps`) and that one is the pinned gemma or none (JIT loads it); (b) zero load/unload churn across the 3 polls (loaded-set stable, small-model TTL expiry ignored); (c) `google/gemma-4-12b` in catalog.
3. Max 2 windows (D5 unchanged); failure → second dated defer on the closing lineage + escalation ask (scheduled window, or permission to `lms unload` idle residents — never unilateral while a sibling is mid-use).
4. Keep drive-case's in-harness precheck aligned (same oracle fix) so receipts record a clean contention note.

## Tickets

- **t01 — open + baseline**: sync origin/main; verify closing-map final state there (complete t08 leftovers if real); re-grep the pin; wayfind gates (`check && typecheck && test`); collision check vs `selfimprove-playbook`.
- **t02 — oracle + detector (token-free, BEFORE legs)**: `spwf-quiet-window` poller (records both oracles, emits QUIET/CHURN verdict); fix `contentionPrecheck` to `lms ps`-first with `/v1/models` fallback; extend fixtures/tests. Optionally ride the already-queued detector refinements here (C3 order keyed to the *expected* skill's read, missing bash write-operators) — landing them first avoids re-adjudication; `--rescan` is the safety net either way.
- **t03 — window watch + gemma legs**: run when t02 says QUIET (see below).
- **t04 — matrix deltas + findings**: flip the drive-ab map's gemma cells from UNTESTED-infrastructure; deltas are findings, only RED triggers a fix; record the oracle-amendment + same-pin decisions.
- **t05 — close-out**: reviewer GLM-5.3, devops PR chain, status flip, successor next-goal (session_compact leg remains the next residual).

## Running the gemma legs

- **Column selection without touching frozen prompts**: add a one-line `S2_DRIVE_COLUMNS=gemma` filter to `spwf-battery.sh` (prompts byte-identical; a test asserts the gemma column commands match glm's modulo pin) — or, zero-edit fallback, invoke `drive-case.ts` per case with prompts sourced verbatim from the battery file. Never re-run the glm column (burns the ≤2-legs/cell budget discipline and risks zai stalls).
- **Per-leg shape** (from the battery, pin = `gc172fd3`, NOT `current` — A/B comparability with the glm column): `--leg deployed --dist $PIN --pin-provider lm-studio --pin-model google/gemma-4-12b --cap 300`, per-case expectations: C2 `--expect-read brainstorming`; C3 (none extra, detector does order); C4 stretch `--env PI_SUPERPOWERS_SKILL_EXCLUDE=!,brainstorming --extra-arg -ns --forbid-read brainstorming`; C5 `--expect-read-any using-s2-agent-skills,to-spec,to-tickets,ask-matt`; C8 `--expect-reply writing-plans`. Wipe `output/spwf-battery/scratch/` before the mutating cases (C2/C3/C4). Skip C1 (already YES).
- **Discipline** (frozen D-decisions): ≤2 legs/cell; SKIP receipts preserved, never deleted; pin-vs-recorded model mismatch voids the leg (watch gemma vs gemma-qat); never prompt-engineer a pass; 300 s manual-kill cap.
- **Evidence**: receipts land in `output/spwf-ab-closing/gemma-fill/` (per next-goal), then the load-bearing bytes (receipts ≤4 KB + sessions ≤30 KB) copy into `.planning/2026-09-11-spwf-ab-gemma-fill/evidence/gemma/` — resolving the next-goal's `output/` path in favor of the closing arc's D7/CONVENTIONS rule for verdict-carrying evidence.

**Fog of war:** LM Studio JIT semantics could change (record `lms ps` ground truth per poll); gemma `-p` latency unknown (cap + SKIP cover it); sibling branch in flight (rebase-only); whether the closing map's t08 truly closed on main (t01 verifies).