# s2-agent-ext-superpowers

Pi-native port of [Superpowers](https://github.com/primeradiant/superpowers) — a complete software-development methodology built on composable skills (brainstorming → writing-plans → executing-plans → subagent-driven-development → verification, plus systematic-debugging, test-driven-development, code-review, git-worktrees, dispatch-recovery (repo-native: janitor-first child-death recovery), etc.).

This package ships Superpowers as a **Layer-3 Pi extension**:

- **14 skills**: 13 ported from upstream v6.2.0 — byte-pinned against committed fixtures **with sanctioned local divergences** (truth = `tests/__fixtures__/upstream-skills/UPSTREAM.ref` + `CONTEXT.md`) — + 1 repo-native (`dispatch-recovery`). `verification-before-completion` was deleted 2026-08-21 (ticket 08; do not re-port).
- A `using-superpowers` **bootstrap** that Pi injects into context once per session/compaction (until the first `agent_end`), so the agent treats Superpowers as already-loaded instead of re-reading the skill — a Pi-port of upstream `.pi/extensions/superpowers.ts`.

Only the Pi extension wrapper (`src/`, `extensions/`, `tests/`, config) is this package's own code. Ported skill bodies are pin-guarded (ADR-0004): local edits are a deliberate, logged act (rebaseline + UPSTREAM.ref divergence row), never a casual reformat (the `skills` dir is excluded from biome for that reason).

## How it works

1. `resources_discover` → hands Pi the package's `skills/` dir (individual non-excluded skill dirs when the exclude set is non-empty); skills load natively as Pi skills.
2. `session_start` / `session_compact` → re-arm bootstrap injection.
3. `context` → if armed and the bootstrap is absent from the visible messages, insert the `using-superpowers` payload (skill body + a Pi tool-mapping note + path/routing overrides) right after any leading `compactionSummary` messages.
4. `agent_end` → stand down for the rest of the session.

No slash commands, no coordination globals — Superpowers is skill-driven, not command-driven (contrast with [`@repo/s2-agent-ext-wayfind`](../s2-agent-ext-wayfind)).

## Env knobs

- `BUN_PI_SUPERPOWERS=0` — full-disable the extension (no advertisement, no bootstrap).
- `PI_SUPERPOWERS_SKILL_EXCLUDE` — comma-list of skill dir-names to unregister. A leading `!` token RESETS the accumulated set (drops the defaults): `"!,x"` = defaults-off + exclude exactly `x`; a bare `"!"` = safe no-op reset.
- `PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS=0` — suppress the default exclude list (orthogonal to `!`).

## Related packages

- [**wayfind**](../s2-agent-ext-wayfind/README.md) — decision-chain skills (grilling, wayfinder, domain-modeling) for the decompose-and-decide phase that precedes Superpowers' brainstorming→writing-plans flow.

## Layout

```
extensions/superpowers.ts   # thin Pi entry — delegates to src/index.ts
src/index.ts          # default factory (re-export)
src/superpowers.ts    # discovery + bootstrap logic (port of upstream .pi/extensions/superpowers.ts)
skills/               # 14 skills: 13 pinned upstream ports + repo-native dispatch-recovery (assets — excluded from biome)
tests/                # skills.test.ts (Pi-loader rules) + bootstrap.test.ts (wiring)
```

## Upstream sync

`scripts/update-superpowers.sh` syncs `skills/` from the **Claude plugin cache** (`~/.claude-glm/plugins/cache/...`) — the canonical release artifact matching what Claude Code users receive. The upstream git origin `obra/superpowers` (checked out at `../superpowers/` in this monorepo's parent) is **reference-only** — for reading upstream, never a sync source. Re-syncing is manual and guarded by `tests/skills-fidelity.test.ts` (ADR-0004); see `tests/__fixtures__/upstream-skills/UPSTREAM.ref` for provenance.

## Develop

```bash
( cd bun-apps/s2-agent-ext-superpowers && bun test )          # unit tests
bun run --cwd bun-apps/s2-agent-ext-superpowers check          # biome (excludes skills/)
bun run --cwd bun-apps/s2-agent-ext-superpowers test           # check + test:unit (src entry — no build)
```

## Compatibility

- `@earendil-works/pi-coding-agent` `0.84.2` (peer, per package.json). All five events the extension uses (`resources_discover`, `session_start`, `session_compact`, `agent_end`, `context`) are present.

## License

MIT. Upstream skill content © Primer Radiant / Superpowers contributors, under the upstream license.
