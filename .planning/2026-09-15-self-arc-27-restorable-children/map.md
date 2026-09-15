---
effort: 2026-09-15-self-arc-27-restorable-children
created: 2026-09-15
last: 2026-09-15 (planning)
status: active
---

# Wayfinder map: self-arc-27 — D8 restorable child sessions (journal + restore persistent children)

Planned 2026-09-15 in this worktree (`video_generation__subagent`, branch
`self-arc-27-restorable-children` at `bf9a2c2b` = the claim commit, clean).
Ledger row 27 claimed at branch time (`.planning/arc-ledger.json`, 29 entries,
arc-27 active — **PB-02**, no sibling collision: no other live effort's map
lists this scope). Queue head = validated successor
`output/next-goal-20260915-045500.md` rank 1 ("D8 可還原子代理" — user-chosen);
ranks 2–5 stay out of focus scope (**PB-19**). Every file:line below was read
by the planner on 2026-09-15 (grep/read against the installed pi 0.85.1 dist
and repo source at `bf9a2c2b`). Artifact note: the canonical map lives at
`map.md` BY NAME (arc-26 planner-audit lesson — the ledger guard
`arc-ledger.ts:168-170` and `effort-audit.ts:296-299` require it); `plan.md`
is the adjudication cover (arc-25/26 precedent).

## Destination

A named persistent child's transcript survives its parent process: after every
settled exchange of a NAMED child the full pi `FileEntry[]` session (header +
entries) is journaled to a durable per-user file, and a later
`spawn_subagent` dispatch with the same `name` — including from a FRESH
parent process after restart — restores that transcript into the new child
session via `SessionManager.inMemory(cwd, undefined, entries)`, so the child
continues with full prior context (proven on a pinned deployed tree: exchange
1 plants a code word, a fresh parent re-dispatches the same name, the child
recalls the code word), journals are best-effort throughout (a journal failure
can never fail a child dispatch), and the arc closes
terminal-with-provenance.

## Context (measured 2026-09-15 at `bf9a2c2b`)

- **The pi 0.85.1 restore API is present, public, and unused by us** (shipped
  dist `node_modules/.bun/@earendil-works+pi-coding-agent@0.85.1*/…`):
  `SessionManager.getEntries(): SessionEntry[]` — "shallow copy", excludes
  header (`session-manager.d.ts:289`); `getHeader(): SessionHeader | null`
  (`:286`); `static inMemory(cwd?, options?, entries?: FileEntry[])` —
  "in-memory session (no file persistence), optionally from entries held
  outside the filesystem" (`:334`); `FileEntry = SessionHeader | SessionEntry`
  (`:107`); helpers `parseSessionEntries(content)` (`:145`) and
  `loadEntriesFromFile(path)` (`:169`). `NewSessionOptions = { id?; parentSession? }`
  (`:13-16`).
