# SDD ledger — plan: .planning/2026-08-14-build-hitl-webui/plan.md

## Phase 1 — appexec return transport
- Task 1: complete (commits 33bae1c6, review APPROVED — 1 minor ledgered → fixed in T2)
- Task 2: complete (commits 32deb614, review APPROVED — 3 minors ledgered to Phase 2)
- Final whole-branch review: APPROVED, no fix dispatch (7279fec6..32deb614, 237/0 tests, build exit 0)

## Ledger (minor findings → Phase 2 plan must carry)
- [T2-review] Tighten `HitlResponse` (union `{action,tweak?} | {cancelled:true}`) when webui_present lands.
- [T2-review] One-pending-at-a-time guard lives in webui_present (Component 2) — plan the guard TEST explicitly; also fix silent duplicate-id overwrite in registerPending if touched.
- [T2-review] WS-close cancels all pending — note reconnect/refresh tension for the present-handler phase (Decision A/C contemplate re-fetch of a pending presentation).
- [final-review] Refresh stale parseCommand class-header JSDoc (web-transport.ts:47-49, old no-op seam wording) in Phase 2's first commit.
- [task-2-impl] HitlResponse.action made optional (deviation from plan verbatim: TS2741 with {cancelled:true}); Phase 2 branches on `cancelled` before reading `action`.

## Phase 2 — webui_present tool + webui:present event
- Task 1: complete (commit 81f6ca3c, review APPROVED — 2 minors: unvalidated `view` in isPayload (tool path unaffected), weak microtask-drain liveness assert)
- Task 2: complete (commit 5d974e25, review APPROVED — 2 minors: pre-aborted-signal hardening, describeHitlResponse tweak-before-approve precedence)
- Final whole-branch review: APPROVED, no fix dispatch (e7ecf680..5d974e25, 271/0 tests, build exit 0)

## Ledger (minor findings → Phase 3+ must carry)
- [T1-review] isPayload doesn't type-guard `view` (non-string view would forward as a raw key) — harden when convenient; tool path always supplies schema-validated strings.
- [T2-review] awaitPendingWithAbort: add `if (signal.aborted) onCancel()` early-exit hardening (unreachable via pi harness today).
- [T2-review] describeHitlResponse: tweak branch precedes approve branch — {action:"approve",tweak} renders as "requested approve with tweak" (intentional; revisit when the browser toolbar lands).
- [final-review] present-tool.ts `params.mode as RenderMode` cast mirrors render-tool.ts convention — simplify opportunistically.
- [final-review] T1 file-count note: plan File Structure = 11 unique files for Phase 2 (6 src + 5 test).

## Phase 3 — browser declarative-controls toolbar
- Task 1 (single-task phase): complete (commit 820a84b6, review APPROVED incl. P0 scope ground-truth — 273/0 tests, typecheck+build clean; task review covered the whole branch, single commit)
- LEDGER L23 (describeHitlResponse tweak-before-approve precedence): CLOSED intentional — the toolbar only produces {action:"approve", tweak} if the agent declares takesInput on an approve control; "requested approve with tweak" is correct phrasing.

## Ledger (minor findings → Phase 4+)
- [P3-review] respondedPresent never clears across presentations — harmless (fresh presentIds; done-check id-keyed, intended one-response semantics). No action.
- [P3-impl] Plan 3f block contained backticks in an inline comment (would break the template literal); fixed comment-only to single quotes — plan-defect, noted for plan-author hygiene.

## Phase 4 — /output serving + image presentation
- Task 1: complete (commit c71d2582, review APPROVED — containment adversarially probed sound; minors: malformed-%/null-byte 500s [FIXED in T2B], symlink-follow informational, no fixture cleanup, /output/.. fall-through)
- Task 2 + hardening: complete (commits fea0ce4a + ed96f06c, review APPROVED byte-identical-to-plan; uniform-404 hardening landed)
- Final whole-branch review: APPROVED, no fix dispatch (ef9a33f9..ed96f06c, 312/0 tests, build exit 0; end-to-end image flow verified hop-by-hop incl. marked emitting <img src> verbatim)

## Ledger (minor findings → Phase 5+ / backlog)
- [P4-final] imageMd does not percent-encode rel — filenames with spaces/parens render as literal text (marked rejects unescaped spaces). Latent (MLX names are space-free); fix = encodeURI on rel or a note in present-tool guidance.
- [P4-final] rmSync imported-but-unused in tests/output-routes.test.ts (plan-verbatim; harmless).
- [P4-final] Symlinks inside the output dir are followed (matches gallery.ts reference; outside loopback threat model).
- [P4-impl] Plan defects found: beforeAll+describe-scoped consts incompatible with bun:test eager describe bodies (T1 D1); backtick-in-template-literal class defect NOT repeated here.

## Phase 5 — drop the mirror + ledger hardening (FINAL)
- Task 1: complete (commit 0c715949, review APPROVED — 7 files deleted, −794 lines, 286/0; negative tests pin the removal). Minors: one over-subtracted adjacent comment line (mutex-gate comment); plan's final-verification grep was self-inconsistent (review interpretation correct).
- Tasks 2+3: complete (commits 9eff893e + 3fdec250, review APPROVED — encodeURI round-trip empirically verified through the real route; 290/0).
- Final whole-branch review: APPROVED (3295745e..3fdec250, 290/0, build exit 0). Effort-level verdict: ALL spec Components 1-6 + Decisions A/B/C demonstrably true in code. Effort COMPLETE after this merge.

## Ledger closures
- [P4-final] imageMd percent-encode — CLOSED (9eff893e).
- [P4-final] rmSync unused import — CLOSED (3fdec250).
- [Phase-2 T1-review] isPayload view type-guard — CLOSED (3fdec250).
- [P4-final] symlinks-followed in /output — stays backlog (matches reference behavior; outside loopback threat model).
- [known stale] pi-agent-ext-devops/scripts/deploy.ts:572 cites deleted src/tool-mirror.ts in a comment — different package, intentionally untouched.

## Residual backlog (post-effort)
- isPayload fully-typed PresentEventPayload on the wire; awaitPendingWithAbort early-abort check; present-tool mode cast; /output ETag/Range; WS-close reconnect resume (present view survives, gate does not).
