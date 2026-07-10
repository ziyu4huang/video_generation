# Findings — Distill fast-model configuration

> Source goal: `./output/next-goal-20260710-211013.md` (improve distill workflow).
> **⚠ The goal doc's technical premise is partially WRONG.** Investigation below
> corrects it. Read before planning.

## TIER-1 DISCOVERY: Model propagation already WORKS

The goal doc claims "the `model` override doesn't propagate to the subagent" and
that the warning fires "even when `model` is passed." **The code contradicts this.**

`resolveSubagentModel()` in `bun-apps/pi-agent-ext-obsidian/extensions/obsidian.ts:2984`
has a clean precedence:

1. `opts.model` (explicit per-call) → returns immediately, `source:"explicit"`,
   warns ONLY if the id matches a weak pattern. **Does NOT emit the "no subagent
   model configured" warning.**
2. `process.env.OB_SUBAGENT_MODEL` (configured floor) → trusted, no weak check.
3. `process.env.OB_PARENT_MODEL` (inherited parent) → REFUSED if weak.
4. nothing → `source:"default"`, emits the warning.

`buildSubagentArgs()` (`obsidian.ts:2933`) does `if (opts.model) args.push("--model", opts.model)`.
And `pi-knowledge-card.ts:625` passes `{ model: params.model }` into `runSubagentWithRetry`.

**Proof it works:** flux2 distill WITH `--model lm-studio/google/gemma-4-26b-a4b-qat`
→ ✅ completed, 5 cards, 255.8s (findings table). An explicit model reached the child.

→ The "warning persists even with model" note in `.planning/prd-distill/findings.md`
is a **misattribution**: it fired on the runs WITHOUT a model (default path), which
is correct informational behavior, NOT a propagation bug.

## TIER-1 DISCOVERY: `deepseek-v4-flash` is flagged WEAK — must be a FLOOR, not per-call

`WEAK_MODEL_PATTERNS` (`obsidian.ts:2949`) includes `/flash/i`. Simulation:

| model | isWeakModel | consequence |
|-------|-------------|-------------|
| `deepseek/deepseek-v4-flash` | **WEAK** | if passed as `opts.model` → warns "looks like a weak tier" (still used, but noisy) |
| `lm-studio/google/gemma-4-26b-a4b-qat` | ok | clean |
| `zai/glm-5.2` | ok | clean (but SLOW — the real problem) |

**Crucial:** the floor path (step 2, `OB_SUBAGENT_MODEL`) is **never weakness-checked**.
So setting `deepseek-v4-flash` as `OB_SUBAGENT_MODEL` is the *correct* channel — it
silently provides a fast trusted floor with no warning. Setting it via per-call
`--model` is the *wrong* channel (noisy weak-warning).

→ **The goal doc's Phase 3 (hardcode `TOOL_DEFAULT_MODELS.zk_extract = "deepseek-v4-flash"`
as per-call model) is the WRONG approach** — it would route flash through the explicit
path and trip the weak-warning on every distill.

## TIER-1 DISCOVERY: The REAL root cause = slow inherited parent model, no persistent floor

`bun-apps/pi-agent-cli/src/sessions/shared.ts:400`:
```ts
process.env.OB_PARENT_MODEL = `${llm.provider}/${llm.modelId}${thinkingSuffix}`;
```
The parent's model (glm-5.2) is published as `OB_PARENT_MODEL` at session start.
When no `--model` and no `OB_SUBAGENT_MODEL` are set, distill inherits glm-5.2 → SLOW → timeout.

**The config gap:** there is NO settings.json path that sets `OB_SUBAGENT_MODEL`. The
only persistent-ish mechanism is the raw env var, which the user must export per-shell.
`OB_SUBAGENT_MODEL` is unset today (`echo $OB_SUBAGENT_MODEL` → empty).

## TIER-1 DISCOVERY: TWO separate subagent systems — `agentOverrides` does NOT reach distill

- **pi-obsidian `runSubagent`** (`obsidian.ts`) — spawns `pi -p` subprocess; reads
  `OB_SUBAGENT_MODEL` + `OB_PARENT_MODEL`. **THIS is what `zk_extract` / `zk_card` /
  `zk_ask` / `obsidian_distill` / `obsidian_garden` use.**
- **pi-agent-ext-subagents** (`src/agents/*`, `src/runs/shared/model-scope.ts`) — named
  agents; reads `settings.json subagents.agentOverrides`. **NOT used by distill.**

→ Adding `subagents.defaultModel` (goal doc Phase 1) to the *subagents-extension* sense
would NOT reach the distill path. The fix must inject into `OB_SUBAGENT_MODEL`.

## TIER-1 DISCOVERY: Goal doc's file table has WRONG paths

| Goal doc says | Reality |
|---------------|---------|
| `bun-apps/pi-agent-core/src/...` | **does not exist** — core is `bun-apps/pi-agent` + `bun-apps/pi-agent-cli` |
| "fix `runSubagentWithRetry` model propagation" | propagation already correct — no fix needed |
| "add TOOL_DEFAULT_MODELS in pi-knowledge-card.ts" | wrong channel (see flash-is-weak) |

## How settings.json is read today (implementation template)

`passthrough.ts:69` reads `~/.pi/agent/settings.json`:
- `resolveLLMFromArgs()` extracts `defaultProvider` + `defaultModel` (best-effort, try/catch).
- `applyVaultEnv()` sets `OB_VAULT_PATH` / `OB_VAULT_DIR` from `parsed.vault`.

→ **Minimal fix template:** add a sibling that reads a new settings field and sets
`process.env.OB_SUBAGENT_MODEL` at startup (before `OB_PARENT_MODEL` is set in shared.ts).
~10 lines, no schema machinery, mirrors the existing vault-env pattern exactly.

## Timeout reality

`obsidian.ts:3157`: `OB_SUBAGENT_TIMEOUT_MS ?? 5 * 60_000` (5 min, NOT 120s).
The ">120s" in the old findings is approximate perception. Default window is 5 min —
plenty if the model is fast. The bottleneck is MODEL SPEED (glm-5.2/gemma), not the window.

## Approach ranking (revised from goal doc)

| # | Approach | Effort | Persistent? | Verdict |
|---|----------|--------|-------------|---------|
| A | **settings.json field → `OB_SUBAGENT_MODEL`** at startup | ~10 LoC | ✅ settings | **RECOMMENDED** — fixes all zk_* at once, correct channel, no weak-warning |
| B | `export OB_SUBAGENT_MODEL=...` in shell rc / pi env | 0 LoC | shell-only | works TODAY; not in settings.json, machine-specific |
| C | goal doc full plan (TOOL_DEFAULT_MODELS + schema) | high | ✅ | over-engineered, wrong channel for flash |

## Candidate floor models

| model | where | speed | network | weak-flag | notes |
|-------|-------|-------|---------|-----------|-------|
| `deepseek/deepseek-v4-flash` | Z.ai API | fast | yes | WEAK (ok as floor) | goal doc's pick; good for <60s |
| `lm-studio/google/gemma-4-26b-a4b-qat` | local LM Studio | 255s (slow) | no | ok | proven but too slow for batch |
| `zai/glm-5.2` | Z.ai API | slow | yes | ok | current default — the problem |

---
*Updated 2026-07-10 after code investigation of obsidian.ts / shared.ts / passthrough.ts.*
