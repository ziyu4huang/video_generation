# ADR index — every architecture decision record in the repo

> **Rename note (2026-08-21):** the `pi-agent` context was renamed `s2-agent`; its
> ADR IDs are now `ADR-s2-agent-NNNN` (was `ADR-pi-agent-NNNN`, same NNNN).

**There is no unambiguous ADR number in this repo.** Contexts number independently
from `0001`, so `ADR-0001` names **seven** different documents, `ADR-0004` names
five, and every number in use collides at least twice. Cite the **ID**, never the
bare number.

```
bun-apps/s2-agent-ext-wayfind/docs/adr/0004-decouple-status-widget-via-global.md
         └──────────── context ────────────┘      └ number ┘
                        wayfind                      0004      →  ADR-wayfind-0004
```

The ID is derived from the path, declared in the ADR's own header, and checked
against this index by `bun-apps/tests/adr-citation.test.ts` (`bun run test:adr`)
— in both directions, so neither a new ADR nor a deleted one drifts past it.

## Why this exists

PR #1323 read a planning doc's bare "ADR-0001", resolved it to
`ADR-hermes-memory-0001` — which says nothing about dependency direction —
concluded the dep-guard had produced a false positive, and allowlisted a real
ADR violation. Five wayfind files and one superpowers file separately cited an
"ADR-0001" that has never existed in their context. See
[`ADR-monorepo-0001`](0001-strict-downward-edges-knowledge-layer.md) § Recurrence.

## How to cite

| Form | Example | OK? |
| --- | --- | --- |
| Qualified ID | ``ADR-wayfind-0004`` | ✅ preferred, always |
| Markdown link to the file | ``[ADR-0002](./0002-shared-status-widget-and-command-consolidation.md)`` | ✅ inside the owning context |
| Context named beside the number | `the wayfind ADR-0004` | ✅ |
| Bare number, in its own context | `ADR-0004` inside `s2-agent-ext-wayfind/` | ✅ resolves locally — guard verifies it exists |
| Bare number, anywhere else | `dep-direction (ADR-0001)` | ❌ fails `test:adr` |

## Adding an ADR

Number it next-free **within your context**, and put this as the file's first line:

