---
name: wizard
description: Use when a manual procedure needs a human in the loop — provisioning infra, credentials, CI secrets, or an unfamiliar third-party dashboard. Generates a Bun wizard script that walks them through each step; skip steps the agent can do itself.
---

# Wizard

A **wizard** is a Bun script (run with `bun <file>`) that walks a human, step by step, through a manual procedure that's tedious to do by hand and tedious to re-explain to an AI every time. It opens each URL, says exactly what to click and copy, captures the values, writes them where they belong (`.env`, GitHub secrets), confirms at every stage, and shows how many stages are left. It might configure third-party services, run a one-off migration, or move the project from one state to another.

The delightful UX is already solved by [template.ts](template.ts) — stage-by-stage progress, confirmation gates, cross-platform URL opening (including WSL), hidden secret entry, idempotent `.env` upserts, `gh secret`/`gh variable` writes, and a closing summary. **Your job is only to scope the procedure and author its stages.** The library above the `STAGES` marker is identical in every wizard; that consistency is the point — never hand-edit it.

A wizard is ephemeral by default — built for one run, saved to a scratch or `scripts/` path, deleted when the job's done. Commit it only when the user wants a repeatable setup path that should live in the repo.

## Process

### 1. Scope the procedure

Work out every manual step the human must take and every value that gets captured along the way. Read the repo first — don't ask cold:

- For setup: `.env`, `.env.example`, `.env.*`, `README`, `docker-compose*`, framework config, and `.github/workflows/*` (every `secrets.*` / `vars.*` reference is a value the wizard must produce).
- For a migration or transition: the current state, the target state, and the irreversible actions between them.

Then show the user the ordered list of stages and the values each produces, and confirm — they may add, drop, or reorder.

**Done when:** every stage is named in order, and for each captured value you know (a) where the human gets it, (b) where it's written (`.env`, a GitHub secret, both, or nowhere — some stages are pure actions), and (c) whether it's secret (hidden entry) or public.

### 2. Map each stage's journey

For each stage, write the precise path a human follows: which URL to open, what to do there, where a value is shown, which variable it fills — e.g. "Dashboard → Developers → API keys → Reveal test key → copy". Where you don't actually know the current UI or the exact command, say so and ask the user or check the docs — never invent steps that may not exist.

**Done when:** every stage traces to concrete instructions a stranger could follow.

### 3. Author the wizard

Copy `template.ts` to the target path. Replace the example stage with one `stage("…")` per step, in dependency order. The helpers are async — `const KEY = await ask("KEY", "Prompt")` captures into a const (hidden entry: `await askSecret`); `say`/`step`/`note`/`warn` print guidance; `openUrl(url)` opens the browser; `writeEnv("KEY", value)` upserts into `.env`; `setSecret("NAME", value)` / `setVar("NAME", value)` write GitHub secrets/variables; `await pause()` / `await confirm("question")` gate progress. Set `TOTAL_STAGES = <n>` to the number of stages you wrote.

Hold the bar the template sets: `openUrl` before asking for its value, `askSecret` for anything secret, `writeEnv` every persisted value, `setSecret` only the values CI actually needs, and `await confirm` before any irreversible action. Each `stage` clears the screen so only the current step is visible — keep a stage to one focused task so nothing the human needs scrolls away. Don't touch the library above the marker.

### 4. Verify and hand off

- `bun build --target=bun <file> --outfile /tmp/wizard-check.js` — must exit 0. This build is the syntax gate; no separate linter is needed.
- Don't run it end-to-end yourself — it opens browsers and blocks on human input. Trace it statically instead: every value from step 1 is captured and lands where step 1 said, and every `setSecret` name exactly matches a `secrets.*` reference in CI.
- Tell the user how to run it: `bun <file>`. If it's a repeatable setup path, commit it and link it from the README so the next person runs the script instead of asking an AI.
