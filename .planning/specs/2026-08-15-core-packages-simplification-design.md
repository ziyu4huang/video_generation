# Core packages simplification — design

Date: 2026-08-15
Scope: `bun-apps/pi-agent`, `pi-agent-ext-core-task`, `pi-agent-ext-core-runtime`,
`pi-agent-ext-core-interface`, `pi-agent-ext-power-tool`
Constraint given: breaking changes are acceptable where they pay for themselves.

## Goal

Reduce the cognitive and context cost of the five core packages along four axes the
owner selected: delete unused surface, split god files, redraw package boundaries,
and cut per-session schema cost.

## Measured starting state

| Package | src | test | md |
|---|---:|---:|---:|
| `pi-agent` | 12,545 (64 files) | 10,298 | 5,608 |
| `pi-agent-ext-core-task` | 10,651 (83 files) | 11,317 | 3,562 |
| `pi-agent-ext-core-runtime` | 3,321 (17 files) | 2,654 | 59 |
| `pi-agent-ext-power-tool` | 3,203 (23 files) | 3,097 | 3,036 |
| `pi-agent-ext-core-interface` | 601 (7 files) | 238 | 0 |

## Findings that shaped the design

These are recorded because three of them contradicted the initial framing, and the
next person to look at this will otherwise re-derive them.

1. **`core-interface` is a healthy hub, not ceremony.** 601 lines, but 17 packages
   depend on it. Excluded from scope — it is left untouched.

2. **The `inspect_*` tools are already gated.** All six carry a byte-identical
   `gating` block (same keywords, nouns, verbs), pinned by
   `src/tools/__tests__/inspect-hooks.gating.test.ts`. Note the sixth copy lives
   outside `src/tools/` — `inspect_pathology`'s is in `src/pathology/index.ts:41` —
   so the shared constant in 2a must sit somewhere both trees can import.
   The schema-cost baseline
   (`bun-apps/pi-agent/baselines/schema-cost-baseline.json`, 30 tools / 10,579
   tokens) measures the **ungated full surface**, not per-session cost. Any claim
   that power-tool costs ~800 tokens every session is wrong.

3. **The vault/zk CLI commands compose each other at the command level**, not the
   library level. `pdf-to-vault` imports `file2mdCommand` and `zkExtractCommand`;
   `image-to-vault` imports `pdfToVaultCommand`. The full graph:

   ```
   image-to-vault ──▶ pdf-to-vault ──▶ file2md, zk-extract    (cluster A, 863 lines)
   memory-to-vault ──▶ memory-to-vault-discover, -script      (cluster B, 495 lines)
   tools-metrics ──▶ schema-cost                              (cluster C, 865 lines)
   ```

   Clusters A and B are genuine cross-extension orchestrators (B spans
   knowledge-card + obsidian + subagent + workflow). They cannot be relocated into
   any single extension without inventing a dependency that does not belong.

4. **`ExtensionSubcommandSpec` only models agent-turn commands.** `runner.ts` is
   hardwired to `resolve LLM → build task → createSharedSession → run one turn`.
   Deterministic commands (`tools-metrics`, `schema-cost`, `zk-query`, `zk-ingest`,
   `knowledge-pipeline`, `kcard-loop`) have no contract to migrate onto. This — not
   neglect — is why 16 commands are still hand-written `commands/*.ts`.

5. **`schema-cost.ts` already imports its own domain types from power-tool**
   (`@repo/pi-agent-ext-power-tool/schema-cost`). The library lives in power-tool;
   only the CLI shell was left behind in pi-agent.

