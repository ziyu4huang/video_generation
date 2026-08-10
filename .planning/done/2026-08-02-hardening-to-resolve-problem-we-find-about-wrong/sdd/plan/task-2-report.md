# Task 2 Report — Harden the boundary text (core fix, ADR-0006)

**Status:** DONE
**Commit:** `a906f40c8adb987ec53036bf2f68e1fd58656c10`
**Summary:** Made the no-upstream-path rule unconditional (no "when an effort is active") and added the auto-dated no-effort default `.planning/<YYYY-MM-DD>-<slug>/` to the bootstrap payload; tightened wording to keep the routing section under the 2000-char invariant.

---

## What I did, per step

### Step 1 — Added the 3 failing assertions

In `bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts`, inside the existing
`it("carries the Pipeline routing …")` block, appended (verbatim from the brief, before the
closing `});`):

```ts
    // ADR-0006: the no-upstream-path rule is UNCONDITIONAL, not effort-gated
    expect(payload).not.toContain("when an effort is active");
    expect(payload).toContain("with or without an active effort");
    // no-effort default: the model derives a dated effort dir (ticket 01)
    expect(payload).toContain(".planning/<YYYY-MM-DD>-<slug>/");
```

### Step 2 — Verified the test FAILS (red)

Command: `bun test --cwd bun-apps/pi-agent-ext-superpowers tests/bootstrap.test.ts`

Excerpt (the first failing assertion, as predicted):

```
201 |     expect(payload).not.toContain("Visual-companion convergence");
202 |     // note: "SDD workspace" the bare topic word legitimately remains in rule 1;
203 |     // only the retired header phrase "SDD workspace override" must be gone
204 |     expect(payload).not.toContain("SDD workspace override");
205 |     // ADR-0006: the no-upstream-path rule is UNCONDITIONAL, not effort-gated
206 |     expect(payload).not.toContain("when an effort is active");
                              ^
error: expect(received).not.toContain(expected)

Expected to not contain: "when an effort is active"
Received: "<EXTREMELY_IMPORTANT> … Never write to the upstream paths when an effort is active. …"

      at <anonymous> (.../tests/bootstrap.test.ts:206:25)
(fail) bootstrap payload assembly > carries the Pipeline routing (2-rule boundary convergence, ADR-0004-safe) [0.19ms]
(pass) bootstrap payload assembly > routing section is meaningfully shorter than the old 3039 chars [0.03ms]

 10 pass
 1 fail
 62 expect() calls
Ran 11 tests across 1 file. [14.00ms]
```

`not.toContain("when an effort is active")` fails first, exactly as the brief predicted.

### Step 3 — Edited the boundary text in `src/superpowers.ts` (`piBoundaryOverrides()`, line 265)

Note on implementation: the boundary text lives inside a JS template literal, so every
backtick in the source is escaped as `\``. I performed the replacement with a Python
script using byte-level matching (occurrence count asserted `== 1` before writing) to
avoid JSON/string-escaping ambiguity.

