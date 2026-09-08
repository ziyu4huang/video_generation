---
effort: 2026-09-08-self-arc-13
created: 2026-09-08
last: 2026-09-08
status: done
---

# Wayfinder map: 2026-09-08-self-arc-13 — planner-led research-tool reliability arc

## Destination

Extend the self-evolve loop (self-arc-3..12 discipline) to a NEW family:
`bun-apps/s2-agent-ext-research-tool`. The user directive (2026-09-08): "I want to
USE s2-agent-ext-research-tool; improve it with the same self-develop arc the
previous PRs show." End state = one merged planner-led PR that makes the package
dependable in real use, with executable proofs: unit tests where coverage is
missing, the family's FIRST live receipts (source-tree leg + deployed-tree leg,
`output/self-arc13-*/receipt.json` with named required checks) for the operations
a user can actually run, and learnings hardened per `2026-09-06-learnings-hardening`.

## Context

Measured 2026-09-08 on this machine, pre-planner:

- **Tool surface**: 7 tools registered in `extensions/research-tool.ts`
  (collect_videos, organize_vault_notes, import_memory_to_vault, collect_news,
  arxiv_search, arxiv_paper, arxiv_fetch2md) + CLI twin
  `extensions/cli-subcommand.ts` (has an e2e test).
- **Test inventory**: 10 `__tests__` files, ~1.3k lines. GAP: `lib/youtube.ts`
  (182 lines, quota-aware YouTube Data API engine) has NO dedicated test file;
  `__tests__/bilibili-wbi.test.ts` covers WBI signing only (36 lines vs
  `lib/bilibili.ts` 269 lines).
- **History**: #2188 added `collect_news` + `collect-news-llm` skill; #2191
  hardened its date anchoring. No open gh issues mention the package.
- **Receipts**: NONE exist for any research-tool tool — this family has never
  been through a receipts leg (the subagent family's receipts live under
  `output/self-arc3..12-*`, scratch).
- **Environment**: `YOUTUBE_API_KEY` NOT set in this shell → no live YouTube leg;
  arXiv keyless (1 req/3s self-throttle); Bilibili off-China IPs hit 412
  risk-control → unit-level unless a proxy is available; `collect_news` scaffold,
  `organize_vault_notes`, `import_memory_to_vault` are local (temp-vault
  receiptable).
- **Planner machinery ready**: `.pi/agents/hard-problem.md` (bound `zai/glm-5.3`),
  `bun-apps/s2-agent-ext-subagent/scripts/arc-plan.ts` allowlisted
  (scripts-dir-contract.test.ts:78).

## Tickets

Planner: GLM-5.3 via `arc-plan.ts` (PASS, 320s, 372k tokens —
`output/arc-plan-self-arc13/plan-receipt.json`; plan promoted to
`plans/arc-plan.md`). Findings F1–F9 cited per ticket.

- [x] t01 `tickets/01-ship-family-deploy-verify.md` — T1 BLOCKER: root cause
      PINNED (not stale deploy, not crossos filtering: the registry entry
      carried ltx's copy-pasted machine-bound excludeReason since #1962 ⇒
      deploy-excluded from every target). Flipped to `deploy: { order: 170 }`;
      verified BY BYTES — receipt `output/self-arc13-deploy-verify-20260908/`
      PASS 11/11, re-run against the post-merge deployment `0.10.1+g9cef1fa`.
- [x] t02 `tickets/02-bilibili-outcome-surfacing.md` — T2: outcome objects +
      WBI cache (12h TTL, -403 invalidation) + no buvid3 fabrication;
      `__tests__/bilibili-engine.test.ts` 11 tests green.
- [x] t03 `tickets/03-youtube-chunking-tests.md` — T3: ≤50-id chunking +
      onNotice surfacing; `__tests__/youtube.test.ts` 9 tests green; chunking
      test PROVEN failing on pre-fix code (stash run).
