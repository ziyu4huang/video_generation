# Unified `.planning/` Directory + superpowers/wayfind Handoff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify wayfind + superpowers planning artifacts under `.planning/<effort>/` (effort = `YYYY-MM-DD-<slug>`), fork superpowers' 7 hardcoded `docs/superpowers/` paths via a self-contained patch+sync flow, flip `.gitignore`, and retarget wayfind's handoff to superpowers' execution skills.

**Architecture:** superpowers' 7 skill-file path strings fork to `.planning/<effort>/{spec,plan}.md`; the fork is recorded as a declarative patch table under `pi-agent-ext-superpowers/migrations/`, applied by `scripts/apply-patches.sh` (idempotent), and re-converged by `scripts/update-superpowers.sh` (syncs `skills/` from the plugin cache, then re-applies patches — the whole flow self-contained in the ext folder). `.planning/` becomes committed archive; only `task_plan.md`/`progress.md`/`findings.md` stay gitignored. wayfind gains `effortSlug()` (date-prefixed) for effort ids while `slugify()` stays bare for ticket slugs.

**Tech Stack:** Bash (patch/sync scripts, `perl -i` for literal substitution), TypeScript/Bun (wayfind `effortSlug` + tests), git (ignore rules, file moves).

## Global Constraints

- **Effort id format:** `YYYY-MM-DD-<slug>` (e.g. `2026-07-18-add-video-relay`). Date sorts chronologically; slug is `slugify()` of the human label.
- **Unified layout:** `.planning/<effort>/{spec.md, plan.md, map.md, tickets/, task_plan.md}`.
- **superpowers path fork mapping:** `docs/superpowers/specs/...` → `.planning/<effort>/spec.md`; `docs/superpowers/plans/...` → `.planning/<effort>/plan.md`. The `<effort>` token stays literal in skill prose.
- **Fork record lives in the superpowers ext folder:** `bun-apps/pi-agent-ext-superpowers/{migrations,scripts}/`. `bun-apps/pi-agent/update-pi.sh` is NOT modified (unrelated to superpowers).
- **No skill prose changes** beyond the 7 path strings. No skill dedup (wayfind keeps all 7).
- **Tests must stay green:** wayfind `bun test` ≥ 139 pass; goal-todo ≥ 106 pass. (goal-todo is untouched but shares the `.planning/` seam contract — re-verify.)
- **Scratch stays gitignored:** `task_plan.md`, `progress.md`, `findings.md` (root and `.planning/*/`).

## File Structure

**Create:**
- `bun-apps/pi-agent-ext-superpowers/migrations/unified-planning-dir.patch` — declarative substitution table
- `bun-apps/pi-agent-ext-superpowers/scripts/apply-patches.sh` — idempotent patch applier
- `bun-apps/pi-agent-ext-superpowers/scripts/update-superpowers.sh` — plugin-cache sync + re-patch
- `bun-apps/pi-agent-ext-wayfind/tests/effort-slug.test.ts` — `effortSlug`/`slugify` unit tests
- `.planning/2026-07-17-wayfind-pwf-unification/spec.md` — migrated from `docs/superpowers/specs/`
- `.planning/2026-07-17-wayfind-pwf-unification/plan.md` — migrated from `docs/superpowers/plans/`

**Modify:**
- `bun-apps/pi-agent-ext-superpowers/skills/brainstorming/SKILL.md` (L29, L106 — same string)
- `bun-apps/pi-agent-ext-superpowers/skills/brainstorming/spec-document-reviewer-prompt.md` (L7)
- `bun-apps/pi-agent-ext-superpowers/skills/writing-plans/SKILL.md` (L18, L160)
- `bun-apps/pi-agent-ext-superpowers/skills/subagent-driven-development/SKILL.md` (L277)
- `bun-apps/pi-agent-ext-superpowers/skills/requesting-code-review/SKILL.md` (L60)
- `.gitignore` — flip `.planning/` to scratch-only ignores
- `bun-apps/pi-agent-ext-wayfind/src/wayfinder.ts` — add `effortSlug()` + `datePrefix()`
- `bun-apps/pi-agent-ext-wayfind/src/commands.ts` — `slugify`→`effortSlug` at effort-creation site; handoff copy; drop `docs/specs` fallback
- `bun-apps/pi-agent-ext-wayfind/docs/adr/0002-shared-status-widget-and-command-consolidation.md` (L52–53 path refs)

