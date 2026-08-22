---
name: using-s2-agent-skills
description: Use when a task matches a skill, script, or CLI already developed in this repo's s2-agent extension packages (bun-apps/s2-agent-ext-*), or when re-implementing devops / research / movie-director / wayfind / superpowers tooling that likely already exists — covers invoking them from claude-code directly and via ./s2-agent.sh (headless -p or interactive).
---

# Using s2-agent ext skills from claude-code

This repo ships ~50 agent skills inside `bun-apps/s2-agent-ext-*/skills/<name>/SKILL.md`,
plus headless CLIs (`src/*-cli.ts`) and verification scripts (`scripts/`).
They were built for s2-agent, but every one of them is reusable from claude-code —
re-use them before writing a new workflow.

## Discovery (run first)

```bash
bash .claude/skills/using-s2-agent-skills/list-ext-skills.sh skills   # all skills + descriptions
bash .claude/skills/using-s2-agent-skills/list-ext-skills.sh cli      # headless CLI fallbacks
bash .claude/skills/using-s2-agent-skills/list-ext-skills.sh scripts  # per-package scripts/
```

Then READ the matching SKILL.md before acting — it encodes hard-won pitfalls.

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

## Gotchas

- Run `bun <path>.ts` from the **repo root** (Bun resolves the workspace); never top-level `cd` — use `--cwd`/subshells per repo rules.
- First `./s2-agent.sh` launch after a dep change runs a `bun install` self-heal — normal, not a hang. `-p` not printing instantly is also normal (LLM round-trip; `[hermes-memory] slow startup` banner is benign).
- Scripted skills may need env keys (e.g. `collect-youtube-llm` needs `YOUTUBE_API_KEY`) — check the skill's Prerequisites section first. A `<vault>` path in an ext skill means the configured Obsidian vault (see `bun-apps/s2-agent-ext-obsidian`), not a repo dir.
- Devops CLIs are throw-free and print JSON on stdout; exit codes 0/1/2. Most honor `--dry-run` (e.g. `sync-default-branch-cli.ts --dry-run`); `main-health-cli.ts` has NO lighter mode by design — read-only but always the full matrix. `local-ci-cli` is change-scoped; "is main green?" → `main-health-cli.ts`.
- This is a git worktree: `./s2-agent.sh` resolves its own dir, works from any cwd.
- Adding a new top-level entry to any `s2-agent*/scripts/` requires adding its path to the allowlist in `s2-agent-ext-devops/tests/scripts-dir-contract.test.ts` (one line, deliberate) — a library file there fails CI with no escape; put libraries in `src/` or `scripts/lib/`.

## Common mistakes

- Re-implementing a git/PR/CI workflow by hand instead of `bun-apps/s2-agent-ext-devops/skills/devops-workflow/SKILL.md` + its CLIs.
- Invoking an extension tool name in claude-code as if it were a command — tools exist only inside s2-agent; use the CLI twin or the `-p` bridge.
- Skimming the SKILL.md: each one's Pitfalls section records real past failures (quota, scope-verification false-positives, …).