6. **No command is dead.** Owner confirmed all 16 vault/zk commands are in use, and
   git history gives no usage signal (all 21 arrived in one squash on 2026-08-12,
   PR #1257). There is nothing to delete; the surface reduction comes from
   relocation and consolidation only.

## Approach

Three steps, executed inside-out. Each is independently shippable, and each gets its
own implementation plan — this spec is deliberately larger than one plan's worth of
work, and splitting it at the step boundaries is the intended decomposition.

### Step 1 — Split three god files

Shared principle: **the original file stays as the facade and re-exports every
extracted symbol**, so no test and no consumer changes. This is not a new pattern —
`goal.ts:82-90` already re-exports from `format` / `overflow` / `commands` /
`prompts`, and `overflow.ts`'s header records that a prior extraction deliberately
kept `from "./goal.js"` intact.

Preconditions verified: `agent.ts` has zero module-level mutable state; no package
deep-imports core-runtime internals (all consumers go through the `index.ts` barrel);
`resolve.ts` has exactly two real consumers (`src/index.ts`,
`patches/load-run-dir-resources.ts`).

#### 1a — `core-task/src/goal/goal.ts`: 1,522 → ~200

| New module | Contents | ~lines |
|---|---|---:|
| `goal/internals.ts` | the ~35 shared tail helpers (`updateStatus`, `setAndPersistGoal`, `abortCurrentTurn`, `clearActiveGoal`, …) | 220 |
| `goal/goal-complete-tool.ts` | the inline `goalCompleteTool` definition (current 182–480) | 300 |
| `goal/hooks.ts` | the six `pi.on(...)` handlers (current 665–938; `agent_end` alone is 160) | 275 |
| `goal/lifecycle.ts` | `startGoal` / pause / resume / clear / edit / show | 260 |
| `goal/timers.ts` | status-refresh timer + heartbeat timer | 90 |
| `goal/prompting.ts` | the `sendXPrompt` family + continuation-marker tracking | 200 |
| `goal.ts` (kept) | facade re-exports, `StatusContext`, `default function goal()` wiring, `isGoalActive`, `planningGateBlocking`, `planProgressLineFromPeer` | ~200 |

**The one real risk: an import cycle.** `hooks.ts` needs the tail helpers while
`goal.ts` needs `hooks.ts`'s registration. Therefore `internals.ts` must be
extracted **first**, giving a strictly one-way graph:

```
goal.ts → hooks / lifecycle / timers / prompting → internals → state
```

The three module-level bindings in `goal.ts` (`goalOverlay`, `piRef`, `auditRunner`)
move into the existing `goalState` singleton in `state.ts`, which already exports
`GoalRuntimeState` and `__resetGoalState()`.

#### 1b — `core-runtime/src/agent.ts`: 1,146 → ~450

| Action | Contents | ~lines |
|---|---|---:|
| merge into existing `structured-output.ts` | `findJsonBlock`, `extractValidated`, `StructuredSession`, `resolveStructuredOutput` | 52 → 200 |
| new `agent-budget.ts` | budget types, `checkBudgetExhaustion`, `checkBudgetWarning`, `createBudgetGuard`, constants | 320 |
| new `agent-turns.ts` | `TurnGuard`, `createTurnGuard`, `turnExhaustionError` | 85 |
| new `agent-model.ts` | `resolveAgentModelSpec`, `resolveFallbackModel`, `listAvailableModelSpecs` | 135 |
| `agent.ts` (kept) | `CoreAgent`, its option/result types, `lastAssistantError`, `throwIfProviderLimit` | ~450 |

The seams are corroborated by the existing test layout: `budget-guard.test.ts` (422)
and `agent-turns.test.ts` (325) are already split along exactly these lines. Only
`index.ts`'s re-export sources change; external consumers are unaffected.

#### 1c — `pi-agent/run-dir/resolve.ts`: 822 → ~380

| New module | Contents | ~lines |
|---|---|---:|
| `run-dir/deps-probe.ts` | dependency probing, auto-install, missing-deps guide output | 260 |
| `run-dir/lazy-extensions.ts` | `looksLikeAlias`, `resolveLazyExtension`, `rewriteArgvLazyExtensions` | 135 |
| `resolve.ts` (kept) | layout detection + argv building (three modes) + re-exports | ~380 |

Suggested order if serialized: `agent.ts` (safest, tests pre-aligned) → `resolve.ts`
→ `goal.ts` (needs the cycle care above).

### Step 2 — power-tool

**2a — De-duplicate gating.** Six verbatim copies of the same `gating` block, held
in place by a test asserting they stay identical. Extract to one shared constant in
`src/gating.ts` (package root, not `src/tools/`, because `src/pathology/index.ts`
carries the sixth copy); rewrite the test to assert each tool references that
constant instead of asserting textual equality.

**2b — Collapse six `inspect_*` tools into one `inspect` tool with a `subject`
enum.** Report implementations are kept as-is; only the tool shells merge.
Diagnostic-turn schema drops from ~1,000 to ~250 tokens. **This renames the tools**
(`inspect_pathology` → `inspect(subject: "pathology")`) — accepted by the owner.
`extensions/cli-subcommand.ts`'s `POWER_TOOLS` allowlist and its header comment
(which still says "4 diagnostic tools" while six are registered) are updated in the
same change.

**2c — Move `tools-metrics` (615) + `schema-cost` (250) into power-tool.** Uses the
new contract below. Removes 865 lines from pi-agent and gives tool introspection a
single owner — the domain library is already there.

### Step 3 — knowledge-card

| Command | lines | contract |
|---|---:|---|
| `zk-ask` | 115 | existing `ExtensionSubcommandSpec` (agent-turn) |
| `zk-card` | 183 | existing `ExtensionSubcommandSpec` (agent-turn) |
| `zk-query` | 226 | new `ExtensionCommandSpec` |
| `zk-ingest` | 155 | new `ExtensionCommandSpec` |
| `knowledge-pipeline` | 354 | new `ExtensionCommandSpec` |
| `kcard-loop` | 245 | new `ExtensionCommandSpec` |

Total: 1,278 lines leave pi-agent.

### Shared prerequisite — `ExtensionCommandSpec` (~40 lines, new)

The deterministic sibling of `ExtensionSubcommandSpec`, living beside it in
`pi-agent/src/cli/extensions/types.ts`:

```ts
export interface DeterministicCommandInput {
  positionals: string[];
  flags: Record<string, string | boolean | undefined>;
}

export interface ExtensionCommandSpec {
  name: string;
  summary: string;
  details: string;
  run: (input: DeterministicCommandInput) => Promise<void>;
}
```

The input is a narrow structural type for the same reason `SubcommandTaskInput` is:
an extension package must not import `ParsedArgs`, which would create a reverse
workspace dependency on pi-agent. `registry.ts` gains a second list and
`dispatch.ts` treats both uniformly, exactly as it already does for
`EXTENSION_COMMANDS`.

This is the only **new** mechanism in the design. It is explicitly a trade: 40 lines
of contract to enable 2,143 lines to leave pi-agent.

## Deliberately not changed

Recorded in `pi-agent/CONTEXT.md` so this is not re-litigated:

- **Cluster A** — `image-to-vault → pdf-to-vault → file2md, zk-extract` (863 lines)
- **Cluster B** — `memory-to-vault` + `-discover` + `-script` (495 lines)
- **`url-to-vault` / `youtube-to-vault`** — span web-access + knowledge-card
- **`core-interface`** — 17 dependents, healthy hub

Rationale, stated once: *a cross-extension orchestrator belongs to the layer above
the extensions, and pi-agent is that layer.*

## Outcome

| Metric | before | after |
|---|---:|---:|
| `pi-agent` src | 12,545 | ~10,440 (−17%) |
| three god files | 3,490 | ~1,030 |
| new focused modules | — | 11 (6 goal + 3 agent + 2 run-dir) + `gating.ts` |
| new contracts | — | 1 |
| diagnostic-turn schema | ~1,000 | ~250 |

Interfaces preserved everywhere except the `inspect_*` rename (2b) and the CLI
commands' owning package (2c, Step 3) — the command tokens themselves are unchanged,
so `pi <cmd>` keeps working.

## Testing

- Step 1 requires **no test changes**: facades preserve every import path. A test
  file that needed editing would be evidence the facade was broken.
- Step 2a rewrites one assertion (`verbatim identical` → `references the shared
  constant`).
- Step 2b requires new tests for `subject` dispatch, and the existing per-tool tests
  are re-pointed at the merged tool.
- Steps 2c and 3 move each command's existing tests with the command.
- Gates: each touched package's canonical `bun run test`, plus `tsc --noEmit`
  (`bun run check` for devops-style packages), plus `local_ci` before merge.
