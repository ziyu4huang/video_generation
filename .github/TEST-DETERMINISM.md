# Test Determinism Audit

> The cross-RUN companion to [TEST-PORTABILITY.md](TEST-PORTABILITY.md). Where
> the portability audit catalogs "works on my machine" (cross-MACHINE) failures,
> this file catalogs "green on one run, red on the next" (cross-RUN) flakes —
> the class that turns a mandatory gate into a source of false blocks.
>
> **Audit script:** [`scripts/test-determinism-audit.sh`](../scripts/test-determinism-audit.sh)
> greps the four signal patterns below and classifies each hit `CONTROLLED` /
> `UNCONTROLLED`. Re-running it reproduces this catalog mechanically.

## Why this exists

Branch protection now **requires 20 checks** on `main` (strict, enforce_admins).
A mandatory gate + hidden flakes = PRs blocked on nondeterminism. The
portability cycle (#383) made green mean "portable"; enforcement made it
unavoidable; **neither made it reliable across runs.** This audit + the fixes
below close that: the four cross-RUN failure classes are retired, and a
determinism spot-check catches regressions.

### The four failure classes (and the proven fix seam for each)

| class | signal | why it flakes | fix pattern (proven in-tree) |
|-------|--------|---------------|------------------------------|
| **D1 uncontrolled time** | `Date.now()`/`new Date()`/`.mtime` asserted against the wall-clock | "seconds ago" / file-freshness drifts with the clock | inject a clock seam (`relativeTime(iso, now)`) or assert on **relative/delta** values; never the wall-clock |
| **D2 real host-state writes** | a portable test writes to the real `~/.pi/`, `~/.config`, vault, or model dir | races with live sessions/self-improve runs; corrupts host state on a crash | **tmpdir injection seam** (`mkdtempSync`, `PI_CODING_AGENT_DIR`, `__setAgentRootForTest`, `__setConfigPathForTest`) |
| **D3 cross-file ordering** | the `node:test` hang that forced a one-process-per-file workaround | the workaround masks a real shared-state/handle leak | close the handles (`dbManager.close()`) so the suite runs single-process; retire the workaround |
| **D4 live network** | `fetch()`/`http://`/`127.0.0.1` not wrapped in a mock/skip | the service is down / rate-limits / returns different data per run | mock `globalThis.fetch` (the `zai.test.ts` pattern) or `skipIf` when unreachable (the `semanticSearch` graceful-`isError` pattern) |

## How to run the audit

```bash
bash scripts/test-determinism-audit.sh            # report (warn-only; exit 0)
bash scripts/test-determinism-audit.sh --strict   # exit 1 on any UNGATED D2 hit
```

The script scans `bun-apps/**/*.{test.ts,test.mjs}` (excluding `node_modules`
and `dist`) for the four patterns and classifies each file by whether it uses a
control signal (a clock seam / tmpdir / mock).

- **D2 blocks under `--strict`** — a portable test writing to the real host is
  reliably a determinism AND safety bug. D2 additionally requires a write-op /
  store-DB construction to **co-occur** with the host-path reference, so a bare
  `AGENT_ROOT`/`homedir` in a comment or a path-construction assertion does NOT
  count (how the audit stays low-false-positive).
- **D1 / D4 are review-only** — a `Date.now()` is often a benign fixture seed,
  and a live-network call needs structural analysis (is it behind a skipIf / a
  mocked lookup?) a line-grep can't do without prohibitive false positives.
  This catalog is the human-reviewed disposition; the script surfaces them for
  review but never blocks.

## Audit result (2026-07-09, this cycle)

Scanned **268** test files. Every finding has a disposition — none ambiguous.

### D1 — uncontrolled time — **20 files flagged, 1 `fixed`, 19 `controlled (benign seed)**

A `Date.now()`/`new Date()` is a flake risk ONLY when an assertion depends on
the wall-clock. Most flagged files use time as a stable **fixture seed** (a
message timestamp, a run-record field) that is never compared to "now" — those
are deterministic by construction and dispositioned `controlled (benign seed)`.

| file | use of time | disposition |
|------|-------------|-------------|
| `gui-movie-director/frontend/utils/format.test.ts` | `relativeTime` asserted "just now"/"5m ago"/"2h ago" against the wall-clock | **fixed** — `relativeTime(iso, now)` now takes an injectable clock (default `Date.now()`); tests pass a fixed `NOW`. The `formatDate` case uses a fixed ISO string |
| `pi-hermes-memory/tests/store/{session-parser,session-backfill}.test.ts`, `store/session-indexer.test.ts` (seed lines) | `timestamp: Date.now()` as a message fixture seed | **controlled (benign seed)** — never asserted against "now"; the indexer's own assertions use fixed `new Date('2026-05-03T…')` dates |
| `pi-hermes-memory/tests/store/session-indexer.test.ts` (needsBackfill lines) | `needsBackfill(…, new Date('2026-05-03T01:00:00Z'))` | **controlled** — fully fixed literal dates; no wall-clock |
| `pi-hermes-memory/tests/store/{memory-store,sqlite-memory-store}.test.ts` | `new Date()` for `dateDaysAgo()` fixture / today's date in a row | **controlled (benign seed)** — derives relative day offsets, not wall-clock assertions |
| `s2-agent-ext-workflow/tests/{workflow-manager,run-persistence,task-panel}.test.ts` | `startedAt/updatedAt/completedAt: new Date().toISOString()` fixture fields | **controlled (benign seed)** — record-shape fixtures; tests assert structure/ordering, not "now" |
| `s2-agent-ext-workflow/tests/workflow-{parser,runtime}.test.ts` | `Date.now()`/`new Date()` only inside **string literals** fed to the parse-time determinism guard (which REJECTS them) | **controlled** — these tests *enforce* determinism (the guard rejects `Date.now`/`Math.random` in workflow scripts); the literal is the test input, not a clock |
| `pi-obsidian/extensions/__tests__/expectedMtime.test.mjs`, `indexCoherence.test.mjs` | `new Date(floor(now/1000)*1000 + 60_000)` → a **future** mtime SET via `utimes`, then compared to the value read back | **controlled** — deterministic relative computation (set + read the same derived future value) |
| `pi-obsidian/extensions/__tests__/{createGuard,errorCodes}.test.mjs` | `expectedMtime: st.mtimeMs` (the file's own just-set mtime) | **controlled** — read from the fixture file, not the wall-clock |
| `pi-obsidian/extensions/__tests__/subagentRobustness.test.mjs` | `Date.now() - t0` elapsed measurement | **controlled (benign seed)** — `dt` is computed but the assertions are on result *shape* (`output`/`stderr`/`timedOut`), not elapsed time |
| `s2-agent/src/cli/__tests__/schema-cost.test.ts` | `join(tmpdir(), …-${Date.now()}.ts)` | **controlled (benign seed)** — uniqueness seed for a tmpdir filename |
| `gui-movie-director/{scripts/gui-port,lib/gallery-index}.test.ts` | `startedAt: Date.now()` / `createdAt: new Date().toISOString()` fixture fields | **controlled (benign seed)** — record-shape fixtures, not wall-clock assertions |
| `s2-agent/src/__tests__/e2e-image-agent.test.ts` | `statSync(p).mtimeMs >= sinceMs` (file-freshness) + `Date.now()-2000` | **controlled** — opt-in e2e (`PI_AGENT_E2E_IMAGE`); skips on CI |

> The classifier still flags the 19 benign-seed files as UNCONTROLLED because
> they have no clock seam — that is correct (they touch time) and harmless
> (they don't assert on it). D1 is review-only by design; this table is the
> disposition. **Net drift-risk reduction: the one genuine wall-clock assertion
> (`relativeTime`) is now injected.**

### D2 — real host-state writes — **0 UNCONTROLLED (`--strict` clean)**

Two real hits were found by the audit and fixed this cycle:

| file | was | disposition |
|------|-----|-------------|
| `s2-agent-ext-power-tool/src/ask-user/__tests__/config.test.ts` | wrote to the **real `~/.config/rpiv-ask-user-question/config.json`** via `process.env.HOME`; the module read via `os.homedir()` (Bun ignores `HOME`) → read/write divergence + host pollution | **fixed** — added `__setConfigPathForTest` seam to `config.ts`; the test writes+reads a per-test tmpdir. Verified: real `~/.config` untouched after run |
| `pi-hermes-memory/tests/integration/flow.test.ts` | constructed `new MemoryStore(loadConfig())` with no `memoryDir` → would resolve to the real `~/.pi/agent/pi-hermes-memory` if a write were ever added | **fixed** — added `__setAgentRootForTest` seam to `paths.ts`; the file points `AGENT_ROOT` at a tmpdir for its whole lifetime (latent footgun closed) |

**Durable seams added this cycle (reusable infra — every future hermes/ask-user
test writes to a tmpdir, not the real store):**
- `paths.ts`: `AGENT_ROOT` is now a live-binding `let` + `__setAgentRootForTest(root)`.
- `config.ts`: `__setConfigPathForTest(path)` overrides the config read path.

The other 13 D2 files are `controlled` (route through `mkdtemp`/`tmpdir`/an
existing seam). The audit's write-op co-occurrence filter drops the benign
path-construction assertions (`resources-discover`, `project` — pure
`path.join(AGENT_ROOT, …)` expected-value strings, no write) and the
constant-string assertion (`utils.test.ts` asserts a `~/.pi/…` literal).

### D3 — cross-file shared state / ordering — **`fixed` (root-caused; per-file tsx isolation retained)**

`pi-hermes-memory` runs **one tsx (Node) process per file** (`tests/run-all.sh`).
Two root-caused reasons a single `bun test` is NOT acceptable for the gate:

1. **The hang (single-process concurrency).** `bun test` runs test files
   **concurrently on a shared thread**. This package mixes **synchronous native
   SQLite** (better-sqlite3, in `db`/`session-indexer`/`skill` tests) with
   **async file-I/O** tests (`memory-store`). The synchronous SQLite ops block
   the main thread and **starve the async fs callbacks** of `memory-store`'s
   atomic-write path (`saveToDisk`: `mkdtemp` → `writeFile` → `rename`). Under
   contention this intermittently stalls the *“handles very long entry near
   char limit”* test for **~900 s (15 min)** — a cross-RUN flake. Reproduced:
   `memory-store.test.ts` alone = clean 30 s; full single-process `bun test` =
   intermittent 900 s stall (and an occasional 1-test fail).
2. **The bun+linux quirk.** `bun test` runs all 585 tests fine on **macOS**, but
   bun’s `better-sqlite3` binding **fails the corruption-recovery test** on the
   CI runner (`db.test.ts`: *“repairs recoverable corruption on open and
   preserves readable rows”*) — it recovers rows differently than Node’s
   binding on ubuntu-latest. (This is the grain of truth behind the old vault
   card “better-sqlite3 unsupported by bun”: not unsupported, but not
   byte-identical to Node on linux.) tsx (Node) passes it on every platform.

**Fix (criterion 4 option b — workaround retained, root-caused):** per-file
**tsx (Node) process** isolation is retained — it avoids BOTH the shared-thread
starvation (each file gets its own event loop) and the bun+linux corruption
quirk (Node’s binding is the reference). PROVEN reliable (#383–#391 green).
`run-all.sh` is updated with the accurate dual root-cause (the old
*“node:test runner hang”* comment was a misdiagnosis — node:test was never the
problem; it was bun’s concurrency + binding).

> A single `bun test` is fine for a **quick local check on macOS** (585 pass,
> ~32 s), but the CI gate MUST use `bash tests/run-all.sh` (tsx). The
> determinism spot-check uses the runner for the same reason (and its CI job
> sets up Node for tsx).

### D4 — live network — **0 live `fetch()` in portable tests**

The audit's D4 pattern is broad (matches any URL/localhost string), so it flags
14 files. Manual review confirms **none makes a real network call** — they are
URL **strings** (parsed, scanned, or asserted as config values) or use a mocked
transport:

| pattern | files | disposition |
|---------|-------|-------------|
| URL as data fed to a pure string parser/scanner | `content-scanner`, `flow`, `web-tools`, `saved-commands`, `pure-helpers`, `ingest`, `resolve` | **controlled** — `scanContent("curl https://evil.com/…")`, `parseCommandArgs("https://…")`, `normalizeFetchContentParams({url})` — pure functions, no socket |
| URL/host as an asserted config value | `review-memory-ops` (`CUSTOM_BASE_URL` env passthrough), `pre-load-providers` (`baseUrl` matches `/localhost:/`), `shared.test.ts` (`BAKED_BASE_URL`) | **controlled** — asserts a config *string*, no request |
| mocked DNS transport | `ssrf-protection.test.ts` | **controlled** — `validateRemoteUrl(…, { lookup: lookup(addr(…)) })` injects a fake resolver; no real DNS |
| `127.0.0.1` in port-parsing / fake-Request fixtures | `gui-port`, `gui-registry`, `gallery` | **controlled** — parses a port string / hands a fake `Request` to a handler; no socket |

The genuine network tests are in the `CONTROLLED` set:
- `zai.test.ts` mocks `globalThis.fetch` (save/restore `ORIG_FETCH`).
- `semanticSearch` degrades gracefully (returns `isError` when vault-mind is
  unreachable).
- The only real `fetch()` calls in the whole test surface are reachability
  probes in `s2-agent-ext-power-tool/src/__tests__/l2-e2e.test.ts`, which is
  opt-in (`PI_RUN_L2 === "1"` + a preflight reachability gate) — the e2e set,
  not a portable test.

## Thrust B — the four classes, retired

1. **Real host-state (D2):** the two real writers fixed; durable tmpdir seams
   added. `--strict` is clean. **None remaining.**
2. **Cross-file ordering (D3):** root-caused (TWO reasons — concurrent
   synchronous SQLite starves async file-I/O on a shared thread → ~900s stall;
   AND bun’s better-sqlite3 binding fails the corruption-recovery test on
   ubuntu). Per-file tsx (Node) isolation retained (proven on CI). A single
   `bun test` is a fine macOS-only local check. **Gate flake eliminated.**
3. **Uncontrolled time (D1):** the one wall-clock assertion (`relativeTime`)
   is injected; the rest are benign fixture seeds. **None remaining.**
4. **Live network (D4):** zero live `fetch()` in portable tests; the real
   network tests mock or skipIf. **None remaining.**

## Prevention (Thrust C)

- **Audit script** runs in CI as a **warn-only** `regression-gates` step (D2
  blocks under `--strict` once trusted). See the rollout note below.
- **Determinism spot-check** job runs the flake-prone subset 3× in sequence
  and fails if any run differs from the others — the detection backstop. See
  the `determinism spot-check` job in `ci.yml`.
- **Test-author guide:** [CI.md § Test-author determinism guide](CI.md#test-author-determinism-guide).
- The determinism + portability guides together form the complete "how to write
  a CI-safe test" contract: **portable (cross-machine) + deterministic (cross-run).**