**Delete:**
- `docs/superpowers/specs/2026-07-17-wayfind-pwf-status-widget-unification-design.md` (after migration)
- `docs/superpowers/plans/2026-07-17-wayfind-pwf-status-widget-unification.md` (after migration)

---

### Task 1: superpowers path fork — patch table + idempotent applier

**Files:**
- Create: `bun-apps/pi-agent-ext-superpowers/migrations/unified-planning-dir.patch`
- Create: `bun-apps/pi-agent-ext-superpowers/scripts/apply-patches.sh`
- Modify (via the applier): the 7 skill sites listed above

**Interfaces:**
- Produces: `apply-patches.sh` reads `migrations/*.patch` (TSV: `file<TAB>old<TAB>new`), applies each via `perl -i -pe 's/\Q$old\E/$new/g'`, idempotent (skips when `$new` already present). Other tasks + `update-superpowers.sh` call it.

- [ ] **Step 1: Create the patch table**

Write `bun-apps/pi-agent-ext-superpowers/migrations/unified-planning-dir.patch`:

```
# unified-planning-dir.patch — forks superpowers' hardcoded docs/superpowers/
# paths to the unified .planning/<effort>/ layout. Applied by scripts/apply-patches.sh.
# Format: <path-relative-to-package-root><TAB><old-string><TAB><new-string>
# Idempotent: the applier skips a row whose new-string is already present.
# Note: brainstorming/SKILL.md has the same path string on L29 + L106; the /g
# flag replaces both in one pass.
skills/brainstorming/SKILL.md	docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md	.planning/<effort>/spec.md
skills/brainstorming/spec-document-reviewer-prompt.md	docs/superpowers/specs/	.planning/<effort>/
skills/writing-plans/SKILL.md	docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md	.planning/<effort>/plan.md
skills/writing-plans/SKILL.md	docs/superpowers/plans/<filename>.md	.planning/<effort>/plan.md
skills/subagent-driven-development/SKILL.md	docs/superpowers/plans/feature-plan.md	.planning/<effort>/plan.md
skills/requesting-code-review/SKILL.md	docs/superpowers/plans/deployment-plan.md	.planning/<effort>/plan.md
```

- [ ] **Step 2: Create the applier**

Write `bun-apps/pi-agent-ext-superpowers/scripts/apply-patches.sh`:

```bash
#!/usr/bin/env bash
########################################
# apply-patches.sh — apply every migrations/*.patch substitution to the
# superpowers skill files. Idempotent: rows whose new-string is already
# present are skipped, so re-running after an upstream sync is a no-op once
# converged. Modeled on MLX's vendor_patches.py (declarative table + applier).
########################################
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # pi-agent-ext-superpowers/
shopt -s nullglob
patches=("$PKG"/migrations/*.patch)
[[ ${#patches[@]} -gt 0 ]] || { echo "no migrations/*.patch found"; exit 0; }

applied=0; skipped=0
for patch in "${patches[@]}"; do
  while IFS=$'\t' read -r file old new; do
    # skip comments and blanks
    case "$file" in ''|\#*) continue ;; esac
    target="$PKG/$file"
    if [[ ! -f "$target" ]]; then
      echo "warn: $file missing — skipped" >&2
      continue
    fi
    # idempotent: new string already present → nothing to do
    if grep -qF -- "$new" "$target"; then
      skipped=$((skipped + 1))
      continue
    fi
    perl -i -pe "s/\\Q$old\\E/$new/g" "$target"
    echo "patched $file: $old -> $new"
    applied=$((applied + 1))
  done < "$patch"
done
echo "apply-patches: $applied substituted, $skipped already-present"
```

Then `chmod +x bun-apps/pi-agent-ext-superpowers/scripts/apply-patches.sh`.

- [ ] **Step 3: Run the applier (this forks the 7 sites)**