The brief's verbatim newText initially ballooned the routing section to **2159** chars
(over the 2000 invariant; see Step 4's first run below). The brief explicitly authorizes
tightening in that case, so the **final committed** replacement (old → new) is:

**Old substring (removed):**
```
The pinned skills' upstream paths (`docs/superpowers/`, `.superpowers/sdd/`) are overridden at runtime by `PI_PLANNING_EFFORT`. Never write to the upstream paths when an effort is active.
```

**New substring (final, tightened):**
```
Upstream paths (`docs/superpowers/`, `.superpowers/sdd/`) are **never** written to, with or without an active effort. `PI_PLANNING_EFFORT` set → `.planning/<effort>/`; unset → derive `.planning/<YYYY-MM-DD>-<slug>/`.
```

The new text is **unconditional** (no "when an effort is active"), names `PI_PLANNING_EFFORT`
explicitly for the set/unset branch, and names the auto-dated no-effort default
`.planning/<YYYY-MM-DD>-<slug>/`. It satisfies all three Step-1 assertions. Tightening vs.
the brief's literal newText: dropped the redundant `The pinned skills' ` prefix (the section
is already about the pinned skills; the parenthetical names the paths), the
`(<slug>` = short kebab…`)` definition, the `Unset (ad-hoc)`/`resolve under`/`a dated dir`
filler, and the trailing `e.g. an ad-hoc spec to …/spec.md` example — semantics preserved
("derive" verb kept; the dated pattern is self-explanatory).

### Step 4 — Verified PASS (green), including the length invariant

First run with the brief's literal newText — the length invariant failed (as the brief
warned it might):

```
212 |   it("routing section is meaningfully shorter than the old 3039 chars", () => {
...
217 |     expect(section.length).toBeLessThan(2000);
                                 ^
error: expect(received).toBeLessThan(expected)
Expected: < 2000
Received: 2159
(fail) bootstrap payload assembly > routing section is meaningfully shorter than the old 3039 chars
```

After tightening (Step 3 final wording), re-ran — full PASS:

```
tests/bootstrap.test.ts:
(pass) superpowers extension wiring > registers exactly the upstream event hooks [0.14ms]
(pass) superpowers extension wiring > resources_discover returns the real package skills/ dir [0.25ms]
(pass) context bootstrap injection > injects the bootstrap when inject is active and it is absent [0.27ms]
(pass) context bootstrap injection > does NOT inject when the bootstrap is already present in messages [0.04ms]
(pass) context bootstrap injection > goes inert after agent_end (no further injection until session_start/compact) [0.07ms]
(pass) context bootstrap injection > session_compact also re-arms injection [0.06ms]
(pass) context bootstrap injection > inserts AFTER leading compactionSummary messages, not before them [0.07ms]
(pass) bootstrap payload assembly > getBootstrapContent returns non-null with marker + real skill body + Pi tool mapping [0.04ms]
(pass) bootstrap payload assembly > Pi tool mapping names the subagent ext's 'subagent' tool + its documented params [0.08ms]
(pass) bootstrap payload assembly > carries the Pipeline routing (2-rule boundary convergence, ADR-0004-safe) [0.10ms]
(pass) bootstrap payload assembly > routing section is meaningfully shorter than the old 3039 chars [0.04ms]

 11 pass
 0 fail
 64 expect() calls
Ran 11 tests across 1 file. [11.00ms]
```

Length-invariant detail — measured the routing section the same way the test does
(`payload.slice(payload.indexOf("## Pipeline routing"))`): **`ROUTING_SECTION_LENGTH=1986`**
(`< 2000`, `> 800`; margin 14 under the cap).

Safety net — full package suite also green (no collateral damage):

```
128 pass
 0 fail
227 expect() calls
Ran 128 tests across 6 files. [141.00ms]
```

### Step 5 — Verified ADR-0004 (no pinned skill body changed)

Command: `git diff --name-only -- bun-apps/pi-agent-ext-superpowers/skills/ | wc -l`

```
0
```

No file under `skills/` was touched.

### Step 6 — Scoped commit

Staged **only** the two scoped paths (verified via `git diff --cached --name-only`); the
unrelated working-tree changes (`.agents/memory/MEMORY.md`, `bun-apps/pi-agent-ext-tool-gate/PRD.md`,
and this effort's own `.planning/…/sdd/`) were left out.

```
git add bun-apps/pi-agent-ext-superpowers/src/superpowers.ts \
        bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts
git commit -m "fix(superpowers): unconditional artifact home — never upstream paths (ADR-0006)"
```

Post-commit `git status --short` confirmed only the unrelated changes remain in the tree:

```
 M .agents/memory/MEMORY.md
?? .planning/2026-08-02-hardening-to-resolve-problem-we-find-about-wrong/sdd/
?? bun-apps/pi-agent-ext-tool-gate/PRD.md
```

---

## `git show --stat HEAD`

```
commit a906f40c8adb987ec53036bf2f68e1fd58656c10
Author: Ziyu Huang <ziyu4huang@gmail.com>
Date:   2026-08-02 02:19:01 +0800

    fix(superpowers): unconditional artifact home — never upstream paths (ADR-0006)

 bun-apps/pi-agent-ext-superpowers/src/superpowers.ts      | 2 +-
 bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts | 5 +++++
 2 files changed, 6 insertions(+), 1 deletion(-)
```

---

## Concerns

- **Length margin is modest (14 chars under 2000).** The tightened newText lands the routing
  section at 1986 chars. It passes the `< 2000` invariant now, but Task 3's planned lint and
  any future edits to this section have little headroom. If a later task needs to add wording
  here, it should re-tighten or raise the cap deliberately rather than silently. Not blocking
  — the test passes and semantics are preserved.
- ** newText diverges from the brief's literal wording** (tightened to satisfy the 2000-char
  invariant, which the brief explicitly permitted). All three Step-1 required phrases are
  intact and the meaning is unchanged; flagged only for reviewer visibility.
