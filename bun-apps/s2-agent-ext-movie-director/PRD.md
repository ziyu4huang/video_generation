# PRD — s2-agent-ext-movie-director

## Problem

OpenMontage is agent-first: Python tools + MD stage-director skills + the agent as orchestrator. Our repo already has native Swift/MLX directors (flux2, krea2, ltx-video) and an agent runtime (pi). The rewrite needs a unified orchestration layer: pipeline manifest loader, gate-enforced checkpoints, artifact schema validation, budget tracker, and provider registry.

## Solution

Instruction-driven (agent-first) video production pipeline rewritten from OpenMontage Python into pure Bun + Swift-MLX-native. One `movie` dispatcher tool (18 commands) covering: pipeline manifest loading, checkpoint gates with human-approval enforcement, artifact schema validation via ajv over bundled schemas, cost estimation/reserve/reconciliation, and an explicit provider registry.

## Tools

| Tool | Commands | Description |
|------|----------|-------------|
| `movie` | 18 subcommands | Pipeline orchestration: manifest, checkpoint, schema, cost, registry, paths |

## Key Dependencies

- `s2-agent` (run-dir manifest)
- Native directors (flux2, krea2, ltx-video) — called by orchestration stages
- ffmpeg (fabrication stage)
- Bundled OpenMontage manifests and schemas (`data/`)

## Use

```bash
# Loaded via s2-agent's run-dir manifest automatically
pi -e bun-apps/s2-agent-ext-movie-director
```