Run: `./bun-apps/pi-agent-ext-superpowers/scripts/apply-patches.sh`
Expected: 6 lines of `patched ...` (brainstorming/SKILL.md's two identical sites fall to one /g pass), then `apply-patches: 6 substituted, 0 already-present`.

- [ ] **Step 4: Verify the fork + idempotency**

Run: `git grep -n "docs/superpowers/" -- bun-apps/pi-agent-ext-superpowers/skills/`
Expected: no output (0 hits — all 7 sites forked).

Run: `./bun-apps/pi-agent-ext-superpowers/scripts/apply-patches.sh`
Expected: `apply-patches: 0 substituted, 6 already-present` (idempotent — no-op on second run, exit 0).

Run: `git diff --stat bun-apps/pi-agent-ext-superpowers/skills/`
Expected: 5 files changed (brainstorming/SKILL.md, brainstorming/spec-document-reviewer-prompt.md, writing-plans/SKILL.md, subagent-driven-development/SKILL.md, requesting-code-review/SKILL.md).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/migrations/ \
        bun-apps/pi-agent-ext-superpowers/scripts/apply-patches.sh \
        bun-apps/pi-agent-ext-superpowers/skills/
git commit -m "feat(superpowers): fork docs/superpowers/ paths to .planning/<effort>/ + idempotent patch applier"
```

---

### Task 2: self-contained upstream sync — `update-superpowers.sh`

**Files:**
- Create: `bun-apps/pi-agent-ext-superpowers/scripts/update-superpowers.sh`

**Interfaces:**
- Consumes: `scripts/apply-patches.sh` (Task 1); the plugin cache at `$CLAUDE_PLUGINS_CACHE` (default `$HOME/.claude-glm/plugins/cache/claude-plugins-official/superpowers`).
- Produces: `update-superpowers.sh [version]` — copies `skills/` from the cache, then re-applies patches. The package's single entry point for upstream convergence.

- [ ] **Step 1: Create the sync script**

Write `bun-apps/pi-agent-ext-superpowers/scripts/update-superpowers.sh`:

```bash
#!/usr/bin/env bash
########################################
# update-superpowers.sh — sync superpowers skills/ from the plugin cache
# (upstream verbatim), then re-apply this package's path forks. The whole
# upstream-convergence flow is self-contained in the superpowers ext folder;
# bun-apps/pi-agent/update-pi.sh is unrelated (it only locks the pi-* core).
#
# USAGE
#   ./bun-apps/pi-agent-ext-superpowers/scripts/update-superpowers.sh [version]
#     version  plugin version to sync (default: newest under the cache).
#   CLAUDE_PLUGINS_CACHE  override the plugin cache root.
########################################
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # pi-agent-ext-superpowers/
CACHE="${CLAUDE_PLUGINS_CACHE:-$HOME/.claude-glm/plugins/cache/claude-plugins-official/superpowers}"

if [[ $# -ge 1 ]]; then
  VER="$1"
else
  VER="$(ls -1 "$CACHE" 2>/dev/null | sort -V | tail -1)"
fi
[[ -n "$VER" ]] || { echo "error: no superpowers plugin cache at $CACHE" >&2; exit 1; }
SRC="$CACHE/$VER/skills"
[[ -d "$SRC" ]] || { echo "error: $SRC not found" >&2; exit 1; }

echo "▶ sync skills/ from $CACHE/$VER"
rm -rf "$PKG/skills"
cp -R "$SRC" "$PKG/skills"

echo "▶ re-apply path forks"
"$PKG/scripts/apply-patches.sh"

echo
echo "done. review the diff:  git diff bun-apps/pi-agent-ext-superpowers/skills/"
```

Then `chmod +x bun-apps/pi-agent-ext-superpowers/scripts/update-superpowers.sh`.

- [ ] **Step 2: Verify round-trip convergence**

This proves a future upstream sync re-converges to exactly the committed forked state.

```bash
cd "$(git rev-parse --show-toplevel)"
# snapshot the committed (forked) skills state
git stash push -- bun-apps/pi-agent-ext-superpowers/skills/ >/dev/null 2>&1 || true
# simulate an upstream sync: the script copies verbatim skills, then re-patches
./bun-apps/pi-agent-ext-superpowers/scripts/update-superpowers.sh >/dev/null
# diff against HEAD must be empty — sync + patch reproduces the committed fork
git diff --exit-code -- bun-apps/pi-agent-ext-superpowers/skills/
echo "round-trip: skills/ converged to committed fork (no diff)"
git stash pop >/dev/null 2>&1 || true
```

Expected: `round-trip: skills/ converged to committed fork (no diff)` and `git diff --exit-code` passes (exit 0).

(Note: the `git stash` guards against uncommitted local edits before the test; `stash pop` restores them. The script's `cp -R` overwrites `skills/` wholesale — intended, since `skills/` is upstream-verbatim + patches, never hand-edited.)

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/scripts/update-superpowers.sh
git commit -m "feat(superpowers): self-contained update-superpowers.sh (plugin-cache sync + re-patch)"
```

---

### Task 3: `.gitignore` — `.planning/` becomes committed archive

**Files:**
- Modify: `.gitignore` (the planning-scratch block near line 75–81)

**Interfaces:**
- Produces: `.planning/<effort>/{spec,plan,map}.md` + `tickets/` tracked; `.planning/*/task_plan.md`, `progress.md`, `findings.md` (and root-level ditto) ignored.

- [ ] **Step 1: Write the failing test**

A shell check the implementer runs after the edit (`.gitignore` has no unit test framework — this is the test):

```bash
mkdir -p /tmp/planning-ignore-check/.planning/2026-07-18-demo
cd /tmp/planning-ignore-check && git init -q && cp "$REPO/.gitignore" .
touch .planning/2026-07-18-demo/spec.md
touch .planning/2026-07-18-demo/task_plan.md
git check-ignore .planning/2026-07-18/demo/spec.md && echo "FAIL: spec.md ignored" || echo "PASS: spec.md tracked"
git check-ignore .planning/2026-07-18/demo/task_plan.md && echo "PASS: task_plan.md ignored" || echo "FAIL: task_plan.md tracked"
```

Expected before edit: both FAIL (`.planning/` ignores everything). After edit: spec PASS-tracked, task_plan PASS-ignored.

- [ ] **Step 2: Run test to verify it fails**

Run the snippet above (substituting the repo `.gitignore`). Expected: `spec.md ignored` (FAIL — everything under `.planning/` ignored today).

- [ ] **Step 3: Apply the edit**

In `.gitignore`, replace the planning-scratch block (the 3 comment lines + `task_plan.md` + `.planning/`). The block currently reads:

```gitignore
# Per-session planning scratch files (task_plan/progress/findings).
# These are transient working memory produced by planning skills during a task;
# they must NOT be committed. Canonical location is ./.planning/<dir>/.
task_plan.md
.planning/
```

Replace with:

```gitignore
# Per-session planning scratch (transient working memory — never commit).
# Planning artifacts (.planning/<effort>/{spec,plan,map}.md, tickets/) ARE
# committed; only the live scratch below is ignored.
task_plan.md
progress.md
findings.md
.planning/*/task_plan.md
.planning/*/progress.md
.planning/*/findings.md
```

- [ ] **Step 4: Run test to verify it passes**

Re-run the Step 1 snippet. Expected: `PASS: spec.md tracked` and `PASS: task_plan.md ignored`. Also verify root scratch still ignored: `git check-ignore task_plan.md` → prints the path (ignored).

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: track .planning/ archives; ignore only task_plan/progress/findings scratch"
```

---

### Task 4: wayfind `effortSlug()` — date-prefixed effort ids

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/src/wayfinder.ts` (add `effortSlug` + `datePrefix` near `slugify`, L25–34)
- Modify: `bun-apps/pi-agent-ext-wayfind/src/commands.ts:268` (`slugify(destination)` → `effortSlug(destination)`)
- Test: `bun-apps/pi-agent-ext-wayfind/tests/effort-slug.test.ts` (create)

**Interfaces:**
- Produces: `effortSlug(text: string): string` → `YYYY-MM-DD-<slug>`; `slugify(text: string): string` unchanged (still bare, used for ticket slugs at `wayfinder.ts:111`).

- [ ] **Step 1: Write the failing test**

Write `bun-apps/pi-agent-ext-wayfind/tests/effort-slug.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { effortSlug, slugify } from "../src/wayfinder.js";

describe("effortSlug", () => {
  it("prepends today's date (YYYY-MM-DD-) to the bare slug", () => {
    const today = new Date();
    const prefix =
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(effortSlug("Add Video Relay")).toBe(`${prefix}-add-video-relay`);
  });

  it("lowercases, hyphenates, trims the slug half", () => {
    expect(effortSlug("  Fix the /plan handoff!  ")).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-fix-the-plan-handoff$/);
  });

  it("falls back to 'effort' when the slug half is empty", () => {
    expect(effortSlug("   ")).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-effort$/);
  });
});

describe("slugify (unchanged — bare, no date)", () => {
  it("produces a bare slug with no date prefix (used for ticket slugs)", () => {
    expect(slugify("Storage Layer")).toBe("storage-layer");
    expect(slugify("Storage Layer")).not.toMatch(/^[0-9]{4}-/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test --cwd bun-apps/pi-agent-ext-wayfind tests/effort-slug.test.ts`
Expected: FAIL — `effortSlug` is not exported (import error).

- [ ] **Step 3: Implement `effortSlug` + `datePrefix`**

In `bun-apps/pi-agent-ext-wayfind/src/wayfinder.ts`, immediately after the existing `slugify` function (after L34), add:

```ts
/** Today's date as `YYYY-MM-DD` (local). Used to prefix effort ids so they sort
 *  chronologically under .planning/. */
function datePrefix(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Effort id for a free-text destination: `YYYY-MM-DD-<slug>` (the unified
 *  .planning/ convention). Use this for effort folder names; use `slugify`
 *  (bare) for ticket slugs, which carry their own NN- prefix. */
export function effortSlug(text: string): string {
  return `${datePrefix()}-${slugify(text)}`;
}
```

(`slugify` itself is NOT modified — `wayfinder.ts:111`'s ticket-slug use stays bare.)

- [ ] **Step 4: Switch the effort-creation call site**

In `bun-apps/pi-agent-ext-wayfind/src/commands.ts`, the `import` line L35 currently reads:

```ts
import { chartMap, claimNextTicket, renderStatus, slugify, statusReport } from "./wayfinder.js";
```

Change to import `effortSlug`:

```ts
import { chartMap, claimNextTicket, effortSlug, renderStatus, slugify, statusReport } from "./wayfinder.js";
```

Then at L268 (inside `handleWayfinderChart`), change:

```ts
  const effort = slugify(destination);
```

to:

```ts
  const effort = effortSlug(destination);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test --cwd bun-apps/pi-agent-ext-wayfind`
Expected: 139 prior + 4 new = 143 pass / 0 fail. (If any prior test asserted a bare-slug effort id, update it to expect the date prefix — but `chartMap`/`claimNextTicket` tests use synthetic effort strings directly, so they should be unaffected. Verify no regression.)

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-wayfind/src/wayfinder.ts \
        bun-apps/pi-agent-ext-wayfind/src/commands.ts \
        bun-apps/pi-agent-ext-wayfind/tests/effort-slug.test.ts
git commit -m "feat(wayfind): effortSlug() — date-prefixed effort ids (YYYY-MM-DD-<slug>)"
```

---

### Task 5: wayfind handoff copy — point at superpowers execution skills

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/src/commands.ts` (the `execute the plan` / `docs/specs` strings + `to-spec` handoff)

**Interfaces:**
- Produces: wayfind's `/grill done --seed-plan`, `/wayfind seed`, `/wayfind tickets`, `/wayfind spec` guidance names superpowers `executing-plans` / `subagent-driven-development` and writes only to `.planning/<effort>/` (no `docs/specs` fallback).

- [ ] **Step 1: Update the handoff copy**

In `bun-apps/pi-agent-ext-wayfind/src/commands.ts`, make these edits (the #624-era generic "execute the plan" → names the superpowers skill that consumes the plan):

1. `handleGrillDone` seed handoff (≈L115) — change:
   `` `Grill ended. I seeded ${outcome.path} from ${outcome.source}. Review the phases, then execute the plan.` ``
   to:
   `` `Grill ended. I seeded ${outcome.path} from ${outcome.source}. Review the phases, then load the executing-plans (or subagent-driven-development) skill to execute the plan.` ``

2. `handleWayfindSeed` handoff (≈L173) — change:
   `` `Seeded ${outcome.path} from ${outcome.source}. Review the phases, then execute the plan.` ``
   to:
   `` `Seeded ${outcome.path} from ${outcome.source}. Review the phases, then load the executing-plans (or subagent-driven-development) skill to execute the plan.` ``

3. `handleToSpec` next-step line (≈L192) — change:
   `"Tell me the path when written. The natural next step is /wayfind tickets, then /wayfind seed → execute the plan."`
   to:
   `"Tell me the path when written. The natural next step is /wayfind tickets, then /wayfind seed → executing-plans."`

4. `handleToSpec` spec-path line (≈L186–187) — change the fallback that implies a second spec home. Replace:
   ```ts
          effort
            ? `Write the spec to .planning/${effort}/spec.md.`
            : "Write the spec to .planning/<effort>/spec.md (or docs/specs/<slug>.md).",
   ```
   with:
   ```ts
          effort
            ? `Write the spec to .planning/${effort}/spec.md.`
            : "Write the spec to .planning/<effort>/spec.md.",
   ```

- [ ] **Step 2: Run tests**

Run: `bun test --cwd bun-apps/pi-agent-ext-wayfind`
Expected: 143 pass / 0 fail (no test asserts these exact strings after #624; verify nothing regresses). Also:

Run: `git grep -n "docs/specs" -- bun-apps/pi-agent-ext-wayfind/src/`
Expected: no output (fallback removed).

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-wayfind/src/commands.ts
git commit -m "feat(wayfind): hand off to superpowers executing-plans; drop docs/specs fallback"
```

---

### Task 6: migrate historical files + update ADR-0002 path refs

**Files:**
- Move: `docs/superpowers/specs/2026-07-17-wayfind-pwf-status-widget-unification-design.md` → `.planning/2026-07-17-wayfind-pwf-unification/spec.md`
- Move: `docs/superpowers/plans/2026-07-17-wayfind-pwf-status-widget-unification.md` → `.planning/2026-07-17-wayfind-pwf-unification/plan.md`
- Modify: `bun-apps/pi-agent-ext-wayfind/docs/adr/0002-shared-status-widget-and-command-consolidation.md` (L52–53)

**Interfaces:**
- Produces: the 2 historical snapshots live under the unified `.planning/` layout; ADR-0002's references resolve.

- [ ] **Step 1: Move the two historical files**

```bash
mkdir -p .planning/2026-07-17-wayfind-pwf-unification
git mv docs/superpowers/specs/2026-07-17-wayfind-pwf-status-widget-unification-design.md \
       .planning/2026-07-17-wayfind-pwf-unification/spec.md
git mv docs/superpowers/plans/2026-07-17-wayfind-pwf-status-widget-unification.md \
       .planning/2026-07-17-wayfind-pwf-unification/plan.md
```

- [ ] **Step 2: Update ADR-0002's two path references**

In `bun-apps/pi-agent-ext-wayfind/docs/adr/0002-shared-status-widget-and-command-consolidation.md`, the last two lines (L52–53) currently read:

```
  Full spec: `docs/superpowers/specs/2026-07-17-wayfind-pwf-status-widget-unification-design.md`.
  Full implementation plan: `docs/superpowers/plans/2026-07-17-wayfind-pwf-status-widget-unification.md`.
```

Replace with:

```
  Full spec: `.planning/2026-07-17-wayfind-pwf-unification/spec.md`.
  Full implementation plan: `.planning/2026-07-17-wayfind-pwf-unification/plan.md`.
```

- [ ] **Step 3: Verify the moves + refs resolve**

Run: `git grep -n "docs/superpowers/" -- bun-apps/pi-agent-ext-wayfind/docs/adr/0002-shared-status-widget-and-command-consolidation.md`
Expected: no output (both refs updated).

Run: `ls .planning/2026-07-17-wayfind-pwf-unification/`
Expected: `plan.md` and `spec.md`.

Run: `ls docs/superpowers/specs/ docs/superpowers/plans/ 2>/dev/null`
Expected: empty (or the directories absent) — the historical files have moved out.

- [ ] **Step 4: Commit**

```bash
git add .planning/2026-07-17-wayfind-pwf-unification/ \
        bun-apps/pi-agent-ext-wayfind/docs/adr/0002-shared-status-widget-and-command-consolidation.md
git commit -m "docs: migrate 2026-07-17 wayfind-pwf snapshots to .planning/ + update ADR-0002 refs"
```

---

## Self-Review (completed)

**Spec coverage:** §1 layout → implicit (convention enforced by §3 ignore + §2 paths + §4 naming). §2 fork → Task 1. §3 patch+sync → Tasks 1–2. §4 gitignore → Task 3. §5 wayfind (slugify + handoff + docs/specs) → Tasks 4–5. §6 migration → Task 6. Verification criteria from the spec map to each task's Step 4/verify.

**Placeholder scan:** none — every code step shows exact code, every test shows exact assertions, every command shows expected output.

**Type consistency:** `effortSlug(text: string): string` (Task 4) matches the import + call site in Task 4 Step 4. `slugify` stays `string→string`. `apply-patches.sh` / `update-superpowers.sh` paths match across Tasks 1–2.

**One spec refinement surfaced:** spec §5 said "slugify() prepends the date" — but `slugify` is dual-use (effort ids AND ticket slugs at `wayfinder.ts:111`). Plan Task 4 adds `effortSlug` for efforts and leaves `slugify` bare, which matches intent without breaking ticket slugs. This is a plan-level clarification, not a spec deviation.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-18-unified-planning-directory.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
