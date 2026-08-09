# Report — Task 2: `never-fired` finding + fires column in report

**Plan:** inspect-hooks-phase2-firing-counts · **BASE:** `0f0cdd30` (origin/main) · **Task 1:** `7867e7b4`

## What changed (additive only)

### `analyzeHooks` (`inspect-hooks.ts`)
After the existing findings (unknown-event-name → inventory → stats), a new loop emits a
**`never-fired`** finding (severity **`low`**) for each `HookRegistration` with `fired === 0`:

```ts
{ severity: "low", check: "never-fired",
  message: `${shortPath(ext.path)} handler on "${h.event}" never fired (0/${h.count})`,
  detail: { path: ext.path, event: h.event, count: h.count, fired: 0 } }
```

Shape mirrors the medium `unknown-event-name` finding exactly (`{severity, check, message, detail}`,
same `shortPath`). Docstring updated to list `never-fired (low)` in the ordering.

### `formatHooksReport` (`inspect-hooks.ts`)
- **fires column** added to BOTH inventory tables:
  - by-extension: per-extension aggregate `${fires}` (sum of `h.fired`).
  - by-event: per-event aggregate `${e.fires}` (added `fires` to the `byEvt` map accumulator).
- **never-fired section** (low): new `▶ 🟢 Low — never fired (N):` block rendering each finding's
  message, placed right after the medium unknown-event-name section. Mirrors how the medium section
  renders. The existing severity-summary header already tallies by severity (`summarizeFindings`),
  so low counts now automatically include never-fired — no header change needed.

### Tests (`inspect-hooks.test.ts`)
New pure-fn tests (5):
- `analyzeHooks` — `never-fired: emits a low finding ONLY for fired===0 entries` (mixed fired>0 /
  fired===0 → 2 findings; exact detail `{path,event,count,fired:0}` + message; fired>0 entry unflagged).
- `analyzeHooks` — `never-fired: NONE emitted when every hook fired > 0`.
- `formatHooksReport` — `never-fired section + fires column rendered when fired===0 exists`
  (asserts "fires", "2 fires", "Low — never fired", the never-fired message).
- `formatHooksReport` — `byEvent fires column aggregated per event` ("5 fires" = 2+3 across extensions).
- `formatHooksReport` — `never-fired section absent when all hooks fired > 0`.

Existing-test updates (additive — none weakened/removed):
- `return_json=true returns {findings, summary, snapshot}`: snapshot `turn_end fired:0` now also
  emits a never-fired finding, so `summary` changed from `{total:0,low:0}` → `{total:1,low:1}`.
  Snapshot/Array assertions unchanged. All other Phase-1 substring assertions stay valid unchanged
  (their substrings remain present; `.find()`/`.some()` filters are unaffected by the additive finding).

## Out of scope — untouched
- `sdk-patch.ts` (counting intercept) — NOT modified.
- `inspect-hooks.phase2.test.ts` (Task 1 integration tests) — NOT modified.
- `MEMORY.md` — NOT committed.

## Verification
- `bun run --cwd bun-apps/pi-agent-ext-power-tool typecheck` → **pass** (`tsc --noEmit`, clean).
- `bun run --cwd bun-apps/pi-agent-ext-power-tool test` → **pass: 159 pass / 4 skip / 0 fail**.
- inspect-hooks files: **27 pass / 0 fail** (19 `inspect-hooks.test.ts` incl. 5 new Task 2; 8
  `inspect-hooks.phase2.test.ts` Task 1).
- Phase 1 tests: green (all pre-existing assertions still pass).
- Task 1 `inspect-hooks.phase2.test.ts`: green (8/8).

## Known edge case (documented, NOT fixed)
A handler fn registered on multiple events shares its single WeakMap count, so `fired` may
over-report under each event. For `never-fired` this is safe (0 stays 0). Per spec — left as-is.

**Status:** DONE
