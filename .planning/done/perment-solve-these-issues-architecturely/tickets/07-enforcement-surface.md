# 07 — Enforcement surface: turn the invariant into a check, not a memory

## Question

Where does the convergence-completeness check **LIVE** so it's enforced
(structural) rather than remembered as scar-tissue? This is the "turn each
memorized avoidance into an enforced check" step for THIS subsystem — the
destination is only trustworthy if drift is caught by a gate, not by an agent
recalling a lesson.

### Candidates

- **(a) CI job.** A workflow runs `coverageReport` + `healthGate` over the
  vault and fails on `missing` / `sourceOrphaned` / dead-links beyond a
  threshold. Drift is caught at PR time.
- **(b) `/memory-health` command.** Surfaces true convergence state (coverage %
  + last receipt + dead-links/orphans) on demand — informational, not
  blocking. (Partially exists today — "now surfaces it" per memory.)
- **(c) Pre-commit / pre-merge hook.** Local gate before a converge-affecting
  change lands.
- **(d) Shutdown receipt.** The auto-converge hook writes a receipt a later
  `/memory-health` reads — closes the silent-fail gap (interacts with T03).

### Decide

- Blocking (CI) vs informational (health cmd) vs both? Given the user picked
  the broad trustworthy-convergence scope, likely (a) + (b).
- The gate threshold: 0 `missing`? allow N legacy until T05 migration runs?
- Does enforcement run against the primary worktree's vault only (dev
  worktrees have the disconnected-vault problem — T04)?

type: grilling
claimed: wayfinder-session
blocked by: 03
status: closed

## Resolution (closed this session)

**`/memory-health` command as the primary enforcement surface; CI deferred.**

**Finding (facts):**
- `/memory-health` does **not** exist (the ticket's "partially exists today" note
  was stale).
- No CI workflow touches convergence today (only `ci.yml`; zero references to
  coverage / healthGate / merge-duplicates / kcard).
- All primitives exist and are reusable: `coverageReport` (`ingest.ts:1208`),
  `healthGate` (`loop.ts:140`), `zk-query --health` (CLI), `ConvergeReceipt`
  (`kcard-loop.ts` + `loop.ts`).

**The structural insight:** the completeness invariant (`missing = 0`) is a
**runtime property** — `coverageReport` compares vault cards against LIVE
sources (hermes `.md` in `~/.pi/memory`, auto-memory), which are NOT committed.
Only workflow `.knowledge.jsonl` is committed. So a CI gate can check at most
the committed families, not the hermes/auto flow (the real memory path). It
cannot be enforced at PR time.

**Decision — `/memory-health` is the primary surface:**
- Reads the **T03 shutdown receipt** (`.pi/kcard-last-receipt.json`) for the
  last-run state (timestamp, converged count, any swallowed failures).
- Runs a **LIVE `coverageReport` + `healthGate`** (vault + live sources) for the
  current state — the only place `missing = 0` is meaningfully checkable.
- Surfaces: coverage % by family (missing / sourceOrphaned), last receipt,
  dead-links, orphans.
- Runs locally via **T04's `resolveVault`** — primary worktree only; dev
  worktrees' disconnected vaults are skipped + reported (per T04).
- Excludes **`_archive/`** from the active set (the T05 flag) so superseded
  losers don't count as active/sourceOrphaned.

**"Enforced, not remembered" — interpretation:** the convergence loop runs every
shutdown (T03) and writes the receipt; `/memory-health` surfaces it; the agent /
self-improve loop is **instructed (a skill/convention) to run it**. For a
runtime property, enforcement = recurring loop + visible receipt, not a PR gate.
This is the honest answer — a PR gate literally cannot see the live invariant.

**CI deferred** (not pursued now): a CI job could only check committed-snapshot
**structural** hygiene (dead-links, `mergeDuplicates --dry-run` over the vault
submodule) and would lag behind the submodule's own PRs. Marginal value until
the vault submodule gets its own CI. Revisit if committed drift becomes real.

**Threshold:** `missing = 0` (the T03 invariant); `sourceOrphaned` reported not
gated (per T03). Until the T05 migration runs, legacy `pi-memory:*`
sourceOrphaned is allowed (reported). After T05, `_archive/` excluded.

**Build includes:**
- New `/memory-health` command (`pi-agent-cli`) — surfaces T03 receipt + live
  coverageReport + healthGate; uses `resolveVault` (primary only); excludes
  `_archive/`.
- A skill/convention entry instructing the agent to run `/memory-health`
  (enforcement-via-visibility).
- CI job — NOT now (deferred per above).

**No new tickets; does not graduate fog.** The remaining fog ("does `zk_ask`
need change once the vault is clean?") becomes verifiable only AFTER the T05
migration actually runs.
