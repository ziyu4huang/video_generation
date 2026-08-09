---
effort: 2026-07-30-let-s-use-wayfind-superpower-ext-angle-to-review
created: 2026-07-30
last: 2026-08-09
status: complete
---

# Map — review+improve pi-agent-ext-tool-gate (wayfind+superpowers angle)

## Destination

`pi-agent-ext-tool-gate` brought to the same maturity bar as the wayfind/superpowers
extensions AND verified to coexist cleanly with the process pipeline: domain docs
(CONTEXT.md), ADRs for the gating decisions, `bun run qa` enforced in CI, the
README savings claim corrected, the process-pipeline interaction (gated
`subagent`/`workflow` vs SDD) understood + resolved, and the prior QA's 5 known
gate-content gaps closed. **Incremental only** — the gating mechanism (keyword +
noun∧verb co-occurrence matching) is NOT redesigned.

## Notes

**Domain.** `pi-agent-ext-tool-gate` gates heavy domain tools (flux2, ltx, krea2,
file2md/vision, inspect, workflow/subagent, research/collect, arxiv, movie,
zai-mcp, pi-deploy) behind keyword + noun∧verb `requires` co-occurrence matching,
keeping ~16 CORE_TOOLS always active. Saves ~5.5k tok/req (38.6%, per prior QA
`bun run qa`; the README/file-header claim of ~8.5k is overstated). Mechanism
lives in `extensions/tool-gate.ts` (`updateSticky` / `gateFires` / `matchIntent` +
`enable_tool` escape hatch + `TOOL_GATE_LOG` telemetry + `setWidget` banner).
Already standardized on peerDependencies; good test coverage (8 files).

**Prior verdict.** `.planning/2026-07-23-try-to-add-gate-to-verify-tool-gate-extension-qa/`
→ **NET POSITIVE, keep tool-gate.** It handed off 5 gate-content fixes (this map's
[Close known gate-content gaps](tickets/03-close-known-gate-content-gaps.md)) and
ruled mechanism redesign out of scope — this map reaffirms that boundary.

**Skills every session should consult.** `grilling` + `domain-modeling` (decision
tickets); `writing-plans` (when a ticket becomes plan-writable); the prior QA map
(above) for the encoded verdict + thresholds.

**Standing preferences.** Incremental only — no mechanism redesign (grilling
decision). Tests hermetic per repo convention (`bun:test`, env-snapshot/restore).
One canonical extension entry (`extensions/tool-gate.ts`) — never add a second.

## Decisions so far

- [00 Process-pipeline interaction reality](tickets/00-process-pipeline-interaction-reality.md) — **empirical friction ZERO** (workflow gate fired 4× / escape-hatched 0× in 201 turns; `miss_candidate` over-counts); latent fragility (skills assume `subagent` present) self-heals via always-present self-describing `enable_tool`; un-gate affordable (1,924 tok → savings 46%→35%). Side-finding: real savings now ~7.7k/46% (cite `qa:savings`).
- [01 Resolve process-tool gating](tickets/01-resolve-process-tool-gating.md) — **DEFER (no action)**: friction zero + `enable_tool` self-heals; re-open only if telemetry shows workflow-gate escape-hatch usage.
- [02 Wire `bun run qa` into CI](tickets/02-wire-bun-run-qa-into-ci.md) — **DONE**: added tool-gate to the `tests` matrix (was missing entirely) with `bun test && bun run qa`; fixed a `TOOL_GATE_LOG_PATH` test-hermeticity flake (PR #938 pattern).
- [03 Close known gate-content gaps](tickets/03-close-known-gate-content-gaps.md) — **RESOLVED-WITHOUT-WORK**: `bun run qa --strict` already green (0 task-breaking gates; the 4 blind gates were fixed since the prior QA); false-fires accepted (never gate).
- [04 Author tool-gate ADRs](tickets/04-author-tool-gate-adrs.md) — **DONE**: `docs/adr/0001-0005` (escape-hatch, keyword-precision, requires co-occurrence, opt-in telemetry, phantom cost-gate removal).
- [05 CONTEXT.md + README claim](tickets/05-context-md-and-readme-claim-correction.md) — **DONE**: `CONTEXT.md` written; claim refreshed to current (~7,940/47.7%) — false premise corrected (claim was ~right; prior QA's 5.5k was stale).

## Not yet specified

- **Code-review of `tool-gate.ts` complexity** — the banner-timer lifecycle (M6
  pending timers across `session_start`), sticky-set mutation across turns, the
  telemetry emit paths. Graduate only if the interaction or gate-fix tickets
  surface a correctness concern; the 8 existing tests otherwise cover it.
- **Live L2 measurement** — the prior QA armed `bun run qa --l2 --model X` but
  never ran it (no model in this env). Graduates if the interaction ticket's
  miss-rate research needs live signal beyond the deterministic tier.
- **Generalize the QA harness** into a publishable framework for any gated
  extension — graduates only if the CI-integration ticket reveals real
  cross-extension reuse value.

## Out of scope

- **Re-architecting the gating mechanism** (keyword/co-occurrence → semantic /
  embedding intent, or a declarative gate DSL). Confirmed out by grilling
  (incremental only). Reopens only as a fresh effort if a ticket proves the
  mechanism itself — not its gate content — is the blocker.
- **power-tool `schema-cost` cleanup** (the 4-vs-3.7 token-ratio inconsistency) —
  prior-effort deferred, separate concern; referenced but not fixed here.
