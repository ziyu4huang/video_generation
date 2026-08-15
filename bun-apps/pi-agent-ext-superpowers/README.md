# pi-agent-ext-superpowers

Pi-native port of [Superpowers](https://github.com/primeradiant/superpowers) — a complete software-development methodology built on composable skills (brainstorming → writing-plans → executing-plans → subagent-driven-development → verification, plus systematic-debugging, test-driven-development, code-review, git-worktrees, etc.).

This package ships Superpowers as a **Layer-3 Pi extension**:

- **14 skills** ported **verbatim** from the upstream repo (`skills/*`).
- A `using-superpowers` **bootstrap** that Pi injects into context once per session/compaction (until the first `agent_end`), so the agent treats Superpowers as already-loaded instead of re-reading the skill — a Pi-port of upstream `.pi/extensions/superpowers.ts`.

Only the Pi extension wrapper (`src/`, `extensions/`, `tests/`, config) is this package's own code. Skill content is kept byte-identical to upstream; do not reformat or rewrite it (the `skills` dir is excluded from biome for that reason).

## How it works

1. `resources_discover` → hands Pi the package's `skills/` dir; all 14 skills load natively as Pi skills.
2. `session_start` / `session_compact` → re-arm bootstrap injection.
3. `context` → if armed and the bootstrap is absent from the visible messages, insert the `using-superpowers` payload (skill body + a Pi tool-mapping note + path/routing overrides) right after any leading `compactionSummary` messages.
4. `agent_end` → stand down for the rest of the session.

No slash commands, no coordination globals — Superpowers is skill-driven, not command-driven (contrast with [`@repo/pi-agent-ext-wayfind`](../pi-agent-ext-wayfind)).

## Related packages

- [**wayfind**](../pi-agent-ext-wayfind/README.md) — decision-chain skills (grilling, wayfinder, domain-modeling) for the decompose-and-decide phase that precedes Superpowers' brainstorming→writing-plans flow.

## Layout

```
extensions/superpowers.ts   # thin Pi entry — delegates to src/index.ts
src/index.ts          # default factory (re-export)
src/superpowers.ts    # discovery + bootstrap logic (port of upstream .pi/extensions/superpowers.ts)
skills/               # 14 skills, byte-identical to upstream (assets — excluded from biome)
tests/                # skills.test.ts (Pi-loader rules) + bootstrap.test.ts (wiring)
```

## Upstream sync

`scripts/update-superpowers.sh` syncs `skills/` from the **Claude plugin cache** (`~/.claude-glm/plugins/cache/...`) — the canonical release artifact matching what Claude Code users receive. The upstream git origin `obra/superpowers` (checked out at `../superpowers/` in this monorepo's parent) is **reference-only** — for reading upstream, never a sync source. Re-syncing is manual and guarded by `tests/skills-fidelity.test.ts` (ADR-0004); see `tests/__fixtures__/upstream-skills/UPSTREAM.ref` for provenance.

## Develop

```bash
( cd bun-apps/pi-agent-ext-superpowers && bun test )          # unit tests
bun run --cwd bun-apps/pi-agent-ext-superpowers check          # biome (excludes skills/)
bun run --cwd bun-apps/pi-agent-ext-superpowers test           # check + test:unit (src entry — no build)
```

## Compatibility

- `@earendil-works/pi-coding-agent` `0.80.7` (peer). All five events the extension uses (`resources_discover`, `session_start`, `session_compact`, `agent_end`, `context`) are present in 0.80.7.

## License

MIT. Upstream skill content © Primer Radiant / Superpowers contributors, under the upstream license.