- **Restore semantics measured in the shipped js** (`session-manager.js`):
  constructor `:598-614` — `preloadedFileEntries?.length` →
  `_loadEntries(entries, newSessionOptions)`; `_loadEntries` `:671-685` — a
  header entry (`type === "session"`) sets `fileEntries` AS-IS, **sessionId =
  header.id**, runs pi's own `migrateToCurrentVersion`, then indexes the tree
  and computes the leaf; headerless input → `newSession(options)` + concat.
  `parseSessionEntries` `:91-106` splits JSONL and **silently skips malformed
  lines** (corrupt-journal degrade is pi's own behavior, not ours to build).
  `inMemory` impl `:1254-1256`. `AgentSession.sessionManager` is public
  readonly (`agent-session.d.ts:194-196`) — the journal hook can read
  entries/header off a live session.
- **Injection point — the one hardcoded line**: `CoreAgent.assembleSession`
  builds the child session with `sessionManager: SessionManager.inMemory()`
  (`bun-apps/s2-agent-core-runtime/src/agent.ts:451`, inside the
  `createAgentSession({...})` call at `:445-460`). `SessionAssemblyOptions`
  (`agent.ts:225-247`) is the documented seam shared verbatim by `run()`
  (one-shot) and `openLiveAgent` — adding one optional field there is the
  whole core seam.
- **Named-child machinery** (all in `s2-agent-core-runtime/src/`):
  `persistent-agent.ts` — `OpenLiveAgentOptions.assemble?` injectable
  (`:72`), `openLiveAgent` (`:335`, default assemble closure calls
  `agent.assembleSession(input.assembly)` at `:356`), lifetime-guard
  subscription `:383`, `LiveAgent.send()` settles in a `finally` that sets
  `_status = "idle"` + `emitHistory()` (`:303-306`), `dispose()` `:311`;
  `spawnLiveAgentFirstExchange` (`:409`) — the ONLY named-child spawn path:
  registry collision pre-checks, REGISTER-BEFORE-FIRST-EXCHANGE (arc-23
  F-steer-1b), first `agent.send(opts.task, …)`, budget/turns ceiling →
  `registry.release` (`:514`). `LiveAgent` does NOT know its name — the name
  lives in `open.name` at `spawnLiveAgentFirstExchange` and in the registry
  entry (`live-agent-registry.ts` `LiveAgentEntry.name`).
- **Registry lifecycle** (`live-agent-registry.ts`): LRU cap
  `DEFAULT_MAX_LIVE = 6` / `SUBAGENT_MAX_LIVE`; entries leave via explicit
  `release(name, reason)` (`:204` — "durable run records stay; only the live
  session dies"), LRU eviction, or `disposeFor(sessionId)` (`:226`,
  session-shutdown). The session_shutdown wiring is
  `s2-agent-ext-subagent/extensions/subagent.ts:323-327`
  (`liveRegistry.disposeFor("*")`). **Eviction/dispose freeing the name while
  the journal survives is exactly what makes restore compose with LRU.**
- **Sole dispatch entry**: `spawn_subagent`'s `name` param
  (`subagent-tool-schema.ts:141-146` — free-form `Type.String`, NO charset
  validation → journal filename sanitization is load-bearing) routes through
  `spawnLive` (`subagent-tool.ts:89` injectable, call site `:441-456`) =
  `spawnLiveAgentFirstExchange`; the batch tool (`list_subagents`) does NOT
  open named agents (grep: no `spawnLive` reference in `subagents-tool.ts`).
  The parent-visible "Named agent X is live" line is appended to
  `result.output` at `subagent-tool.ts:667-668` — the channel the restore
  notice rides. `send_message` later exchanges go through
  `entry.agent.send()` = the same `LiveAgent.send` → one journal hook covers
  every exchange path.
- **Persistence conventions to reuse** (`s2-agent-core-runtime/src/subagent-run-persistence.ts`):
  home `~/.pi/subagents` (`SUBAGENT_HOME_RELATIVE_DIR` `:34`), `runs/` subdir
  (`:35`), atomic tmp+rename + last-N retention default 200 (`:196`,
  `maxRuns`), injectable `home` / `maxRuns` / `fsOverride` for tests
  (`:192-198`); `homeDir()` honors `$HOME` first (`home.ts:15-18` — test
  fake-home compatible). The `detached/` subdir (`:159-175`) is the
  OS-subprocess resume manifest layer — a DIFFERENT mechanism from this arc's
  in-process journal (no interplay; see Scope OUT).
- **Test patterns that exist**: scripted-stream no-LLM agent-loop turns
  (`s2-agent-core-runtime/tests/cwd-delegation.test.ts:1-42` — fake `Model` +
  `createAssistantMessageEventStream`, REAL `createAgentSession` + wrapped
  tool registry); `spawnLiveAgentFirstExchange` injection harness
  (`tests/persistent-agent.test.ts:217-261` — `openAgent` fake +
  registry reset). Both are the molds for t02's restore proof.
- **Deploy truth (learnings #1/#2, PB-09)**: `@repo/s2-agent-core-runtime`
  is a dependency of BOTH `bun-apps/s2-agent` (`package.json:29` — core
  bundle, hashed via `workspaceSrcDirs`: `deploy/run.ts:265` +
  `resolveWorkspaceSrcDirs` `:189-215`, so a core-runtime change forces a core
  cache MISS by construction) and `s2-agent-ext-subagent`
  (`package.json:55` — INLINED into `ext/subagent/ext.cjs`). Journal code
  therefore ships in BOTH bundles; PB-09 greps target string literals +
  property names (`restored from journal`, `sessionEntries`), never locals.
- **Gates**: `s2-agent-core-runtime` canonical = `check`/`typecheck`/`test`;
  `s2-agent-ext-subagent` = `check` (biome; warnings ≠ failures) + `build`
  (tsc) + `test:unit`. `local_ci` resolves gates by script NAME per package.
  Devops CLIs own git phases. This arc plans ZERO `bun-apps/s2-agent/**`
  edits → per arc-25 Corrections #4's honest rule, NO version bump unless a
  ticket actually touches `s2-agent/**` (deploy labels name the commit sha
  regardless). Deploy e2e lane: if DeepSeek is down again, unset
  `DEEPSEEK_API_KEY` so `E2E_PROVIDER` auto-selects its documented zai lane
  (`s2-agent-ext-devops/tests/e2e-core-tool-roundtrip.test.ts:76-80`).
- **No prior art in-tree**: grep `subagents/sessions|child-session` over
  core-runtime + ext-subagent source = ∅ (this session) — the journal is a
  NEW surface, not a refactor. Current durability is NONE across parent
  restart (arc-25 D8 charter: "persistent children hold transcripts
  in-process; journaling FileEntry[] + restore-on-parent-restart is a new
  persistence layer").
- **Playbook application (task label
  `loop-playbook-cite-the-pb-nn-ids-you-app`)**: PB-01 (sync at t01 open),
  PB-02 (ledger claim done), PB-19 (focus scope = queue-head ranking);
  t-internal: PB-10 (PRE-fix receipt: the no-restore behavior is
  receipt-able pre-merge), PB-11 (pre-registered checks frozen in t03),
  PB-08/PB-09 (pinned dir + bundle greps), PB-12 (passive model
  attribution, `--model zai/glm-5.3`, flash excluded by name), PB-13/PB-14
  (preserve fails, ≤2 legs/cell, dated defers), PB-15 (unreachable = gap),
  PB-18 (receipts under `evidence/`, ≤256KB/file), PB-03/PB-04/PB-05/PB-06/
  PB-16/PB-17 in t04. Learnings #1/#2 → t03 pre-drive greps + cache-MISS
  check; #6 → every t03 leg a FRESH process.

## Scope

### In

- New `bun-apps/s2-agent-core-runtime/src/child-session-journal.ts`: path
  resolution (`~/.pi/subagents/sessions/<name>.jsonl`), name-charset guard,
  atomic write (tmp+rename), best-effort read (`FileEntry[] | undefined`),
  last-N retention, injectable `home`/`maxEntries`/`fsOverride`
  (subagent-run-persistence pattern) (t01).
- Journal write hook: `LiveAgent` settle-time persist + wiring in
  `spawnLiveAgentFirstExchange` (which owns the name) (t01).
- Restore: `SessionAssemblyOptions.sessionEntries?` consumed at
  `agent.ts:451`; `OpenLiveAgentOptions.sessionEntries?`; journal read +
  cwd guard + child preamble + parent notice in
  `spawnLiveAgentFirstExchange` (t02).
- Tests: journal round-trip, charset guard, atomicity, retention,
  best-effort swallow, unnamed-no-journal; restore-into-real-session
  (scripted-stream), cwd-mismatch fresh, corrupt-journal fresh, header-id
  preservation, notice line, schema-cost canary = ZERO (t01/t02).
- Deployed verification receipts on a pinned immutable dir, isolated scratch
  env, GLM-5.3 legs (t03); close-out (t04).

### Out (with reasons)

- **Unnamed one-shot children journaling** — their value is the dispatch
  result, already durably recorded write-once in `runs/`
  (`subagent-run-persistence.ts` module header: "no resume semantics");
  journaling them doubles that layer for no consumer. Directive lean
  adopted: named-only this arc.
- **Detached-resume subprocess restore** (`detach-run.ts`, `runs/detached/`
  manifests) — a different mechanism (OS subprocess resumes from its own
  manifest); measured no interplay with the in-process journal (separate
  subdir, invisible to `list()`). No entanglement found; stays out.
- **Cross-machine / shared-journal sync** — journals are machine-local under
  `$HOME`; no sync surface exists in-tree.
- **`resume` tool param or any schema delta** — automatic-on-name-match with
  notices covers the receipt scenario with ZERO schema cost (**D4**); the
  force-fresh escape hatch is charted (Fog of war), not built.
- **Journal viewer/clear UX** (a `list_subagent_runs` journal action, forget +
  delete) — no demand yet; retention (last-N) bounds growth. Charted.
- **Cross-restart budget/turn ceiling accumulation** — guards attach per-open
  by design (**D8**); no new accounting.
- **pi upgrade cadence** — queue head rank-3 carry-over says check npm at arc
  open: t01 step 0 runs `npm view @earendil-works/pi-coding-agent version`;
  a bump is DEFERRED to a successor unless it is required for this feature
  (it is not — 0.85.1 ships the `entries` param). Recorded, not folded.

## Tickets

### Phase 1 — journal write side

**t01 — child-session journal module + named-settle write hook [build] — status: open**

Package `bun-apps/s2-agent-core-runtime`; files: NEW
`src/child-session-journal.ts`; `src/persistent-agent.ts` (LiveAgent persist
hook + journal construction in `spawnLiveAgentFirstExchange`);
`src/index.ts` barrel export.

- **Module surface** (mirror `createSubagentRunPersistence` conventions):
  `createChildSessionJournal(options?: { home?; maxEntries?; fsOverride? })`
  returning `{ persist(name, session): void; load(name): FileEntry[] |
  undefined }` — `persist` serializes `[getHeader(), ...getEntries()]` as
  JSONL (one `JSON.stringify` per line) to
  `join(subagentHomeDir(home), "sessions", `<name>.jsonl`)` via tmp+rename,
  then runs the last-N retention sweep (default 200, mtime-ordered);
  `load` returns parsed entries ONLY when a `type === "session"` header AND
  ≥1 non-header entry survive parsing (missing file / read throw / empty →
  `undefined`). Best-effort contract: **every** method catches its own fs
  errors and degrades (persist→noop, load→undefined); a journal failure must
  never reach the exchange result. Name guard: journal only when
  `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` matches (**D6**) — otherwise persist
  and load are no-ops for that name.
- **Write hook**: `LiveAgent` constructor init gains optional
  `persist?: (session: AgentSession) => void`; `send()`'s existing `finally`
  (`persistent-agent.ts:303-306`) calls `this.persist?.(this.session)` AFTER
  the status flip (steers early-return before the hook — the settled outer
  exchange persists them; no double-write). `spawnLiveAgentFirstExchange`
  constructs the journal (name known at `:409`+) and closes it into the
  LiveAgent init via the `openAgent` options (add
  `persist?: (session) => void` to `OpenLiveAgentOptions`, threaded by
  `openLiveAgent` into the LiveAgent init) — the hook is injectable and
  defaulted in ONE place.
- **Tests** (`tests/child-session-journal.test.ts` +
  `tests/persistent-agent.test.ts` extensions): (a) round-trip — real
  `SessionManager.inMemory()` + appended message entries → `persist` →
  `load` → `parseSessionEntries` equality AND
  `SessionManager.inMemory(cwd, undefined, loaded)` reproduces
  `getEntries()` + `getSessionId()`; (b) charset guard — `a/b`, `../x`,
  `.hidden`, 65-char name → no file written, no throw; (c) atomicity —
  fsOverride capture asserts tmp path then rename, never a direct write to
  the final path; (d) retention — 201 journals → oldest evicted; (e)
  best-effort — throwing fsOverride on persist → `send()` result unchanged;
  read-throw on load → `undefined`; (f) unnamed one-shot unchanged —
  `spawnSubagent` path writes nothing (assert no `sessions/` dir after a
  one-shot with `name` absent); (g) settle-hook fires once per settled
  exchange via the existing `openAgent` fake harness.
- **Verification clause**: `( cd bun-apps/s2-agent-core-runtime && bun run
  test )` green; `( cd bun-apps/s2-agent-ext-subagent && bun run test )`
  green unchanged (downstream consumer of the barrel). Schema-cost canary
  recorded — expectation ZERO delta (no tool surface touched).
- **Done when**: merged via devops chain; all tests green; PRE-fix receipt
  of the no-restore behavior captured (PB-10): on this branch's build, a
  fresh-process same-name dispatch starts a BLANK child (transcript does not
  survive) — one headless log under `evidence/pre-fix/`.

### Phase 2 — restore read side

**t02 — journal restore through assembleSession + notices [build] — status: open**

Package `bun-apps/s2-agent-core-runtime`; files: `src/agent.ts`
(`SessionAssemblyOptions` at `:225` + the `:451` consumption),
`src/persistent-agent.ts` (`OpenLiveAgentOptions`, `openLiveAgent` assembly
threading, `spawnLiveAgentFirstExchange` read/guard/preamble/notice),
`src/child-session-journal.ts` (cwd guard helper if owned there).

- **Core seam**: `SessionAssemblyOptions.sessionEntries?: FileEntry[]`; at
  `agent.ts:451` → `sessionManager: assembly.sessionEntries ?
  SessionManager.inMemory(runCwd, undefined, assembly.sessionEntries) :
  SessionManager.inMemory()` (one-shot `run()` never sets it — unchanged
  shape). `openLiveAgent` threads `options.sessionEntries` into the assembly
  literal (`:356` block).
- **Restore flow** in `spawnLiveAgentFirstExchange` BEFORE `openAgent`:
  `load(name)` → if entries AND cwd guard passes (journal header `cwd ===
  resolvePath(opts.cwd ?? process.cwd())` — **D2**) → pass
  `sessionEntries` + `restoredMeta {savedAt: file mtime ISO, entryCount}` in
  the `openAgent` options. After the first exchange: prepend the one-time
  child preamble to the FIRST send's task text (anchor literal
  `[session restored from journal` + entry count + savedAt + "you are
  continuing a previous conversation — do not re-introduce yourself";
  `deriveTaskLabel` still reads the ORIGINAL task), and append the
  parent-visible notice line to `result.output`:
  `[restored from journal: N entries, saved <ISO>]` (rides the
  `subagent-tool.ts:667` channel; ext-subagent needs ZERO diff).
- **Tests** (extend `tests/persistent-agent.test.ts` +
  `tests/cwd-delegation.test.ts`-pattern new file): (a) **restore threads
  into a REAL createAgentSession** — scripted-stream, no LLM: journal a
  first exchange whose user text plants `CODEWORD ZEBRA-77`; assemble a
  second CoreAgent session with `sessionEntries`; assert the scripted
  stream's request messages CONTAIN the prior user/assistant pair,
  `session.sessionManager.getSessionId() === journal header id`, and the
  result carries the notice line; (b) cwd mismatch → fresh (no entries reach
  assembly, no notice); (c) corrupt journal (garbage bytes + one valid
  line) → `load` returns headerless/empty → fresh, never throws; (d)
  headerless-but-nonempty → fresh; (e) fresh path byte-identical behavior
  when no journal exists (regression pin on the `:451` default); (f)
  preamble present exactly once (first exchange only), label derived from
  the original task.
- **Verification clause**: both packages' canonical `bun run test` green;
  schema-cost canary before/after — ZERO delta (no param/description edits);
  `bun bun-apps/s2-agent/src/cli.ts tools-metrics --schema-cost` output
  recorded in the PR body.
- **Done when**: merged; tests green; PR body carries the canary table +
  the design-decision citations (D2/D3/D4).

### Phase 3 — deployed verification

**t03 — deployed verification: restart-survival receipt [verify] — status: open**

Pattern: arc-25 t06 / arc-26 t02 (pinned deploy, scratch env, pre-drive
greps). Preconditions: t01+t02 merged; tree synced to tip (**PB-01**,
`handsOn.callerAtTip: true` or stop).

- **Deploy**: `( cd bun-apps/s2-agent && bun run deploy --no-freeze --force )`;
  record the PINNED `<version-dir>` (never `current` — **PB-08**); post-deploy
  e2e green (if the deepseek leg hangs on a live outage, unset
  `DEEPSEEK_API_KEY` → zai lane per
  `e2e-core-tool-roundtrip.test.ts:76-80` — arc-26 Corrections #1 precedent;
  note the lane in the receipt).
- **Pre-drive greps (PB-09 — string literals / property names)**:
  `ext/subagent/ext.cjs`: `restored from journal` ≥1,
  `sessions` path join ≥1; core `s2-agent.js`: `sessionEntries` ≥1
  (the assembleSession property) — the journal code is inlined into BOTH
  (Context, deploy-truth bullet). ALSO verify the core cache MISSED for this
  deploy (core-runtime is inside `workspaceSrcDirs` — a cache HIT with these
  changes would be learning #1's stale-core shape: STOP, receipt, investigate).
- **Isolated scratch env**: throwaway git repo under `output/` +
  `PI_CODING_AGENT_DIR`-style isolation for `$HOME`-relative state where the
  harness allows it (else a pre-cleaned `~/.pi/subagents/sessions/` probe
  name namespace: unique per-leg name prefix `arc27-<ts>-`).
- **Pre-registered legs (PB-11 — freeze checks verbatim; ≤2 legs/cell
  PB-14; every leg a FRESH process, learning #6; `--model zai/glm-5.3`
  stamped per leg, flash excluded by name PB-12)**:

  | Leg | Steps | PASS iff |
  |---|---|---|
  | R1 restart-survival (THE receipt) | fresh parent P1: dispatch named child `arc27-<ts>-scout` with task "remember the code word ZEBRA-77, reply ACK"; P1 exits; fresh parent P2, same cwd: dispatch SAME name with task "state the code word you were told" | P2 output contains `ZEBRA-77` AND the `[restored from journal: …]` notice; journal file exists under `~/.pi/subagents/sessions/` with a `session` header line |
  | R2 fresh-name control | same P2 (or P3): dispatch a NEVER-USED name, task "reply with the code word you were told (or NONE)" | output does NOT contain ZEBRA-77 and contains NO restore notice |
  | R3 corrupt-journal control | plant garbage bytes into a probe name's `.jsonl`; dispatch that name | dispatch SUCCEEDS as a fresh child (no restore notice), no crash |
  | R4 cwd-guard control (stretch, only if R1–R3 green) | dispatch R1's name from a DIFFERENT cwd | fresh child, no restore, no crash |

  Decision tree (pre-committed): R1 restores but child does NOT recall →
  context-threading bug in t02 (entries loaded but not in model input) →
  file regression, no re-roll; R1 restores AND recalls but notice missing →
  notice-channel bug, file it; any leg >2 attempts → DATED defer naming the
  blocker (PB-14). The t01 PRE-fix log (same scenario on the no-restore
  build) is the paired PRE side (PB-10).
- **Receipts (PB-13/PB-15/PB-18)**: `evidence/deployed-verification/README.md`
  + per-leg logs + deploy JSON + grep table; gaps recorded as gaps.

**Done when**: R1+R2+R3 PASS on the pinned dir (R4 optional-or-gap) with
receipts committed; map Context annotated with measured results.

### Phase 4 — close-out

**t04 — close-out [close] — status: open**

- **PB-03**: tree clean, all work committed/pushed BEFORE the successor file;
  merge CLI gated ONLY on the programmatic CI verdict. Version bump: only if
  a ticket touched `bun-apps/s2-agent/**` (planned: none — record the check).
- **PB-06**: independent reviewer pass (fresh GLM-5.3 process) on the arc's
  outputs; REQUEST-CHANGES fixed same session; harvest receipt cited.
  **PB-07**: n/a with reason — this arc ships a durability feature, not a
  quality-gate tool; its own dogfood is R1 (the arc's PR-review dispatches
  from this repo ride the same journal surface).
- **PB-05**: `status: done` + `## Shipped-as` (merged PR numbers) in the SAME
  close-out PR; `effort-audit.ts` exit 0.
- **PB-16**: arc-25's map D8 chart gets `Completed-by:
  2026-09-15-self-arc-27-restorable-children` on its `## Cross-effort
  links` (both sides, same session); arc-26's next-goal rank-1 item is
  discharged by this arc's Shipped-as (cite in its Fog of war only if
  touched — no open ticket there).
- **PB-04/PB-19**: strict-v2 successor `output/next-goal-<ts>.md` (validated
  exit 0, LATEST repointed after validation, doctor run); ranked list =
  the queue head's remaining ranks (trust-UX persistence, host-security
  option (a), deploy-report dependency stamping, win32-x64 e2e stability) +
  this arc's recorded gaps — re-ranked ONLY on new in-scope blockers; queue
  drift surfaced, never silently picked.
- Ledger row 27: `mergedPr` filled, status done. Playbook curation only if
  this arc earns a new entry (candidate: none expected — the receipts
  discipline is already encoded).

## Decisions

- **D1 (2026-09-15) — Journal format = raw pi JSONL `FileEntry[]`, header
  first, NO wrapper.** Reasons: parseable by pi's own helpers; `_loadEntries`
  restores sessionId from the header and computes the leaf
  (`session-manager.js:671-685`); version migration is pi's own
  (`migrateToCurrentVersion` runs inside `_loadEntries`); malformed lines are
  skipped by pi's parser (`:91-106`). A custom `{name, savedAt, piVersion}`
  wrapper is a second schema to steward for metadata a filename + `stat()`
  already carry. Rejected: JSON-doc wrapper (dual format), append-only
  partial writes (breaks atomicity; whole-file rewrite per settle is
  tmp+rename atomic and self-consistent).
- **D2 (2026-09-15) — Journal key = NAME ONLY, under
  `~/.pi/subagents/sessions/<name>.jsonl`; restore is cwd-GUARDED.**
  Keying by parent-session id would defeat the feature by construction (a
  restarted parent has a new session id). Cross-project same-name collision
  is real, so restore additionally requires journal-header `cwd` === the new
  dispatch's resolved cwd — mismatch degrades to a fresh child (pinned by
  R4/test-b). Provenance survives in the header (`SessionHeader.cwd`).
- **D3 (2026-09-15) — Write hook = `LiveAgent.send()` settle (existing
  finally), journal constructed by `spawnLiveAgentFirstExchange`.** The name
  is known only at the spawn layer (`LiveAgent` itself is name-less), and the
  settle-finally is the single point every exchange path (first dispatch,
  `send_message`, post-steer) funnels through. Steers early-return before the
  hook — the settled outer exchange persists them. Best-effort by contract:
  journal fs failures are swallowed and can never fail an exchange.
- **D4 (2026-09-15) — Restore is automatic-on-name-match WITH dual notice; NO
  `resume` schema param.** Zero tool-schema delta (canary expectation pinned
  in both PRs); the receipt scenario needs no new model-visible knob. Notices:
  parent sees `[restored from journal: N entries, saved <ISO>]` in the tool
  output; child gets a ONE-TIME first-exchange preamble (in-transcript, not
  per-exchange `instructions` pollution) telling it to continue, not
  re-introduce. Rejected: `resume: true` param (schema cost + teaching burden
  for a case name-matching already decides); silent restore (the parent must
  know the child has history — PB-21-adjacent honesty about model-visible
  state).
- **D5 (2026-09-15) — Core seam = ONE optional field:
  `SessionAssemblyOptions.sessionEntries?: FileEntry[]` consumed at
  `agent.ts:451`.** The options interface is the documented shared seam
  (`agent.ts:225` block); the one-shot `run()` path is untouched (field
  unset → byte-identical `inMemory()` call). Threading:
  `spawnLiveAgentFirstExchange` → `OpenLiveAgentOptions.sessionEntries` →
  assembly literal → `assembleSession`. Test `assemble` injectors unaffected
  (they receive the field and may ignore it).
- **D6 (2026-09-15) — Journal-safe name charset
  `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`; outside it, journaling silently
  disabled for that name.** `spawn_subagent.name` is free-form
  (`subagent-tool-schema.ts:141-146`, measured no validation) — path
  traversal and filesystem-hostile names are killed at the journal boundary,
  not by tightening the tool schema (which would be a behavioral delta for
  existing users). Dispatch is NEVER affected.
- **D7 (2026-09-15) — Journals SURVIVE disposal; retention = last-N by mtime
  (default 200, mirroring runs).** Eviction (LRU), `disposeFor`
  (session_shutdown), and explicit release kill the in-memory session only —
  the journal is the restore point, and eviction+restore compose (the LRU cap
  stops being a durability cliff). Growth is bounded by the same last-N
  convention the runs layer already documents. A journal viewer/forget UX is
  charted, not built.
- **D8 (2026-09-15) — Budget/turn ceilings are per-OPEN; transcripts are
  durable.** A restored child gets fresh guards at open with the dispatch's
  ceilings; no cross-restart budget accounting is promised or built. The
  journal restores CONTEXT, not enforcement state.
- **D9 (2026-09-15) — agentId continuity: none across restore.** The new
  dispatch's `toolCallId` becomes the agentId (existing shape,
  `spawnLiveAgentFirstExchange` `open.agentId`); run records already link by
  `agentName` (`subagent-run-persistence.ts:257-263`). The NAME is the stable
  journal key; agentId is per-process by design.
- **D10 (2026-09-15) — Model policy + receipt discipline (carried,
  shares arc-25 D9/D10)**: GLM-5.3 every leg, flash excluded by name; pinned
  dirs (PB-08), bundle greps (PB-09), PRE-fix pairing (PB-10), frozen checks
  (PB-11), passive attribution (PB-12), preserved fails + capped retries +
  dated defers (PB-13/PB-14), gaps never passes (PB-15), committed evidence
  (PB-18). DeepSeek-outage lane fallback per
  `e2e-core-tool-roundtrip.test.ts:76-80` documented in the receipt when used.
- **D11 (2026-09-15) — PR structure: t01 then t02 as separate PRs (shared
  files, sequential diffs), t03 receipts-only, t04 close-out.** t01 is
  independently mergeable (journal written, never read); t02 builds on the
  merged read helpers. Collapsing t01+t02 is allowed only if review load
  demands it (arc-25 D7 clause) — the PR body must say so.

## Frontier

**t01** — the only ticket with a buildable surface that has no dependency on
t02; its PRE-fix receipt (PB-10) can be captured on the branch build the
moment the journal module exists. Start by syncing the tree (**PB-01**) and
running the pi-version check (Scope OUT, cadence carry-over), then re-read
`src/persistent-agent.ts` `send()` finally + `spawnLiveAgentFirstExchange`
against this map's anchors (drift check). t02 strictly after t01 merges; t03
after both; t04 last.

## Fog of war

- **Same-name-same-cwd era collision**: a NEW agent intentionally reusing a
  completed agent's name+cwd silently inherits that transcript (that IS the
  feature) — but there is no force-fresh escape hatch today (no `resume`
  param by D4). Mitigation for now: a different name, or delete the journal
  file. Charted: a `list_subagent_runs`-family journal action (list/delete).
- **Journal growth per child**: entries grow unboundedly within one child
  (whole-file rewrite per settle); pi's compaction entries are respected at
  context-build (`buildContextEntries`), but the FILE keeps full history.
  Last-N bounds the file COUNT, not size. Watch in t03 receipts; a size cap
  is a successor decision if journals balloon.
- **getSessionStats() on a restored session** may count prior messages
  (stats derive from session content) — D8 documents per-open guards; if t02
  tests show restored stats inflating first-exchange `usage` deltas, record
  the observed semantics as a Correction, do not fix silently.
- **pi upgrade cadence**: `npm view` at t01 open (Scope OUT). If a pi
  release lands mid-arc, `session-manager` API churn would touch exactly
  this arc's seam — defer the bump, note the version measured in receipts.
- **TUI/`list_subagents` surface is journal-unaware**: the roster shows
  in-process agents only; a restored child looks like any new agent (the
  notice line is the only signal). Fine for this arc; charted.
- **`current` symlink motion + sibling worktrees** (standing): receipts pin
  immutable dirs; siblings `../video_generation__memory`, `../video_generation__movie`
  off-limits.
- **Carried**: win32-x64 cross-deploy e2e flake under load (arc-25/26);
  deploy-report dependency stamping (queue rank 4).

## Successor next-goal sketch (t04 writes the real one, strict v2)

Queue candidates ranked from the current head's remaining ranks + this arc's
gaps: (1) trust-UX persistence decision + mini-ticket (rank 2 — the D7
read-only boundary decision must be written down before code); (2)
host-security option (a) arc (rank 3 — this arc's trust receipts are part of
its evidence base); (3) deploy-report dependency stamping (rank 4); (4)
win32-x64 e2e stability (rank 5); (5) journal viewer/forget UX + per-child
size cap IF t03 receipts show either biting. Focus scope stays the
subagent-durability + deploy-truth axis.

## Shipped-as

(to be filled by the close-out PR — merged PR numbers per ticket, t03
receipts path, corrections section if any planning claim broke)

## Cross-effort links

- **Builds-on:** `2026-09-14-self-arc-25-pi-upgrade-subagent` — D8 charted
  this exact arc ("journaling FileEntry[] + restore-on-parent-restart is a
  new persistence layer — honestly a successor arc") and shipped the 0.85.1
  upgrade + t06/t07 receipt discipline this arc's t03 copies; its Corrections
  (#2 exit-code gating, #4 bump-at-close-out rule) are adopted as standing.
- **Builds-on:** `2026-09-15-self-arc-26-project-trust-wiring` — its
  close-out named this arc the queue head (rank 1) and its t02 leg pattern
  (pinned dir + pre-drive greps + lane fallback) is t03's mold.
- **Shares-decision-with:** `2026-09-14-self-arc-25-pi-upgrade-subagent` D9
  (GLM-5.3-only model policy — D10 here) and D10 (receipt discipline);
  `2026-09-15-self-arc-26-project-trust-wiring` D2-style cwd anchoring (the
  restore cwd guard anchors at the dispatch cwd, same "the cwd that supplied
  the state" invariant).
- **Sibling-not-touched:** `../video_generation__memory`,
  `../video_generation__movie`.
