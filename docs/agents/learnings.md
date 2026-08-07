# Agent Learnings

Durable, team-wide learnings about the pi-agent toolchain in this repo — tool quirks, architectural facts, and conventions surfaced during work. Per-user lessons also live in the memory store at `~/.pi/agent/pi-hermes-memory/failures.md`; this file captures the subset worth sharing across the team and version-controlling.

Entries are append-only and dated. Each is tagged `[tool-quirk]`, `[insight]`, or `[convention]`.

---

## [tool-quirk] `subagent` commitScope violations can be false positives on a stale local `main`

**Added:** 2026-08-07

The `subagent` tool's `commitScope` violation detector compares a branch's committed paths against the **local `main` ref, not `origin/main`**. When a feature branch is based on a stale local `main` that lags `origin/main`, the detector flags every file that differs from the stale local main as out-of-scope — producing large false-positive lists (observed: 107 files flagged) even when the true PR diff vs `origin/main` is clean (was: 2 files).

**Before acting on a reported commit-scope violation** (e.g. dispatching a history rewrite / force-push cleanup), verify the real net diff first:

    git diff origin/main...HEAD --stat
    git show --stat HEAD

If those show only the intended in-scope files, the violation is a false alarm — no cleanup is needed. Common in worktrees that frequently sit behind `origin/main`.

---

## [insight] pi-coding-agent skill precedence: bundled `--skill` always wins over `resources_discover`

**Added:** 2026-08-07

pi-coding-agent loads skills from CLI `--skill <dir>` args (from manifest `skills[]` / `binarySkills` — the **bundled** skills) **before** skills discovered via an extension's `resources_discover` handler, and dedups **first-wins** keyed on the skill `name`.

Consequences:

- A **bundled** skill always wins over a same-named personal skill an extension discovers.
- The diagnostic `name "X" collision … (skipped)` means the **bundled** copy is the active winner and the personal one was dropped — it is **informational noise, not a functional bug**; the correct (bundled) skill is already loaded.
- There is **no override/precedence hook** in the `resources_discover` contract (it only accepts `skillPaths: string[]`), so you cannot make a discovered skill beat a bundled one. To eliminate a collision, **remove the duplicate source** rather than trying to change precedence.

The `hermes-memory` extension uses `~/.pi/agent/pi-hermes-memory/skills/` as **both** a writable `skill_manage` store **and** a discovery source — that dual purpose is what collides with its own bundled skills. Bundled skills ship from `bun-apps/pi-agent-ext-hermes-memory/skills/`; `deploy.ts` copies the whole skill dir (including non-`SKILL.md` files like `dedup.sh`) in all deploy modes (`--bundle` / `--standalone` / `--exe` / `--snapshot`).