```markdown
**ID:** `ADR-<context>-NNNN` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`
```

Then add its row below. `bun run test:adr` fails until you do.

---

### core-task

| ID | Decision | File |
| --- | --- | --- |
| `ADR-task-0001` | Subagent dock focus via `onTerminalInput` prefix-claim (`Ctrl-G s`, zero upstream changes) | [`s2-agent-ext-task/…/0001`](../../s2-agent-ext-task/docs/adr/0001-subagent-dock-focus-claim.md) |

### core-runtime

| ID | Decision | File |
| --- | --- | --- |
| `ADR-s2-agent-core-runtime-0001` | RunView — destructive convergence of the run read surface | [`s2-agent-core-runtime/…/0001`](../../s2-agent-core-runtime/docs/adr/0001-runview-destructive-convergence.md) |

### hermes-memory

| ID | Decision | File |
| --- | --- | --- |
| `ADR-hermes-memory-0001` | LeanRAG retrieval concepts are ported selectively; the aggregation hierarchy is deferred | [`s2-agent-ext-hermes-memory/…/0001`](../../s2-agent-ext-hermes-memory/docs/adr/0001-leanrag-selective-port.md) |

### monorepo

| ID | Decision | File |
| --- | --- | --- |
| `ADR-monorepo-0001` | Strict downward dependency edges in the knowledge/memory layer | [`bun-apps/docs/adr/0001`](0001-strict-downward-edges-knowledge-layer.md) |

### s2-agent

| ID | Decision | File |
| --- | --- | --- |
| `ADR-s2-agent-0001` | Extensions baked-in as static imports, not loaded via run-dir manifest | [`s2-agent/…/0001`](../../s2-agent/docs/adr/0001-extensions-baked-in-not-manifest.md) |
| `ADR-s2-agent-0002` | Passthrough exists so the binary is its own sub-agent target | [`s2-agent/…/0002`](../../s2-agent/docs/adr/0002-passthrough-is-self-subagent-target.md) |
| `ADR-s2-agent-0003` | Distill keeps the LLM to one in-context stage (Enrich); Gate and Converge are deterministic | [`s2-agent/…/0003`](../../s2-agent/docs/adr/0003-distill-llm-only-in-enrich.md) |
| `ADR-s2-agent-0004` | The knowledge stack keeps two retrieval paths, deliberately not unified | [`s2-agent/…/0004`](../../s2-agent/docs/adr/0004-two-read-paths-deliberately-different.md) |
| `ADR-s2-agent-0005` | Provider catalog sourced from `@repo/s2-agent`, not duplicated or models.json-only | [`s2-agent/…/0005`](../../s2-agent/docs/adr/0005-provider-catalog-from-s2-agent.md) |
| `ADR-s2-agent-0006` | `--dry-run` excludes write tools (deterministic guard, not an LLM instruction) | [`s2-agent/…/0006`](../../s2-agent/docs/adr/0006-dry-run-excludes-write-tools.md) |
| `ADR-s2-agent-0007` | Runtime `-e` loading permitted for headless pack-extensions (amends `ADR-s2-agent-0001`) | [`s2-agent/…/0007`](../../s2-agent/docs/adr/0007-runtime-e-headless-pack-extensions.md) |
| `ADR-s2-agent-0008` | Portable workflow-pack discovery (cwd/bin tiers above repo) | [`s2-agent/…/0008`](../../s2-agent/docs/adr/0008-portable-workflow-pack-discovery.md) |

### subagent

| ID | Decision | File |
| --- | --- | --- |
| `ADR-subagent-0001` | Why the subagent subsystem was extracted into its own package | [`s2-agent-ext-subagent/…/0001`](../../s2-agent-ext-subagent/docs/adr/0001-why-extracted.md) |
| `ADR-subagent-0002` | Relocate the `/subagents` viewer + command into this package | [`s2-agent-ext-subagent/…/0002`](../../s2-agent-ext-subagent/docs/adr/0002-relocate-viewer-command-to-subagent.md) |
| `ADR-subagent-0003` | `SpawnSubagentResult` reports a failure union, not a subprocess exit | [`s2-agent-ext-subagent/…/0003`](../../s2-agent-ext-subagent/docs/adr/0003-failure-union-over-subprocess-vocabulary.md) |
| `ADR-subagent-0004` | Global detach shortcut is `alt+s`, not `ctrl+b` (scoped in-viewer surface keeps `ctrl+b`) | [`s2-agent-ext-subagent/…/0004`](../../s2-agent-ext-subagent/docs/adr/0004-global-detach-shortcut-alt-s.md) |
| `ADR-subagent-0005` | Dispatch budget architecture — tier ceilings, role envelopes, direct-call parity | [`s2-agent-ext-subagent/…/0005`](../../s2-agent-ext-subagent/docs/adr/0005-dispatch-budget-architecture.md) |
| `ADR-subagent-0006` | `/models-preset` is a transient session switch; `~/.pi` stays built-in-pure | [`s2-agent-ext-subagent/…/0006`](../../s2-agent-ext-subagent/docs/adr/0006-models-preset-transient-session-switch.md) |

### superpowers

| ID | Decision | File |
| --- | --- | --- |
| `ADR-superpowers-0004` | Skill fidelity is guarded by a positive content pin, not a denylist | [`s2-agent-ext-superpowers/…/0004`](../../s2-agent-ext-superpowers/docs/adr/0004-skill-fidelity-positive-pin.md) |
| `ADR-superpowers-0005` | The superpowers ↔ wayfind boundary is parallel coexistence, expressed at the injection layer | [`s2-agent-ext-superpowers/…/0005`](../../s2-agent-ext-superpowers/docs/adr/0005-parallel-coexistence-boundary.md) |
| `ADR-superpowers-0006` | The superpowers ↔ subagent cooperation contract | [`s2-agent-ext-superpowers/…/0006`](../../s2-agent-ext-superpowers/docs/adr/0006-superpowers-subagent-cooperation.md) |
| `ADR-superpowers-0007` | Unconditional artifact home — never write to upstream paths | [`s2-agent-ext-superpowers/…/0007`](../../s2-agent-ext-superpowers/docs/adr/0007-unconditional-artifact-home.md) |
| `ADR-superpowers-0008` | Default skill-exclusion policy | [`s2-agent-ext-superpowers/…/0008`](../../s2-agent-ext-superpowers/docs/adr/0008-default-skill-exclusion-policy.md) |
| `ADR-superpowers-0009` | Retire docs/superpowers namespace — .planning is the sole artifact home | [`s2-agent-ext-superpowers/…/0009`](../../s2-agent-ext-superpowers/docs/adr/0009-retire-docs-superpowers-namespace.md) |
| `ADR-superpowers-0010` | Bootstrap token diet — terse repo-owned sections + deferral pointers, budget ratchet | [`s2-agent-ext-superpowers/…/0010`](../../s2-agent-ext-superpowers/docs/adr/0010-bootstrap-token-diet.md) |

> superpowers numbers from `0004`; there is no `ADR-superpowers-0001..0003`.

### tool-gate

| ID | Decision | File |
| --- | --- | --- |
| `ADR-tool-gate-0001` | Escape hatch (`enable_tool`) for dormant gated tools | [`s2-agent-ext-tool-gate/…/0001`](../../s2-agent-ext-tool-gate/docs/adr/0001-escape-hatch-enable-tool.md) |
| `ADR-tool-gate-0002` | Keyword precision — bare-word removal + word-boundary matching | [`s2-agent-ext-tool-gate/…/0002`](../../s2-agent-ext-tool-gate/docs/adr/0002-keyword-precision-bare-word-removal.md) |
| `ADR-tool-gate-0003` | Noun∧verb co-occurrence (`requires`) for core nouns | [`s2-agent-ext-tool-gate/…/0003`](../../s2-agent-ext-tool-gate/docs/adr/0003-requires-co-occurrence-for-core-nouns.md) |
| `ADR-tool-gate-0004` | Opt-in telemetry (`TOOL_GATE_LOG`) | [`s2-agent-ext-tool-gate/…/0004`](../../s2-agent-ext-tool-gate/docs/adr/0004-opt-in-telemetry-tool-gate-log.md) |
| `ADR-tool-gate-0005` | Remove the phantom `cost` gate | [`s2-agent-ext-tool-gate/…/0005`](../../s2-agent-ext-tool-gate/docs/adr/0005-remove-phantom-cost-gate.md) |

### wayfind

| ID | Decision | File |
| --- | --- | --- |
| `ADR-wayfind-0002` | Shared status widget + command consolidation across wayfind and planning-with-files | [`s2-agent-ext-wayfind/…/0002`](../../s2-agent-ext-wayfind/docs/adr/0002-shared-status-widget-and-command-consolidation.md) |
| `ADR-wayfind-0003` | Plan coordinator — designed, not built; owns the `__piPlanPhases` reverse seam / continuous chain | [`s2-agent-ext-wayfind/…/0003`](../../s2-agent-ext-wayfind/docs/adr/0003-plan-coordinator-designed-not-built.md) |
| `ADR-wayfind-0004` | Decouple the status widget via the `globalThis` singleton — no cross-package import | [`s2-agent-ext-wayfind/…/0004`](../../s2-agent-ext-wayfind/docs/adr/0004-decouple-status-widget-via-global.md) |
| `ADR-wayfind-0005` | Accept last-write-wins for `.planning/<effort>/` concurrency | [`s2-agent-ext-wayfind/…/0005`](../../s2-agent-ext-wayfind/docs/adr/0005-accept-last-write-wins-planning-concurrency.md) |
| `ADR-wayfind-0006` | Delete the `__piWayfindActive` coordination seam | [`s2-agent-ext-wayfind/…/0006`](../../s2-agent-ext-wayfind/docs/adr/0006-delete-wayfind-active-coordination-seam.md) |
| `ADR-wayfind-0007` | Solution-extension simplification — 6 methodology skills merged into superpowers; wayfind is the pure decide/wayfinder engine | [`s2-agent-ext-wayfind/…/0007`](../../s2-agent-ext-wayfind/docs/adr/0007-solution-extension-simplification.md) |

> wayfind numbers from 0002; there has never been a wayfind ADR 0001. Code and
> docs that cited "ADR-0001" for the reverse seam / continuous chain meant
> `ADR-wayfind-0003`, which is where that decision actually lives.

### workflow

| ID | Decision | File |
| --- | --- | --- |
| `ADR-workflow-0001` | Pack runtime state is pack-local, never in `~/.pi` | [`s2-agent-ext-workflow/…/0001`](../../s2-agent-ext-workflow/docs/adr/0001-pack-local-state.md) |
| `ADR-workflow-0002` | Pack identity is a path-resolved hash, version-INDEPENDENT | [`s2-agent-ext-workflow/…/0002`](../../s2-agent-ext-workflow/docs/adr/0002-pack-identity-path-hash.md) |
| `ADR-workflow-0003` | Portable name-resolution tiers: cwd/bin rank ABOVE the repo tiers | [`s2-agent-ext-workflow/…/0003`](../../s2-agent-ext-workflow/docs/adr/0003-portable-name-resolution-tiers.md) |
| `ADR-workflow-0004` | acorn is an irreducible runtime dependency (not replaceable by Bun/`node:vm`) | [`s2-agent-ext-workflow/…/0004`](../../s2-agent-ext-workflow/docs/adr/0004-acorn-is-irreducible.md) |
