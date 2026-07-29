# 03 — Remnic belief-ledger / Relay supersession: deep-dive + portability

type: research
blocked by: —

## Question

How does **Remnic** model memory *correctness*, and what's the minimal port that
gives hermes versioned, provenance-backed, supersedeable beliefs?

Study the local clone at `/Users/huangziyu/proj/pi-ext-remnic-memory` — the
`belief-ledger` package, plus whatever implements the "Relay" correction loop
described in the README (evidence X-Ray, append-only supersession, correction
lineage, fresh-agent verification). Look also at `src/routing/` and the OpenAI
Build Week section of the README.

Map, concretely:

1. **Belief model** — what is a "belief" vs hermes's categorized memory entry
   (failure/correction/insight/preference/convention/tool-quirk)? Is it
   versioned? How is "the current truth" derived?
2. **Supersession** — how an old belief is marked stale, linked to its
   replacement, and preserved (append-only) rather than overwritten. Compare to
   hermes's immediate correction-detection + auto-consolidation.
3. **Evidence / provenance** — what "evidence X-Ray" captures (the recalled
   memory ↔ the failing signal), and how provenance is stored per belief.
4. **Fresh-agent verification** — how a brand-new agent proves it learned the
   correction. Is this a product/demo concern or a mechanism hermes could use?
5. **What's tied to cross-agent scope** (out for hermes) vs **mechanism-only**
   (portable).

Then the portability verdict (fed into ticket 07, not decided here):

- The minimal port that upgrades hermes's flat categorized memory + correction
  detection into **versioned, supersedeable, provenance-bearing beliefs** —
  without a platform rewrite and without leaving the MD+SQLite spine.

## Resolution

_Closed (research) — `remnic_research_fanout` workflow, 2026-07-29. Findings arm verdict ticket 07._

Remnic has **two distinct "belief" surfaces**; both treated below.

### 1. BELIEF MODEL

**(a) `@remnic/belief-ledger`** (`packages/belief-ledger/src/`): a `LedgerClaim` = `{ id, statement, kind: claim|prediction|opinion, stance: for|against|uncertain|neutral, confidence∈[0,1], scope, evidenceLinks[], status: active|superseded|resolved|snoozed|ignored, supersedes?, supersededBy?, parentIds[], resolution?{verdict,actualConfidence,brierScore} }`. Stored as a normal Remnic `fact` memory whose frontmatter carries `ledger.*` attributes + tags `belief-ledger`, `belief-ledger:status:<status>`. `LEDGER_SCHEMA_VERSION = "1"`. Host-neutral — depends only on `@remnic/core`, takes a `LedgerLlmAdapter` (no API key).

**(b) Relay mission contract** (`packages/remnic-core/src/relay/mission.ts`): a `belief_observed` event = `{ beliefId, decisionId, statement, confidence?, evidence[] }`. A **belief** = what one agent held at one moment; a **decision** = the shared truth-candidate. Both **versioned** and **append-only**.

**"Current truth" is derived, never stored as a flag.** In the ledger, the active claim is the one with `status==="active"` and no `supersededBy`. In the Relay reducer, `decision_superseded` flips `stale.supersededBy = replacementDecisionId`; current truth = the decision not marked superseded, reached by walking the chain.

**vs hermes:** hermes categories (`failure/correction/insight/preference/convention/tool-quirk`) are flat semantic labels — no version, no status, no supersession chain, no confidence, no stance. A hermes "correction" is just a category written on detection; the wrong belief it replaces is neither linked nor retired.

### 2. SUPERSESSION (append-only, not overwrite)

`RemnicLedgerStore.supersedeClaim(priorId, newId, reason)`: add `priorId` to `next.parentIds`, set `next.supersedes = priorId`; set `prior.status = "superseded"`, `prior.supersededBy = newId`; write a sealed **audit** "correction" memory with `lineage: [prior.id, next.id]`. The old memory **file is preserved** — `superseded` stays visible (only `forgotten|pending_review|quarantined|rejected` hide it). `split()` creates children with `parentIds=[prior]`, supersedes prior with the first child, **rolls back** on failure. Relay schema hard-constraints: a decision cannot supersede itself; `correction_approved` requires `approval` evidence; `decision_superseded` requires matching `correction` evidence.

**vs hermes:** hermes has **no supersession**. Immediate correction-detection writes a *new* flat correction; the prior wrong memory is untouched and **remains recallable**. Auto-consolidation **merges/drops** entries to fit the char limit — semantically lossy, the opposite of append-only lineage.

### 3. EVIDENCE / PROVENANCE

`RelayEvidenceRef` = `{ kind: memory|recall_audit|source|test|commit|correction|agent_output|approval, id, label, locator, capture: at_action|historical_lookup|fixture }`. Every event carries `evidence[]` (max 16). The schema **refuses** structurally incomplete events — recall needs `recall_audit`; approval needs `approval`; supersession needs `correction`. Provenance attached at belief-observation time; reducer accumulates `existing.evidence.push(...payload.evidence)`.

