---
name: using-s2-agent-skills
description: Use when a task matches a skill, script, or CLI already developed in this repo's s2-agent extension packages (bun-apps/s2-agent-ext-*), or when re-implementing devops / research / movie-director / wayfind / superpowers tooling that likely already exists. Trigger situations — git sync/branch/PR/merge/CI (devops-workflow + *-cli.ts); an arc CLOSING ("done", "hands off", session ending, PR merged, milestone verified): read self-reflect-next-goal and WRITE the successor next-goal file BEFORE reporting; "hands on" / "hands on next goal": EXECUTE the queue head; multi-ticket efforts (.planning tickets, frontier, seed, spec): route via wayfind (ask-matt / to-spec / to-tickets) then executing-plans; new features (brainstorming); bugs/flakes (systematic-debugging). Ext skills are Markdown docs under bun-apps/s2-agent-ext-*/skills/<name>/SKILL.md (READ them — not this harness's skill() entries; the name is the dir, never the package), located via list-ext-skills.ts resolve <name>. Covers invoking them from claude-code directly and via ./s2-agent.sh (headless -p or interactive).
---

# Using s2-agent ext skills from claude-code

This repo ships ~50 agent skills inside `bun-apps/s2-agent-ext-*/skills/<name>/SKILL.md`,
plus headless CLIs (`src/*-cli.ts`) and verification scripts (`scripts/`).
They were built for s2-agent, but every one of them is reusable from claude-code —
re-use them before writing a new workflow.

## Discovery (run first)

```bash
bun .claude/skills/using-s2-agent-skills/list-ext-skills.ts skills   # all skills + descriptions
bun .claude/skills/using-s2-agent-skills/list-ext-skills.ts cli      # headless CLI fallbacks
bun .claude/skills/using-s2-agent-skills/list-ext-skills.ts scripts  # per-package scripts/
```

Then READ the matching SKILL.md before acting — it encodes hard-won pitfalls.

## Route-first gates (the trigger layer)

Ext-skill descriptions cannot auto-fire in this harness (only this skill is `skill()`-invocable
here), so the gates below ARE the trigger layer — CLAUDE.md points here. On ANY of these
situations, READ + follow the named ext SKILL.md first; never hand-roll a substitute.

