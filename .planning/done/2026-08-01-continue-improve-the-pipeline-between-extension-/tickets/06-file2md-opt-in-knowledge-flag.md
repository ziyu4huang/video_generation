---
status: closed
---

# 06 — file2md: opt-in `knowledge` flag + direct emit

## Question

Implement the **emit** side. Mechanism + payload settled by
[04 — emit contract](04-emit-contract-file2md-to-hub.md) (resolved 2026-08-01). In
`pi-agent-ext-file2md/extensions/file2md.ts`:

1. Add a `knowledge` boolean param (default `false`) to the `file2md` tool schema.
2. When `knowledge: true`, after `runVlmDescribePipeline` writes `./vlm-out/<slug>/`, emit
   DIRECTLY via `pi.events.emit("pi:knowledge", { source: "generic", sourceLabel: "file2md:<slug>", dir: <abs path to the slug output dir> })`.
   **No import from knowledge-card** — the channel name + payload shape are hardcoded here
   (~5 lines), per [04]-A (purest no-edge; file2md depends on nothing from the hub).
   Fire-and-forget: wrap in try/catch so a missing/throwing bus never breaks the conversion.
3. Default-off (`knowledge: false`) → no emission, zero behavior change (protects graph quality
   per [02 — scope](02-scope-opt-in-vs-auto.md)).

## Acceptance

- `knowledge: false` (default) → identical to today; no emission, no perf change.
- `knowledge: true` → exactly one fire-and-forget emission per conversion carrying
  `{source, sourceLabel, dir}`.
- **No upward import of hub logic** — ADR-0001 preserved (no
  `import ... from "@repo/pi-agent-ext-knowledge-card/..."`).
- Round-trip with [05](05-knowledge-card-sink-subscriber.md): `knowledge: true` → cards appear
  in `Zettelkasten/knowledge-graph/`; re-running the same conversion → no duplicate cards.

## type

`task` (AFK-able; the contract is now fully specified by [04]).

## blocked by

— (unblocked: [04](04-emit-contract-file2md-to-hub.md) resolved 2026-08-01). Parallelizable
with [05](05-knowledge-card-sink-subscriber.md) across the two packages; converges in the
round-trip test.

## claimed

—

## Resolution (closed 2026-08-12 — superseded)

Delivered — `file2md.ts:92` `KNOWLEDGE_CHANNEL="pi:knowledge"`, `:237-242` `knowledge` opt-in flag, `:272-273` emit, payload `{source:"generic", sourceLabel:"file2md:<slug>", dir}`; test `pi-agent-ext-file2md/__tests__/knowledge-emit.test.ts:18-24`; superseded by canonical walkAndIngest path.
