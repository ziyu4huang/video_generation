# Revision brief — Task 2 correction (route no-effort specs to flat `.planning/specs/`)

**Why:** Task 2's premise (wayfinder ticket 00, R2: "specs/plans have no path
override") was **incomplete**. `docs/superpowers/{specs,plans}` are git-tracked
symlinks → `.planning/{specs,plans}` (flat layout, active through 2026-08-01).
So the original "leak" was already mitigated, and Task 2's instruction to push
no-effort specs to *per-effort* dirs (`.planning/<YYYY-MM-DD>-<slug>/`) would
**fragment** standalone specs away from the flat `.planning/specs/` convention.

**User decision (2026-08-02):** revise Task 2 — keep the UNCONDITIONAL
no-upstream-path rule + the Task-3 lint, but route no-effort specs/plans to the
**flat** `.planning/specs/` and `.planning/plans/` (honoring the active
convention the symlinks alias).

---

## Change 1 — `src/superpowers.ts` `piBoundaryOverrides()` (the boundary text)

**Find the sentence currently in the file** (inside the template literal; note
the source has escaped backticks `\`` — match by content, not raw bytes):

> Upstream paths (`docs/superpowers/`, `.superpowers/sdd/`) are **never** written to, with or without an active effort. `PI_PLANNING_EFFORT` set → `.planning/<effort>/`; unset → derive `.planning/<YYYY-MM-DD>-<slug>/`.

**Replace it with exactly this** (preserve the template-literal backtick
escaping the surrounding code uses):

> Specs → `.planning/specs/<YYYY-MM-DD>-<topic>-design.md`, plans → `.planning/plans/<YYYY-MM-DD>-<topic>.md` (`docs/superpowers/{specs,plans}` symlink there — prefer the `.planning/` path). Other upstream paths (`docs/superpowers/`, `.superpowers/sdd/`) are never written. `PI_PLANNING_EFFORT` set → `.planning/<effort>/`.

The revised text MUST contain: `.planning/specs/`, `.planning/plans/`, the word
`symlink`, and must NOT contain `when an effort is active`. If the routing
section exceeds 2000 chars, tighten wording (drop a clause) — authorized.

## Change 2 — `tests/bootstrap.test.ts` (the 3 assertions Task 2 added)

**Find the 3 assertions Task 2 added** (inside the `it("carries the Pipeline routing …")` block):

```ts
    // ADR-0006: the no-upstream-path rule is UNCONDITIONAL, not effort-gated
    expect(payload).not.toContain("when an effort is active");
    expect(payload).toContain("with or without an active effort");
    // no-effort default: the model derives a dated effort dir (ticket 01)
    expect(payload).toContain(".planning/<YYYY-MM-DD>-<slug>/");
```

**Replace them with exactly:**

```ts
    // ADR-0006 (revised): no-effort specs route to the flat .planning/specs/
    // (docs/superpowers/{specs,plans} symlink there); other upstream paths forbidden
    expect(payload).toContain(".planning/specs/");
    expect(payload).toContain("symlink");
    expect(payload).not.toContain("when an effort is active");
```

## Change 3 — `docs/adr/0006-unconditional-artifact-home.md` (amend)

In the **Decision** section, replace the bullet:

> - `PI_PLANNING_EFFORT` unset (ad-hoc) → the model derives a dated effort dir `.planning/<YYYY-MM-DD>-<slug>/` (`<slug>` = short kebab of the topic).

with:

> - `PI_PLANNING_EFFORT` unset (ad-hoc) → specs land at `.planning/specs/<YYYY-MM-DD>-<topic>-design.md` and plans at `.planning/plans/<YYYY-MM-DD>-<topic>.md` — the flat layout `docs/superpowers/{specs,plans}` symlink to. (Per-effort `.planning/<effort>/` is for multi-ticket wayfind efforts, set via `PI_PLANNING_EFFORT`.)

And append to the **Context** section one sentence:

> Note (2026-08-02 amendment): `docs/superpowers/{specs,plans}` are git-tracked symlinks to `.planning/{specs,plans}`, so the flat layout was already the de-facto home for standalone specs; this ADR makes the boundary text say so explicitly rather than pushing them to per-effort dirs.

## Verify

- `bun test --cwd bun-apps/pi-agent-ext-superpowers tests/bootstrap.test.ts` → all PASS, including the `< 2000`-char routing-section invariant.
- `bun test --cwd bun-apps/pi-agent-ext-superpowers` → full suite green.
- `git diff --name-only -- bun-apps/pi-agent-ext-superpowers/skills/ | wc -l` → `0` (ADR-0004).
- Scoped commit (only the 3 files: `src/superpowers.ts`, `tests/bootstrap.test.ts`, `docs/adr/0006-unconditional-artifact-home.md`), message:
  `fix(superpowers): route no-effort specs to flat .planning/specs/ (ADR-0006 amendment)`
