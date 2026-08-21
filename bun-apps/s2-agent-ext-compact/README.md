# @repo/s2-agent-ext-compact

Pi extension: compact (scaffolded by `s2-agent ext new` — replace with a real description).

## Develop

```bash
bun test --cwd bun-apps/s2-agent-ext-compact
bun run --cwd bun-apps/s2-agent-ext-compact typecheck
```

## Registration

Registered via `bun-apps/s2-agent/s2-agent.registry.yaml` — one entry
(`load: dynamic` or `load: static`), then `bun run --cwd bun-apps/s2-agent
regen:manifest` (+ `regen:static` for static). The entry point is
`extensions/compact.ts`.

## Self-gate

Set `BUN_PI_COMPACT=0` to disable the extension entirely.