| Gate | Keywords / situation | Read + follow |
|---|---|---|
| **Hands-off** | "done", "that's it", session ending/stopping, PR merged, milestone verified, task finished — ANY arc close-out | `self-reflect-next-goal` **WRITE**: write a validator-passing successor `output/next-goal-<ts>.md` (strict v2), re-point `LATEST-next-goal.md`, then report. Reporting done WITHOUT the successor file is the #1 violation — it silently drops the carry. |
| **Hands-on** | "hands on", "hands on next goal", "do the next goal" | `self-reflect-next-goal` **EXECUTE**: sync the tree, run the queue head end-to-end through its Done-when gate; at a ticket boundary write the successor. |
| **Git** | sync/update main, branch, rebase, PR, squash-merge, CI/typecheck before merge, verify scope | `devops-workflow` + its `*-cli.ts` (throw-free, JSON, exit 0/1/2; never raw-bash `git`/`gh`); "is main green?" → `main-health-cli.ts`. |
| **Tickets/effort** | `.planning/<effort>` work, tickets, frontier, `/wayfind seed`, spec, multi-ticket build | wayfind family — route via `ask-matt` when unsure; `to-spec` then `to-tickets` (**Execution order confirm-gate** after seed — present order, ask confirm-or-rechoose, record the map's `Execution order` line) → `executing-plans` per queue head. |
| **Idea/feature** | "I want to build X", new feature, behavior change | `brainstorming` → `writing-plans` (artifacts to `.planning/`); methodology routing: `using-superpowers`. |
| **Bug** | bug, flaky test, regression, unexpected behavior | `systematic-debugging` — reproduction loop BEFORE proposing fixes. |
| **Domain words** | fuzzy term, glossary, hard-to-reverse decision | `domain-modeling` — `CONTEXT.md` + ADRs (`ADR-<context>-NNNN`). |

Rule of thumb: assume the repo already has the machinery — verify with `resolve <name>` before
writing anything new. If you catch yourself composing a git workflow, a `.planning` artifact
shape, or a session handoff from scratch — STOP, resolve, read, follow.

**Ext skills are Markdown docs, not this harness's `skill()` entries.** Only `using-s2-agent-skills`
is loadable through the `skill()` tool here; every other ext skill is a file under
`bun-apps/s2-agent-ext-<pkg>/skills/<name>/SKILL.md` that you `read` and follow in-session. To map a
spoken name to its exact path — so you never guess, `find` around, or re-implement a package:

```bash
bun .claude/skills/using-s2-agent-skills/list-ext-skills.ts resolve <skill-name>   # prints the SKILL.md path
```

**The skill name is the directory under `skills/`, NOT the package.** `s2-agent-ext-superpowers` is a
FAMILY, not a skill — it contains `brainstorming`, `writing-plans`, `writing-skills`,
`test-driven-development`, `systematic-debugging`, `requesting-code-review`, `receiving-code-review`,
`subagent-driven-development`, `executing-plans`, `using-git-worktrees`, `finishing-a-development-branch`,
`using-superpowers`. So "superpowers brainstorm" → `resolve brainstorming` (read it, follow in-session);
"superpowers" alone is not a skill. The generic "how do I use skills" entry is `using-superpowers`. The
wayfind family routes on `ask-matt`.

## Repo rules that OVERRIDE upstream skill defaults

Upstream ext skills target a generic repo; this repo's `CLAUDE.md` supersedes several of their defaults.
Follow CLAUDE.md first — these are the ones that bite:

| Ext skill says… | This repo actually requires… |
|---|---|
| write specs/plans to `docs/<tool>/{specs,plans}` | **`.planning/` is the SOLE artifact home** — effort folder `YYYY-MM-DD-<effort>/` (`map.md` + `spec.md` + `tickets/`) or flat `.planning/specs/` + `.planning/plans/`. The `docs/superpowers/*` namespace is RETIRED (`ADR-superpowers-0009`) and guarded: writing there fails `artifact-leak.test.ts`. |
| run `bun <script>.ts` anywhere | from the **repo root** (or `--cwd`/subshell) — never top-level `cd`; `bun install` from `bun-apps/` only |
| use python3 | `python/venv/bin/python` from repo root — never system `python3` |
| run `bun test` | a package's **canonical** `bun run test` (may include build/typecheck); devops `local_ci` resolves gates by script NAME and silently skips renamed scripts |
| hand-roll git/PR/CI | via the devops skill + its `*-cli.ts` (`prepare-feature-branch`, `local-ci`, `merge-pr-after-ci`, `main-health`, …) — never raw-bash git/gh subagents |
| context glossary / ADR | `CONTEXT.md` is a **ubiquitous-language glossary** (one `**Term**:` per concept + an `_Avoid_:` line); ADRs live in `<pkg>/docs/adr/` and are cited `ADR-<context>-NNNN` |
| dispatch a subagent for writes | watchdog OFF for write-heavy implementers; the independent **reviewer subagent** is the real quality gate |

## Pick the runtime by what the skill references

| SKILL.md references… | How to run it |
|---|---|
| A shell script / `.ts` script path | claude-code direct: `bun bun-apps/s2-agent-ext-<pkg>/scripts/<script>.ts` (from repo root). Every top-level `scripts/*.ts` / `*.mjs` is a RUNNABLE entry (guarded by `s2-agent-ext-devops/tests/scripts-dir-contract.test.ts`); libraries live in `src/` or `scripts/lib/` — running those directly exits 0 silently, so never treat a silent zero-output exit as success. Deploy entry is `bun bun-apps/s2-agent-ext-devops/src/deploy-cli.ts` (`scripts/deploy.ts` no longer exists). |
| An extension **tool** (`sync_default_branch`, `collect_videos`, …) — tools only exist inside s2-agent | Either the CLI twin: `bun bun-apps/s2-agent-ext-<pkg>/src/<tool>-cli.ts --help` (devops has one per tool), or delegate to s2-agent headless (below) |
| Pure methodology (superpowers, wayfind family) | Read the SKILL.md and follow it in-session — no process needed |

## The s2-agent bridge (when a tool has no CLI twin)

```bash
./s2-agent.sh -p "<prompt that names the skill / asks for the tool>"   # headless; extensions + skills auto-load
./s2-agent.sh                                                          # interactive TUI; skills are slash commands: /devops-workflow, /collect-youtube-llm, …
```

Verified working: `./s2-agent.sh --list-models` (offline smoke), `./s2-agent.sh -p "<short prompt>"`
(replied with loaded skill names). Skills load via `bun-apps/s2-agent/s2-agent.registry.yaml` (`skills: true` per entry).

`bun` is required to run most ext CLIs directly. If the consuming agent has no Bun on PATH (e.g. it
runs on plain Node), delegate rather than shelling out: `./s2-agent.sh -p "<prompt that names the skill>"`
resolves its own tree and self-heals its deps — not `bun bun-apps/…/script.ts`.

## Gotchas

- Run `bun <path>.ts` from the **repo root** (Bun resolves the workspace); never top-level `cd` — use `--cwd`/subshells per repo rules.
- First `./s2-agent.sh` launch after a dep change runs a `bun install` self-heal — normal, not a hang. `-p` not printing instantly is also normal (LLM round-trip; `[hermes-memory] slow startup` banner is benign).
- Scripted skills may need env keys (e.g. `collect-youtube-llm` needs `YOUTUBE_API_KEY`) — check the skill's Prerequisites section first. A `<vault>` path in an ext skill means the configured Obsidian vault (see `bun-apps/s2-agent-ext-obsidian`), not a repo dir.
- Devops CLIs are throw-free and print JSON on stdout; exit codes 0/1/2. Most honor `--dry-run` (e.g. `sync-default-branch-cli.ts --dry-run`); `main-health-cli.ts` has NO lighter mode by design — read-only but always the full matrix. `local-ci-cli` is change-scoped; "is main green?" → `main-health-cli.ts`.
- This is a git worktree: `./s2-agent.sh` resolves its own dir, works from any cwd.
- Adding a new top-level entry to any `s2-agent*/scripts/` requires adding its path to the allowlist in `s2-agent-ext-devops/tests/scripts-dir-contract.test.ts` (one line, deliberate) — a library file there fails CI with no escape; put libraries in `src/` or `scripts/lib/`.

## Common mistakes

- Closing a goal arc and reporting "done" WITHOUT writing the successor next-goal file — hands-off gate: write strict-v2, validate, re-point `LATEST-next-goal.md`, THEN report. The file is the carry; a bare "done" drops it.
- Re-implementing a git/PR/CI workflow by hand instead of `bun-apps/s2-agent-ext-devops/skills/devops-workflow/SKILL.md` + its CLIs.
- Starting a multi-ticket effort without the to-tickets **Execution order confirm-gate** — after seed: present the order (blockers marked no-choice, choice pairs marked), ask confirm-or-rechoose, record the map's `Execution order` line.
- Invoking an extension tool name in claude-code as if it were a command — tools exist only inside s2-agent; use the CLI twin or the `-p` bridge.
- Skimming the SKILL.md: each one's Pitfalls section records real past failures (quota, scope-verification false-positives, …).
