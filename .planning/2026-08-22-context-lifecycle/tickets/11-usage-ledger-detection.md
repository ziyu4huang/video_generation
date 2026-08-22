# 11 — usage ledger: deterministic "card was used" detection

- **Phase:** P3 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** open

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