- [x] t04 `tickets/04-arxiv-skill-live-receipts.md` — T4: `arxiv-research`
      skill + the family's first LIVE receipts: src
      `output/self-arc13-arxiv-src-20260908/` PASS 3/3, deployed
      `output/self-arc13-arxiv-deployed-20260908/` PASS 3/3 (real arXiv:
      "video diffusion" survey papers, 1706.03762 → "Attention Is All You
      Need", fetch2md 32,549 bytes into temp vault).
- [x] t05 `tickets/05-localvault-receipts.md` — T5: local-vault trio receipts:
      src `output/self-arc13-localvault-src-20260908/` PASS 5/5, deployed
      `output/self-arc13-localvault-deployed-20260908/` PASS 5/5 (scaffold +
      Saturday anchor 2026-09-12, overwrite guard, zettel tagging + orphan,
      import dry-run dedup, youtube missing-key hint).

**Execution order** (planner's, recorded per the confirm-gate; T1 was a
no-choice blocker — every deployed receipt leg imports bytes that did not exist
in the deployed tree):

```
t01 (deploy + byte-verify)  →  t02 ∥ t03 (hardening)  →  final redeploy +
re-run t01 byte checks  →  t04 ∥ t05 (receipts, both legs)  →  merge  →
post-merge redeploy + deployed receipt re-runs (arc-12 t05 rule)
```

## Decisions

- D1 (2026-09-08): this round is self-arc-13 — the loop's numbering continues
  across families (12 was CC-parity samples; 13 opens the research-tool family).
  Reason: the receipts discipline, planner-led open, and close-out ritual are the
  LOOP's properties, not the subagent package's.
- D2 (2026-09-08): planner-led open per the standing user directive (2026-09-07,
  arc-9): every hands-on loop opens with a GLM-5.3 planning subagent via
  `arc-plan.ts` (`hard-problem`, never flash), with an explicit read budget.
- D3 (2026-09-08): no new tui-drive scenario — research tools have no TUI
  surface; live legs are CLI/ext-standalone driven
  (`<outRoot>/<platform>/current/ext/ext-standalone.mjs` per repo CLAUDE.md).
- D4 (2026-09-08, planner): receipts execute tools DIRECTLY via the extension
  factory + stub ctx (`{ cwd }`, `OB_VAULT_PATH` → temp vault) — no LLM
  anywhere; the CLI twin spawns agent sessions by design and is deliberately
  not used. Bilibili/YouTube are unit-only legs (F7: no key, no proxy — a live
  bilibili leg would receipt Bilibili's WAF, not our code).
- D5 (2026-09-08, planner): schema-cost target +0 — production changes confined
  to `lib/bilibili.ts` outcome objects (lib-internal), `lib/youtube.ts`
  chunking (stable exports), and result text/details rendering; no tool names,
  params, JSON schemas, GATE_DEFS, or probe exports change. HELD: local CI's
  schema-cost probe exit 0 (info-only).
- D6 (2026-09-08, post-merge): registry `name` corrected to the SHORT form
  `research-tool` and the factory gained the `BUN_PI_RESEARCH_TOOL=0` self-gate
  — entering the PORTABLE BASE SET enrolls an extension in invariants excluded
  entries never meet (isolation contract derives dirs as `s2-agent-ext-${name}`;
  deploy stages `ext/${name}`; the symmetric disable knob is contract-tested).
  Local CI surfaced both; the independent reviewer's scope did not. Enrollment
  learnings, not new design.

## Findings

- **F1 root cause was neither of the planner's two hypotheses** — not a stale
  deploy and not crossos filtering: a copy-pasted `excludeReason` from ltx's
  adjacent entry. "Registered in source" stayed a label for the deployed leg
  for the family's entire history (learnings #2 corollary, now twice-confirmed).
- **Base-set enrollment is a hidden gate cascade**: short-name convention +
  `BUN_PI_*` disable knob + lockfile freshness after version-bump — all three
  bit within one local-CI run. The gates caught every one (that is the system
  working), but a promotion PR should budget for them explicitly.
- **Receipt drivers catch driver bugs too**: the first t05 run used snake_case
  params (`dry_run`/`hermes_dir`) where the tool schema is camelCase — the
  import then read the REAL `~/.pi/agent/pi-hermes-memory` and WROTE the jsonl
  (dry-run ignored). The receipt's own assertions caught it; no harm done, but
  a dry-run-ignored bug class is worth remembering when writing receipt drivers.
- **Planner economics held**: explicit read budget in the prompt → 320s, 372k
  tokens, plan delivered with verified citations (arc-9's lesson re-confirmed).
- **Root-level scratch scripts cannot import `@repo/*`** (no workspace links at
  repo root): dispatch/receipt scripts that need the spawn machinery must run
  via an in-package entry (arc-plan.ts) — my bespoke root dispatch.mjs failed
  on module resolution and was replaced by an arc-plan.ts call.

## Frontier

Queue drained; close-out (this docs PR + successor next-goal) is the last work.
Successor head: the next-goal file's Immediate steps (research-tool usage arc —
see Shipped-as + `output/next-goal-*.md`).

## Fog of war

- ~~Deployed-tree leg specifics~~ RESOLVED (planner F1 + t01): outRoot
  `~/proj/dist/s2-agent-sh/darwin-arm64/current/`; ext-standalone import
  pattern per `deploy-e2e-recipe.ts:1737`; deployed dir now `ext/research-tool/`
  (short name).
- ~~F1 root cause~~ PINNED: mislabeled excludeReason (see Findings).
- ~~arxiv2md.org availability~~ RESOLVED live: fetch2md delivered 32,549 bytes
  on both legs (src + deployed), 2026-09-08.
- Planner UNVERIFIED (F9) → DESCOPED: whether root `run-test.ts` /
  `run-video-collection.ts` still run (the latter was updated for the outcome
  API; the former untouched). Candidate for a future sweep.
- Live bilibili/YouTube legs remain impossible in this environment (no key, no
  proxy) — re-open when credentials exist.

## Cross-effort links

Builds-on: `2026-09-06-self-arc-9` (planner-led arc shape, planner economics
lesson: explicit read budget), `2026-09-06-self-arc-12` (receipts + Shipped-as
close-out ritual, source+deployed dual legs, post-merge redeploy rule),
`2026-09-06-learnings-hardening` (findings must harden into tests/log/agentType).
Shares-decision-with: `2026-09-06-self-arc-9` D-series on planner dispatch
(arc-plan.ts, hard-problem, zai/glm-5.3).
Reciprocal back-links added at close-out (this PR) on all three maps.

## Shipped-as

PR #2213 (merged 2026-09-08, squash `9cef1fa2`): registry flip + short name +
`BUN_PI_RESEARCH_TOOL` self-gate (`bun-apps/s2-agent/src/registry-config.ts`,
manifest regen); bilibili outcome objects + WBI cache (`lib/bilibili.ts`,
tool-layer rendering in `extensions/research-tool.ts`, `run-video-collection.ts`
caller); youtube 50-id stats chunking + `onNotice` (`lib/youtube.ts`);
`__tests__/bilibili-engine.test.ts` (11) + `__tests__/youtube.test.ts` (9,
chunking regression proven pre-fix-failing); `skills/arxiv-research/SKILL.md`;
s2-agent 0.10.0 → 0.10.1. Reviewer (hard-problem glm-5.3): APPROVE —
`output/reviewer-self-arc13/plan.md` (scratch); re-ran package suite 159/159 +
registry/manifest invariants 72 + deploy/config tests 26. Receipts (scratch,
cited as evidence): deploy-verify `output/self-arc13-deploy-verify-20260908/`
PASS 11/11; arxiv src/deployed PASS 3/3 each; localvault src/deployed PASS 5/5
each — deployed legs re-run against the post-merge deployment
`0.10.1+g9cef1fa` (arc-12 t05 rule held). Local CI overall PASS; schema-cost +0.
Back-link: self-arc-16 (verify arc: wayfind + superpowers) reused arc-13's receipts discipline end-to-end (source+deployed legs, receipt→fix→re-receipt, pre-fix evidence preserved) and generalized its stub-ctx driver shape to a no-tool family via the new standalone commands()/allowEmptySurface surface — see `.planning/2026-09-09-self-arc-16/map.md`.
