Arc-26 planning is complete and audited. Final report:

## Deliverable

- **`.planning/2026-09-15-self-arc-26-project-trust-wiring/map.md`** — canonical
  wayfinder map (house shape, frontmatter `status: active` matching ledger row
  26): Destination · measured Context (every anchor artifact-verified, two in a
  second-pass audit) · Scope IN/OUT with rejection reasons · tickets t01–t03
  with file surfaces, tests, verification clauses, and the pre-registered
  deployed-receipt matrix · Decisions D1–D9 · Frontier · Fog of war · successor
  sketch · cross-effort links (Builds-on arc-25).
- **`.planning/2026-09-15-self-arc-26-project-trust-wiring/plan.md`** — this
  adjudication cover (arc-25 precedent: map.md is canonical, plan.md is the
  planner's summary). The dispatch's literal `plan.md` deliverable moved to
  `map.md` because the tooling requires that name (see audit A1).

## Ticket set

| Ticket | Content | Exit shape |
|---|---|---|
| t01 (build) | `createAgentTrustSurface({ctx, cwd, agentDir?})` in `agent-trust.ts`; both tools default `options.agentTrust ?? createAgentTrustSurface(...)` anchored at the registry-load cwd (singular `runCwd`, batch `defaultCwd`); confirm-text names the durable fix | 9 new pin tests + 10 legacy policy tests green; schema-cost delta = 0 recorded |
| t02 (verify) | fresh pinned deploy (`--no-freeze --force`), pre-drive greps ext.cjs AND core s2-agent.js, then N1 evil-deny + P1 trusted positive control + P2 ancestor-walk (TUI T1 stretch optional), every leg a fresh process, GLM-5.3 only | receipts committed under `evidence/deployed-verification/`, paired with arc-25's `scenario-c2.log` as the PRE-fix side |
| t03 (close) | push-all → reviewer pass → status flip + Shipped-as same PR (effort-audit exit 0) → ledger mergedPr + arc-25 back-link → strict-v2 successor + LATEST repoint + doctor | terminal-with-provenance |

## Audit verdicts (second pass, 2026-09-15 — planner re-verified every load-bearing claim)

- **A1 (blocker, fixed):** the map first lived as `plan.md`; the arc-ledger
  guard (`arc-ledger.ts:168-170` "every effort needs a map") + `effort-audit.ts:296-299`
  (`no map.md`) require `map.md` BY NAME — the ledger test was measured RED
  (1 fail / 13) on the plan.md-only tree, green after the rename.
- **A2 (citation defect, fixed):** ext-externalization was cited to
  `deploy-run.ts:41` (that is the `#pi/ext-dir` idiom). Real chain, now in the
  map: `host-modules.ts:53-65` (`HOST_MODULE_IDS` = the `--external` set) →
  `ext-build.ts:617-626`; measured `require("@earendil-works/pi-coding-agent")`
  ×5 in live `0.10.3+g11e90db/ext/subagent/ext.cjs`, no per-ext node_modules.
- **A3 (gap closed):** the deployed ext's require is served from the CORE's
  registry (`hostRequire` never touches the filesystem) — so t02's PB-09 greps
  now ALSO cover core `s2-agent.js` (`ProjectTrustStore` ×1 baseline measured),
  the exact stale-core crash shape of operating learning #1.
- **Verified sound (no change):** pi trust-manager semantics read line-by-line
  (`get` → `getEntry?.decision ?? null`; ancestor walk; **null-valued entries
  skipped**; corrupt JSON throws; mkdir+lockfile side-effect on read;
  ELOCKED 10×20ms); `getAgentDir()` env `PI_CODING_AGENT_DIR`; package-ROOT
  exports `getAgentDir` (index.d.ts:2) and `ProjectTrustStore` (:25) — t01's
  import shape is build-valid; both gate call sites + injectable options;
  10 policy tests; ledger row 26 (28 entries, path+branch match); queue-head
  next-goal `20260914-234500`; arc-25 evidence logs present; evil fixture still
  planted at `/tmp/arc25-evil/repo/.pi/agents/evil.md` (re-plant caveat stands);
  `hard-problem.md` project def + trusted-store positive-control root both live.

## PB citations (task label: loop-playbook-cite-the-pb-nn-ids-you-app)

PB-01 (sync attempted first — aborted `dirty_tree` on the SIBLING main
worktree's `vaults_root/s2-agent-vault` gitlink; branch reconciled to tip via
the sanctioned `prepare_feature_branch` rebase; abort surfaced, not forced),
PB-02 (ledger claim verified pre-existing), PB-09 (byte-verify greps measured
against the live pin, not assumed), PB-17/PB-18 (planning + evidence committed
on the branch), PB-20 (the A1 fix is the encoded-check-wins move: the ledger
TEST named the artifact, so the artifact moved, not the test).
