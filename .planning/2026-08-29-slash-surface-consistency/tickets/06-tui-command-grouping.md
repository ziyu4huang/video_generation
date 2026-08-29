# 06 — TUI command grouping

blocking: none (but do LAST: benefits from 02/03 renames landing first)

## What

68 slash commands with no grouping signal. Check upstream 0.84.x for existing
grouping support first (pi-coding-agent docs/skills.md, TUI command
registry). If none: manifest-driven listing fed by registry-config.ts
(derived, freshness-gated — never a hand list).

## Done when

- [ ] Upstream-support check recorded (found / not found + source)
- [ ] One command answers "what can I invoke + which family"
- [ ] Data source derived from registry/manifest, gated by freshness test
