### Task 2: Slim the `subagent` + `subagent_runs` tool schemas (TDD)

**Files:**
- Create: `bun-apps/pi-agent-ext-subagent/tests/subagent-schema-weight.test.ts`
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` (the `subagentToolSchema` descriptions)
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-runs-tool.ts`

**Interfaces:**
- Consumes: `subagentToolSchema` (current 16-param Type.Object).
- Produces: same 16 params, same types/optionality — only `description` strings shrink.

- [ ] **Step 1: Write the failing weight + shape test**

Create `bun-apps/pi-agent-ext-subagent/tests/subagent-schema-weight.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { subagentToolSchema } from "../src/subagent-tool.ts";

const PARAMS = (subagentToolSchema as any).properties as Record<string, { type: string; description: string }>;
const EXPECTED = [
  "agent","agentType","task","model","tier","cwd","tools","excludeTools",
  "timeoutMs","tokenBudget","spendBudget","retryOnTransient","commitScope","schema","schemaRepairAttempts",
];

describe("subagent tool schema — slimmed weight", () => {
  it("keeps every parameter with its optionality and type", () => {
    for (const name of EXPECTED) {
      expect(PARAMS[name], `missing param ${name}`).toBeDefined();
    }
    // task is required; all others optional
    const required = (subagentToolSchema as any).required as string[];
    expect(required).toEqual(["task"]);
  });

  it("each description is terse (< 240 chars) — was up to ~360", () => {
    for (const name of EXPECTED) {
      const len = PARAMS[name].description.length;
      expect(len, `${name} desc ${len} chars`).toBeLessThan(240);
    }
  });

  it("preserves load-bearing semantic warnings (not just truncated)", () => {
    const joined = Object.values(PARAMS).map((p) => p.description).join("\n");
    // These phrases MUST survive the slim — they prevent real misuse.
    expect(joined).toContain("NO access to this session's history");   // task
    expect(joined).toContain("only pass a model you know is configured"); // model
    expect(joined).toContain("never auto-reverts");                    // commitScope
    expect(joined).toContain("non-recoverable");                       // tokenBudget
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

```bash
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-schema-weight.test.ts )
```
Expected: FAIL — current descriptions exceed 240 chars (e.g. `commitScope` ~510 chars) and the load-bearing phrases check may pass already (they exist) but the length ceiling fails.

- [ ] **Step 3: Slim the descriptions**

In `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`, replace each `description:` in `subagentToolSchema` with the terse form (semantics identical, every load-bearing phrase preserved):

```ts
agent:          "Role label (e.g. 'reviewer'); forwarded as an instructions prefix, doesn't change tool selection.",
agentType:      "Named agent def (.pi/agents/<name>.md) binding tools/model/prompt/worktree-isolation. Explicit model/tools/excludeTools here override the binding.",
task:           "Full self-contained prompt — the child has NO access to this session's history (include goal, context, constraints, return format).",
model:          "Model override `provider/model-id`. Prefer omitting (uses the session's current model) or set `tier`; an unauthed id warns and falls back. Only pass a model you know is configured.",
tier:           "Model tier: 'small'|'medium'|'big'. Omit to inherit the session model; explicit `model` takes priority.",
cwd:            "Child working directory (defaults to parent session cwd).",
tools:          "Tool allowlist, e.g. ['read','grep','find','ls'] for read-only. Omit for the default coding toolset.",
excludeTools:   "Tools to deny after the allowlist, e.g. ['edit','write'].",
timeoutMs:      "Abort after this many ms (wall-clock). Omit for no timeout.",
tokenBudget:    "Abort once cumulative token usage exceeds this (bounds a looping child timeoutMs can't catch; per-turn check, may overshoot one turn; non-recoverable).",
spendBudget:    "Abort once cumulative cost ($) exceeds this (pairs with tokenBudget; same per-turn check).",
retryOnTransient:"Retry once on transient failure (timeout/network/rate-limit/schema). Default true.",
commitScope:    "Commit-path allowlist (prefix-matched). After the run, flags any committed path outside this scope as a ⚠ violation (detection only, never auto-reverts; best-effort). Use [] to flag any commit. Ignored for worktree-isolated runs.",
schema:         "JSON Schema for the child's final answer; when set, the child returns via structured_output and the result is the JSON-serialized object.",
schemaRepairAttempts: "Max repair re-prompts when the child returns prose instead of structured_output (default 2). Bump for models that emit structured output unreliably.",
```

Then apply the same terse-edit pass to `subagent_runs` params in `src/subagent-runs-tool.ts` (target each `description` < 200 chars; preserve the action enum semantics).

- [ ] **Step 4: Run the weight test — verify it passes**

```bash
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-schema-weight.test.ts )
```
Expected: PASS — all params present, `required: ["task"]`, every description < 240 chars, load-bearing phrases present.

- [ ] **Step 5: Run the full subagent suite — verify no behavioral regression**

```bash
( cd bun-apps/pi-agent-ext-subagent && bun test )
```
Expected: all green incl. `regression-subagent-contract.test.ts` (pins behavior, not description prose) + `extension-subagent-registration.test.ts`.

- [ ] **Step 6: Measure the token drop**

```bash
bun scripts/probe-runner.ts --self-test-schema 2>/dev/null || true
# Authoritative: rebuild + inspect
( cd bun-apps && bun install )
bun --cwd bun-apps/pi-agent run inspect:extensions 2>/dev/null || \
  bun -e 'console.log("re-run inspect_extensions after rebuild to confirm subagent ~1004 -> ~450 tok")'
```
Expected: `subagent` tool drops from ~1,004 to ~450 tok.

- [ ] **Step 7: Commit**

```bash
( cd bun-apps/pi-agent-ext-subagent && git add src/subagent-tool.ts src/subagent-runs-tool.ts tests/subagent-schema-weight.test.ts && \
  git commit -m "refactor(subagent): slim tool param descriptions (~550 tok/req)" )
```

---

