# t04 — builtin agent pack producer + /agents receipt latch

## Verified findings

- `/agents` reads packs via an env seam only: `agents-command.ts:50`
  `resolvePackDirs(cwd, env = process.env.S2_AGENT_PACK_DIRS)`; loaded by
  `loadAgentRegistry(cwd, { packDirs })` (:71–72); nothing in the repo
  produces a pack dir (grep: seam + tests only).
- Pack def format (proven by `tests/agents-viewer.test.ts:450`):
  `---\nname: env-worker\ndescription: via S2_AGENT_PACK_DIRS\n---\nPrompt.`
- Claude Code ships builtin agent packs; today an s2-agent user with no env
  gets zero packs — the seam is a dead button.

## Implementation

1. Create `bun-apps/s2-agent-ext-subagent/packs/builtin/` with three
   CC-flavored defs, frontmatter markdown per the format above (names
   aligned with the existing catalog vocabulary — do not collide with
   built-in agentType names; check `agent-type-catalog.ts` first):
   - `code-reviewer.md` — review a diff for defects with receipts;
   - `explorer.md` — read-only repo reconnaissance, returns file:line map;
   - `test-writer.md` — write regression tests from a failing receipt.
2. `resolvePackDirs`: append `join(<packageRoot>, "packs/builtin")` AFTER
   env dirs (user packs win name collisions — read loadAgentRegistry's
   collision order first; flip to prepend if it is last-wins).
3. Keep env behavior unchanged (env dirs still first-class).

## Tests + receipt design

- Unit: extend `tests/agents-viewer.test.ts` pack-seam describe block
  (:392) — no env set ⇒ builtin dir present in resolved dirs; registry
  loads the three names; env pack name wins over a colliding builtin name.
- Receipt: extend `tui-drive.ts` `scenarioAgents` (or the agents scenario's
  registry list step) with a latch that the builtin pack name renders in
  `/agents`. Source + deployed legs (deploy mirrors bun-apps → dir ships).
- Schema-cost +0 (no tool descriptions touched).

## Risks / descope

- FIRST descope candidate if the arc overruns (standalone, zero deps on
  t01–t03). If permanently descoped: the seam stays env-only; document in
  map close-out that builtin packs were judged worth shipping only as a
  source directory.
