## Question

Should **subagent run records** be indexed into hermes-memory's **session-search**, so that "what did my subagents do" is discoverable alongside "what did my sessions do"?

Context: `pi-agent-ext-subagent` persists run records (`subagent-run-persistence.ts` → `SubagentRunRecord`, incl. status/output/usage/history) and keeps an in-flight registry. `pi-agent-ext-hermes-memory` already indexes Pi sessions (`session-search-tool`, `session-backfill`, `session-live-index`, `parseSessionFile`). Today these are **two unconnected corpora** — subagent work is invisible to `session_search`.

Decide:

- **In scope?** Is unified discoverability of subagent runs a real win, or is the `/subagents` viewer (in workflow ext) sufficient? (The viewer shows live/recent runs; session-search is for *historical* recall across sessions — different need.)
- **The sink** — is session-search the right home, or should run records feed the memory store / knowledge graph instead (or as well)? Run records are richer than session transcripts (they carry the task prompt, tier, usage, exit status).
- **Shape compatibility** — does `SubagentRunRecord` fit `parseSessionFile`'s model, or does indexing need a dedicated adapter? (Likely an adapter — surface this as a finding.)
- **Ownership** — who emits: does the subagent ext publish run records to a seam the memory ext consumes, or does the memory ext reach into the persistence singleton? (Touches the module-identity rule.) → this is the fog that may push ownership into a coordination layer (see map Not-yet-specified).
- **Backend neutrality** — must work for both SQLite and SurrealDB session stores.

type: grilling
claimed: controller (2026-07-25)

## Resolution

_Closed 2026-07-25 — grilling Q1=A: not worth building now._

**Decision: CLOSE. The high-value case is already covered by parent session-search; the remaining gap is YAGNI.**

### Why close
- A subagent's **output** is returned to the parent session as a tool result, and `parseSessionFile` indexes `user`/`assistant`/`system` text + assistant `toolCalls` (`session-parser.ts:144`). So **"what did my subagent produce" is already searchable** via `session_search` over the parent session's transcript.
- The genuinely-uncovered gap is narrower than the ticket assumed: **subagent INTERNAL work** (the `history` field — the child's own tool calls/reasoning), **cross-session run aggregation**, and runs whose **parent session was never indexed/backfilled**. All low-value until a concrete need surfaces.
- The two corpora differ in shape (`~/.pi/sessions/*.jsonl` message-stream vs `~/.pi/subagents/runs/<id>.json` single rich record) → any indexing needs an adapter with questionable fit — not worth it for the narrow gap.

### Revisit trigger
A concrete need to **search subagent internal work** or **aggregate runs across sessions** (e.g. "show me all research-subagent runs this month"). At that point build a **dedicated `subagent_runs` search** (option B from the grill), NOT a shoehorn into `session-search` (shape mismatch).

### Hand-off
None — no build. Does NOT produce a plan.
