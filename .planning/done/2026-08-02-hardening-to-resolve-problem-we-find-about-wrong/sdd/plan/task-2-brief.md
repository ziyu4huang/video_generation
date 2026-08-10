## Task 2: Harden the boundary text (the core fix)

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts` (existing test)
- Modify: `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts:~265` (`piBoundaryOverrides()`)

**Interfaces:**
- Consumes: `getBootstrapContent()` (exported from `src/superpowers.ts`) — already
  imported in `bootstrap.test.ts`.
- Produces: an unconditional no-upstream-path rule + the auto-dated-dir default
  inside the bootstrap payload.

- [ ] **Step 1: Write the failing test**

In `bootstrap.test.ts`, inside the existing `it("carries the Pipeline routing …",
() => { … })` block, add (before its closing `});`):

```ts
    // ADR-0006: the no-upstream-path rule is UNCONDITIONAL, not effort-gated
    expect(payload).not.toContain("when an effort is active");
    expect(payload).toContain("with or without an active effort");
    // no-effort default: the model derives a dated effort dir (ticket 01)
    expect(payload).toContain(".planning/<YYYY-MM-DD>-<slug>/");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test --cwd bun-apps/pi-agent-ext-superpowers tests/bootstrap.test.ts`
Expected: FAIL — the current text says "when an effort is active" and lacks the
two new phrases. (`not.toContain("when an effort is active")` fails first.)

- [ ] **Step 3: Edit the boundary text**

In `src/superpowers.ts`, inside `piBoundaryOverrides()`, replace this exact
substring:

```
The pinned skills' upstream paths (`docs/superpowers/`, `.superpowers/sdd/`) are overridden at runtime by `PI_PLANNING_EFFORT`. Never write to the upstream paths when an effort is active.
```

with:

```
The pinned skills' upstream paths (`docs/superpowers/`, `.superpowers/sdd/`) are **never** written to, with or without an active effort. `PI_PLANNING_EFFORT` set → resolve under `.planning/<effort>/`. Unset (ad-hoc) → derive a dated dir `.planning/<YYYY-MM-DD>-<slug>/` (`<slug>` = short kebab of the topic) and write there — e.g. an ad-hoc spec to `.planning/<YYYY-MM-DD>-<slug>/spec.md`.
```

- [ ] **Step 4: Run the routing tests to verify they pass (incl. the length invariant)**

Run: `bun test --cwd bun-apps/pi-agent-ext-superpowers tests/bootstrap.test.ts`
Expected: PASS, including `"routing section is meaningfully shorter than the old 3039 chars"`.
If the length test fails (> 2000), tighten the Step 3 wording (it adds ~+270 chars
net; the section was comfortably under 2000).

- [ ] **Step 5: Verify no pinned skill body changed (ADR-0004)**

Run: `git diff --name-only -- bun-apps/pi-agent-ext-superpowers/skills/ | wc -l`
Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/src/superpowers.ts \
        bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts
git commit -m "fix(superpowers): unconditional artifact home — never upstream paths (ADR-0006)"
```

---

