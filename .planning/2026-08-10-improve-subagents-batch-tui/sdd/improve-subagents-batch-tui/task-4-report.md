# Task 4 Report — done-expanded per-child meta line

**Branch:** `feat/improve-subagents-batch-tui`
**Base:** `bd34ab1d` → **Head:** `8c4800d3`
**Commit:** `feat(subagent): batch-tui done-expanded per-child meta line (T4)`

## What changed (implementation)

`renderSubagentsResult`'s expanded branch (`.map((slot, i) => { … })` in
`bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts`, ~line 778) now prepends a
`formatSlotMeta` line above each child's output.

The shared meta line is computed once per non-null slot:

```ts
const metaLine = formatSlotMeta(
  slot as { model: string; requestedModel?: string; fellBack?: boolean; elapsedMs: number; usage?: AgentUsage },
  theme,
);
```

…and inserted directly under the `### [i] (id) status` header, above the body, for
the three carrying-`return`s.

### States that get a meta line

| Slot variant          | Meta line? | Rendered block (expanded) |
|-----------------------|------------|---------------------------|
| `done`                | ✅ yes      | `### [i] (id) done` / `metaLine` / `output` |
| `timedout`            | ✅ yes      | `### [i] (id) timedout` / `metaLine` / `output` |
| `aborted`             | ✅ yes      | `### [i] (id) aborted` / `metaLine` / `_(user-aborted mid-flight)_` |
| `budget` (child/batch)| ✅ yes      | `### [i] (id) skipped — <label>: …` / `metaLine` |
| `null` (failed)       | ❌ unchanged | `### [i] failed` / `_(null — child failed; re-run via …)_` |

`formatSlotMeta` (T2) degrades to `model · elapsed` when `usage` is absent
(e.g. budget/aborted slots with no usage) — matches the single-card parity contract.
Single-space ` · ` separators throughout, consistent with T3 and the single-card reference.

## Existing fixtures updated

**None.** No pre-existing test assertions were edited. All 52 pre-existing tests in
`tests/subagents-tool.test.ts` pass unchanged, including the pre-existing
`"renderSubagentsResult expanded"` test (the new meta line is additive; its fixture
has no usage → `flash · 3.5s`, which the existing loose assertions don't contradict).
Three new tests were appended (T4 block).

## Tests

**Command:** `( cd bun-apps/pi-agent-ext-subagent && bun test )`
**Result:** ✅ `496 pass · 0 fail` across 31 files (incl. the 3 new T4 tests).

## Gate

**Command:** `( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build )`
(`check` = `biome check .`; `build` = `tsc` + emit)
**Result:** ✅ green — biome "No fixes applied", `tsc` clean, build exit 0.

## ⚠ Deviation from the verbatim brief (read this)

The brief's verbatim **implementation** was transcribed exactly (the source diff is
the brief's `.map` body verbatim; see commit). However, **two of the brief's three
verbatim test assertions are mechanically wrong** and could not pass against the
brief's *own* spec-correct implementation. They were corrected minimally. Details:

### Background — expanded layout is `header\n\n` + body

`renderSubagentsResult` returns `` `${theme.bold(header)}\n\n${body}` ``. With the
identity test theme, the expanded output for the T4 fixture is (JSON-quoted, blanks
made visible):

```
"subagents batch (1 ok · 0 failed · 0 skipped) — 34.5s · $0.000 · 15715 tok\n\n### [0] (a) done\nglm-5.2 · 34.5s · $0.000 · 15715 tok\nFull audit report\nLine two"
```

Line index map:

```
lines[0] = "subagents batch (1 ok · 0 failed · 0 skipped) — 34.5s · $0.000 · 15715 tok"  (batch header)
lines[1] = ""                                                                            (blank, from \n\n)
lines[2] = "### [0] (a) done"                                                            (slot header)
lines[3] = "glm-5.2 · 34.5s · $0.000 · 15715 tok"                                       (META — correct, per spec)
lines[4] = "Full audit report"                                                           (output)
```

The brief's render-target cell spec is `### [i] (id) status` **+ meta line** **+ output**
— i.e. meta comes *after* the `###` header. The implementation matches this exactly.

### Fix 1 — test "prepends a `model · elapsed · $cost · Ntok` meta line…"

Brief verbatim:
```ts
assert.match(lines[1] ?? "", /glm-5\.2 · 34\.5s · \$0\.000 · 15715 tok/, "meta line sits directly under the ### header");
```
`lines[1]` is the blank line between the batch header and the body (`""`), so this
assertion can never match. The meta is at **`lines[3]`**. This is an off-by-2: the
planner reasoned about the *body* in isolation (body line 1 = meta, under body line 0
= `### [0]`), forgetting the `header\n\n` prefix shifts everything by two lines.

Applied (minimal): `lines[1]` → `lines[3]`. The regex content is unchanged. An inline
`NOTE (T4 brief fix)` comment documents the rationale at the assertion.

### Fix 2 — test "budget + aborted slots get a meta line too…"

Brief verbatim:
```ts
assert.match(expanded, /glm-5\.2 · 0\.8s[\s\S]*skipped/);
assert.match(expanded, /glm-5\.2 · 0\.3s[\s\S]*aborted/);
```
Both require **meta THEN status-word**. But the spec'd layout is
`### [i] skipped — …` (status word in the `###` header) **then** `metaLine` on the
next line — i.e. **status-word THEN meta**. The brief's order is reversed, so neither
regex can match. Concrete (from the failure output):

```
### [0] skipped — child budget: tokens 2000 > 1000
glm-5.2 · 0.8s              <- meta appears AFTER "skipped", not before
…
### [1] aborted
glm-5.2 · 0.3s              <- meta appears AFTER "aborted", not before
```

Applied (minimal): reverse both sequences → `/skipped[\s\S]*glm-5\.2 · 0\.8s/` and
`/aborted[\s\S]*glm-5\.2 · 0\.3s/`. Strength is equivalent to the original (both are
loose whole-string `[\s\S]*` co-occurrence checks); neither weakens nor deletes the
assertion. An inline `NOTE (T4 brief fix)` comment documents the rationale.

### Why DONE_WITH_CONCERNS rather than verbatim-blocked

The brief's render-target cell spec disambiguates which side is correct
(implementation = right; tests = wrong), so this is **not genuine ambiguity** — it's a
fixable brief typo-class error (wrong array index; reversed regex sequence). The
implementation needed no judgment and is transcribed verbatim. The two test
corrections are the minimum mechanical changes needed to make the assertions match
their own stated intent (assertion message: "meta line sits directly under the ###
header") and the spec. They are recorded inline + here for trivial review/revert.

## Commits

- `8c4800d3` — `feat(subagent): batch-tui done-expanded per-child meta line (T4)`
  - `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (verbatim brief impl)
  - `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts` (3 new tests; 2 minimal assertion fixes + biome wrap)

`base..head = bd34ab1d..8c4800d3`.
