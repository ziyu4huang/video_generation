Arc-27 planning complete. Committed `82f1e5db` on `self-arc-27-restorable-children`.

## Deliverable

- **`map.md`** (canonical wayfinder map — the ledger guard and effort-audit require it BY NAME; `plan.md` is the adjudication cover, arc-25/26 precedent)
- **`plan.md`** (verdict table mapping every directive question → decision → anchor)
- Guards: arc-ledger test **13/13 pass**, effort-audit **102 scanned / 0 red** with the new effort present.

## Recon verified — and extended beyond the brief

The brief's anchors all held (`agent.ts:451` exact; `persistent-agent.ts:72/:356`; `inMemory(cwd?, options?, entries?)` at d.ts:334). New load-bearing measurements:

1. **Restore semantics live in `_loadEntries`** (session-manager.js:671-685): a header entry restores `sessionId = header.id` + computes the leaf from the tree; `parseSessionEntries` (:91-106) **skips corrupt lines itself** — corrupt-journal degrade is pi's behavior, not ours to build. This drove D1 (raw JSONL, no wrapper).
2. **`LiveAgent` is name-less** — the name lives only at `spawnLiveAgentFirstExchange` (`:409`), so the journal is constructed there and closes into the LiveAgent's existing settle-`finally` (`:303-306`) — one hook covers first dispatch, `send_message`, and post-steer settles (D3).
3. **`spawn_subagent` is the SOLE entry** to `spawnLiveAgentFirstExchange` (batch tool has no `spawnLive` reference) — zero ext-subagent diff needed for restore; the notice rides the existing `result.output` channel (`subagent-tool.ts:667`).
4. **`name` is free-form `Type.String`** (schema:141-146, no charset) → filename sanitization is load-bearing (D6).
5. **Deploy truth (learning #1/PB-09)**: `@repo/s2-agent-core-runtime` inlines into BOTH `ext/subagent/ext.cjs` and core `s2-agent.js`, and sits inside `workspaceSrcDirs` hashing (deploy/run.ts:265) — the core cache auto-MISSES; t03 greps both bundles (`restored from journal`, `sessionEntries`).

## Ticket set

| | Content | Key exit |
|---|---|---|
| t01 | journal module (`~/.pi/subagents/sessions/<name>.jsonl`, atomic, last-N=200, injectable home/fs) + settle write hook | round-trip/charset/atomicity/best-effort tests + **PRE-fix no-restore receipt (PB-10)** |
| t02 | `SessionAssemblyOptions.sessionEntries` → `inMemory(runCwd, undefined, entries)`; auto-restore + cwd guard + dual notice, **zero schema delta** | scripted-stream proof the restored pair reaches model input (cwd-delegation pattern, no LLM) |
| t03 | pinned deploy, R1 restart-survival (code word across fresh parents) + R2/R3 controls (+R4 cwd-guard stretch) | receipts → `evidence/`; zai lane fallback per e2e:76-80 if DeepSeek is down |
| t04 | close-out: PB-03–07, `Completed-by` on arc-25's D8, strict-v2 successor | effort-audit exit 0 |

PB cited at point of use: **PB-01/02/19** at open, **PB-08–15, 18** in t01–t03, **PB-03–07/16/17** in t04; learnings **#1/#2** (t03 greps + cache-MISS), **#6** (fresh process per leg).

**Frontier: t01** — sync to tip first (`sync-default-branch-cli --mode hands-on`), then the `npm view` pi-cadence check (defer-by-default, Scope OUT), then drift-check `persistent-agent.ts` against the map's anchors.