# Arc-27 planning task — D8 restorable child sessions (journal + restore persistent children)

You are the arc planner for self-arc-27 of this repo's self-develop loop. Read the repo from the root. Produce a strict wayfinder map + tickets in `.planning/2026-09-15-self-arc-27-restorable-children/plan.md`.

## User directive

User chose "D8 可還原子代理" from the ranked options: persistent children's transcripts must survive parent restart. Queue head = validated `output/next-goal-20260915-045500.md` rank 1. Branch `self-arc-27-restorable-children` claimed (ledger 29 entries, arc-27 active).

## Verified recon (spot-check, don't re-derive)

- pi 0.85.1 public API: `SessionManager.getEntries(): SessionEntry[]` (session-manager.d.ts:282); `static inMemory(cwd?, options?, entries?: FileEntry[]): SessionManager` (:334 — the `entries` restore param landed in 0.85.x); `FileEntry = SessionHeader | SessionEntry` (:107); helpers `parseSessionEntries(content)` (:145) and `loadEntriesFromFile(path)` (:169) exist for parsing journal files.
- Injection point: `CoreAgent.assembleSession` hardcodes `sessionManager: SessionManager.inMemory()` at `bun-apps/s2-agent-core-runtime/src/agent.ts:451`; `SessionAssemblyOptions` at :225 is the options seam. `persistent-agent.ts` wraps assembleSession for LiveAgents (named children): `:74` assembly field, `:356` the assemble call.
- Named children: `spawn_subagent` `name` param → LiveAgent registry (`live-agent-registry.ts`), retained across exchanges in-process (`persistent-agent.ts`: "A LiveAgent wraps ONE pi child session that survives its first exchange"). Unnamed one-shot children are NOT persistent — decide whether they journal at all (lean: named-only this arc).
- Current durability: NONE across parent restart — in-memory sessions die with the process (arc-25 D8 charter: "persistent children hold transcripts in-process; journaling FileEntry[] + restore-on-parent-restart is a new persistence layer").

## Design direction to adjudicate and ticket (verify details against source first)

1. **Journal**: after each settled exchange of a NAMED child, persist `session`'s entries to a durable file (candidate: `~/.pi/subagent-sessions/<name>.json` — check what persistence conventions exist already: `subagent-run-persistence.ts` uses `~/.pi/subagents/runs/<id>.json`; maybe reuse `~/.pi/subagents/` root). Atomic write (temp+rename), best-effort (a journal failure must never fail the child run). Find the right hook: persistent-agent's post-exchange settle point or a session subscription.
2. **Restore**: when `spawn_subagent` is called with a `name` whose journal file exists, thread the parsed entries into `assembleSession` (new `SessionAssemblyOptions.sessionEntries?`) → `SessionManager.inMemory(runCwd, undefined, entries)` → the child continues with full transcript. Adjudicate: automatic-on-name-match vs explicit `resume: true` param (schema delta cost!) vs restore-with-notice. The child should be TOLD it was restored (a system-prompt line or first-message marker) so it doesn't re-introduce itself.
3. **Versioning/robustness**: journal schema = raw FileEntry[] (pi's own format, parseable by pi's own helpers). Corrupt/missing file → fresh session silently (best-effort, never blocks dispatch). Consider a small header (name, savedAt, piVersion?) — but raw-entries-only is simpler; adjudicate.
4. **Cleanup**: entry eviction for the journal (e.g. registry dispose on session_shutdown — mirror how live-agent-registry disposes; decide whether journals are cleaned when the child is explicitly forgotten or kept for restore).
5. **NOT in scope**: unnamed one-shot children, detached-resume subprocess restore (different mechanism — check `detach-run.ts`/`spawn-subagent-subprocess.ts` interplay and chart if entangled), cross-machine restore.

## Constraints

- GLM-5.3 everywhere (never flash); devops CLIs own git phases; merge CLI gated ONLY on the programmatic CI verdict (note: the deploy-e2e deepseek leg auto-selects its lane by key presence — if DeepSeek is down again, unset DEEPSEEK_API_KEY so the e2e uses its documented zai lane; cite e2e-core-tool-roundtrip.test.ts:76-80).
- Tests: journal round-trip (entries → file → restore → getEntries equal), restore threads into a real createAgentSession (scripted-stream pattern exists in `core-runtime/tests/cwd-delegation.test.ts` — the child continues with prior context, provable without an LLM), corrupt-journal degrade, unnamed-no-journal, atomicity.
- Deployed receipt (t-final): a named child exchange 1 → fresh parent process → same name dispatch → child demonstrates knowledge of exchange 1 (e.g. recalls a code word). Isolated scratch env, pinned deploy dir, zai/glm-5.3 legs, receipts committed under evidence/.
- Keep tickets small: likely t01 journal (write side), t02 restore (read side + assembleSession seam), t03 deployed verification, t04 close-out.
- Schema-cost: if a `resume` param is added to spawn_subagent, that is a schema delta — record the canary before/after in the PR.

## Deliverable

`plan.md` wayfinder map: status, destination (falsifiable), context (file:line measured), scope in/out with reasons, tickets with surfaces + tests + verification clauses, decisions (numbered, dated), fog-of-war, successor sketch, cross-effort links (Builds-on arc-25 D8 charter + arc-26; Shares-decision-with as relevant).