The "evidence X-Ray" is two things: (1) **General Recall X-ray** (`docs/xray.md`) — per-result retrieval attribution (tier, score decomposition, filters, budget); large retrieval-infra feature, not Relay-specific. (2) **Relay Mission Control provenance drawer** — answers "why did this agent believe this?" with the exact belief, source/capture type, timestamp, locator; labels **Recorded evidence** vs **Fresh inspection**.

**vs hermes:** hermes entries carry category + content + timestamp, but **no per-entry evidence**, no link from a recalled memory to a failing signal, no test/commit/source locators.

### 4. FRESH-AGENT VERIFICATION

Mechanism = `recall_observed` + `propagation_verified`. The cold-builder runs in a fresh Codex thread, calls `remnic.recall`; the runner captures a `RelayRecallReceipt` (query, sessionKey, memoryIds, tags, topK) proving **which memory id was returned**. `propagation_verified` requires `staleDecisionAbsent:true` + a `recall_audit` ref bound to the replacement `decisionId`. Then `test_result after-correction: passed` closes the loop; `relayMissionReceiptDigest` seals it.

**Product/demo concern vs hermes mechanism:** the 4-role Codex runner, Linux namespace/chroot isolation, credit cap, clean-room judge, browser Mission Control — all **OUT** (cross-agent platform + Linux-only + Codex-specific; `JUDGE-GUIDE.md` states macOS/Windows unsupported). BUT the **core check** — "after supersession, run a probe recall and assert (a) replacement id present, (b) stale id absent" — is a **portable single-process assertion** hermes could run against its own MD+SQLite after each correction. No GPU, no daemon, no second agent. The receipt is just "what `memory_search` returned."

### 5. SCOPE SPLIT

**OUT for hermes** (cross-agent / platform / Linux / Codex): 4-role mission runner, Codex one-shots, Linux isolation, credit ledger, clean-room judge, Mission Control UI, multi-tenant append-only event store, OpenClaw/MCP HTTP surface, the "one memory across every agent" ambition; belief-ledger's Brier-scored prediction calibration + Socratic `challenge`; general Recall X-ray.

**PORTABLE** (mechanism-only): versioned belief/decision model with `status active|superseded` + `supersedes`/`supersededBy`/`parentIds` lineage; append-only supersession preserving the old entry; per-entry `evidence[]` attached at write and recall; correction gate `proposed -> approved(human) -> applied` with required-evidence constraints; "current truth" by walking the chain; post-correction verification probe; host-neutral `LedgerLlmAdapter` pattern (mirrors hermes `completeSimple`/`spawnSubagent`).

### Portability verdict

**The minimal port upgrades hermes's flat categorized memory + correction-detection into versioned, supersedeable, provenance-bearing beliefs WITHOUT a platform rewrite and WITHOUT leaving the MD+SQLite spine:**

1. **Schema extension (MD frontmatter + SQLite columns).** Add to each entry: `status` (default `active`), `supersedes`, `supersededBy`, `parentIds[]`, `evidence[]` (`{kind, locator, capture}`). MD stays source of truth; the SQLite mirror gains matching columns so `memory_search` filters `status='active'` by default. **No new substrate — pure spine extension.**
2. **New tool `memory_supersede(priorId, replacement, reason, evidence[])`.** Writes a new correction-category entry with `supersedes=priorId` + `parentIds`; flips prior frontmatter `status=superseded` + `supersededBy` (file preserved, append-only); appends an audit line. Upgrades today's immediate correction-detection from "write a new flat correction" to "write a **linked, versioned** supersession."
3. **Wire evidence capture at the correction moment.** Background-review / correction-detector attaches the failing signal (recalled memory id, user correction text, optionally command/test) as `evidence[]`. Hermes's minimal "evidence X-Ray."
4. **Recall filter + verification probe.** `memory_search` defaults to `status='active'`; after each supersession, run one internal `memory_search`, assert replacement-present & prior-absent, log it. Single-process, no daemon, no GPU — the hermes analogue of fresh-agent verification (proves *the store* healed).
5. **Auto-consolidation coupling (flag, don't break).** Constrain consolidation to merge **within** a status and preserve `supersedes`/`supersededBy` links — never collapse an active<->superseded pair's lineage.

**Needs new substrate:** none required. **Out:** the platform (4-role runner, Mission Control, namespace event store, credit/isolation, cross-agent propagation), Brier/prediction calibration, general retrieval X-ray, all Codex/Linux specifics.

**Net:** Remnic cleanly separates *mechanism* (versioned beliefs + append-only supersession + evidence + verification probe) from *platform* (multi-agent relay). The mechanism is a faithful, additive upgrade to hermes's correction-detection + categorization, realized entirely as MD-frontmatter + SQLite-column + one-tool + one-probe.
