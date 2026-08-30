# 11 — usage ledger: deterministic "card was used" detection

- **Phase:** P3 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** closed 2026-08-29 (PR #2148)

## Problem

No signal exists for which cards actually helped. OpenViking's `used()` telemetry feeds
hotness; we need a deterministic equivalent before feedback can mean anything (D8).

## Approach

1. **Probe first:** verify the `turn_end` payload's assistant-text surface at the extension
   layer (Fog entry). If absent, zk_card provenance (ii) carries v1 alone.
2. New `src/feedback/usage.ts` with three provenance sources:
   (i) turn_end scan of assistant text for injected card titles/slugs (port of hermes
   `src/handlers/used-detection.ts` slug-scan pattern);
   (ii) `zk_card` find/read tool-result provenance — cards rendered in-session count as used;
   (iii) `pi:knowledge` bus `used` event — extend `src/emit.ts` (`KnowledgeEmission` union +
   `onKnowledge` routing) so workflows can report usage from receipts.
3. Storage: append-only `<vault>/.knowledge-usage.jsonl` (`{uri, at, via}`) — NEVER
   frontmatter, so reads leave the git vault clean. Vault `.gitignore` entry if needed.
4. Detection runs best-effort at turn_end / tool-return; never throws, never blocks.

## Acceptance

- Deterministic detection tests for each source (mock turn_end payload, captured zk_card
  result, bus emission).
- Vault `git status` clean after a read+use cycle (no frontmatter writes) — explicit test.
- Ledger append atomicity (crash-safe append test).

## Verification

Canonical kcard gates + a scripted session: inject → model echoes a card title → turn_end →
ledger row present with `via: "turn_end"`.


## Resolution

Closed 2026-08-29 (PR #2148 merged `e989762b`; reviewer BLOCK→fix→APPROVE, repros re-run).
`src/feedback/usage.ts` + entry wiring: (i) turn_end assistant-text scan vs the auto-recall
served set (trace.servedCards — the same post-budget set the RecallLedger records), (ii)
non-error zk_card results vs served set + per-root lazy vault title index, (iii) `pi:knowledge`
bus used reports. Storage `<vault>/.knowledge-usage.jsonl` `{uri, at, via}` — never
frontmatter (git-clean cycle tested); cross-source monotonicity via a `detected` Set. Vault
ignore entry committed vault-side (pi-agent-vault#22) + gitlink bump. 24 unit tests +
entry-wiring integration. Deferred follow-up: Tier-3 plain-subdir vault shows the ledger
untracked in the host repo (finding 9). t11's `via` kinds are DISTINCT from the D37
SurrealDB access ledger (used ≠ served ≠ accessed — ADR-knowledge-card-0001).
