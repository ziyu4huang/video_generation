# autocompact A/B harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic, hermetic, one-command A/B harness measuring how `/autocompact` (absolute threshold, `agent_settled`) interacts with upstream pi 0.84.4 auto-compaction (relative threshold, mid-run + boundary), producing a report + verdict (keep / reposition / retire / collision-guard).

**Architecture:** One bun test file in `s2-agent-ext-power-tool` builds a real `AgentSession` via the SDK with three inline extension factories — the real power-tool factory (imported from `src/index.ts`, guaranteeing module identity with the harness's `setThreshold` import), a ScriptedProvider extension (pi-ai `createProvider`, provider-reported `usage` drives the exact context-token curve), and a recorder extension (`session_compact` / `session_compact_failed` / `agent_settled` / `turn_end` → rows). Four arms run in hermetic temp `agentDir`s whose `settings.json` pins `compaction.reserveTokens`.

**Tech Stack:** Bun test, `@earendil-works/pi-coding-agent` SDK (`createAgentSession`, `DefaultResourceLoader`), `@earendil-works/pi-ai` (`createProvider`, `createAssistantMessageEventStream`).

**Spec:** `.planning/specs/2026-08-30-autocompact-ab-harness-design.md`

## Global Constraints

- pi deps are exact-pinned 0.84.4 in `bun-apps/s2-agent/package.json`; do NOT touch versions.
- No network, no `~/.pi/agent` writes, no LM Studio — everything hermetic under `fs.mkdtemp`.
- Harness lives at `bun-apps/s2-agent-ext-power-tool/src/__tests__/autocompact-ab.test.ts`; nothing under top-level `scripts/` (avoids `scripts-dir-contract.test.ts` allowlist trap).
- Canonical gate: `( cd bun-apps/s2-agent-ext-power-tool && bun run test )` — the harness must stay seconds-fast (local_ci ≤ 5 min rule).
- CI asserts structural invariants only (arms complete, validity gate); measured numbers print to stdout, never gated.
- Repo shell rule: never top-level `cd` — use `( cd bun-apps/s2-agent-ext-power-tool && ... )`.
- `session_compact` reason semantics (the report's attribution axis): `"threshold"` = upstream auto-compaction; `"manual"` = our ext's `ctx.compact()` call.

---

### Task 1: Smoke proof — ScriptedProvider drives one real turn

**Files:**
- Create: `bun-apps/s2-agent-ext-power-tool/src/__tests__/autocompact-ab.test.ts`

**Interfaces:**
- Produces: `makeScriptedModel()` → pi-ai `Model` with `{ id: "scripted-1", provider: "scripted", contextWindow: 128_000, maxTokens: 8_192, reasoning: false, input: ["text"] }`; `smokeSession()` helper later tasks reuse.
- Verifies the two ordering risks from the spec (model/extension registration order; AssistantMessageEvent sequence).

- [ ] **Step 1: Write the failing smoke test**

```ts
/**
 * autocompact A/B harness — real AgentSession + ScriptedProvider (no network).
 * Spec: .planning/specs/2026-08-30-autocompact-ab-harness-design.md
 * Arms S1–S4 + validity gate live in Task 4; this file grows task by task.
 */
import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import powerToolFactory from "../index.ts";

const SCRIPTED_MODEL = {
  id: "scripted-1",
  name: "Scripted 1",
  provider: "scripted",
  reasoning: false,
  input: ["text"],
  contextWindow: 128_000,
  maxTokens: 8_192,
} as const;

/** Minimal scripted assistant payload; add fields (e.g. timestamp) if the
 *  AssistantMessage interface demands them — Task 1 Step 2 covers that. */
interface ScriptedMessage {
  role: "assistant";
  content: string;
  stopReason: "stop" | "toolCall";
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function makeScriptedProvider(respond: (context: unknown) => ScriptedMessage) {
  return createProvider({
    id: "scripted",
    name: "scripted",
    auth: { type: "apiKey", apiKey: "scripted" },
    models: [SCRIPTED_MODEL],
    api: {
      stream: (_model, context) => {
        const message = respond(context);
        const s = createAssistantMessageEventStream();
        queueMicrotask(() => {
          // Mirror the minimal openai-completions adapter sequence; if the
          // agent loop demands different event types, Task 1 Step 2 surfaces it.
          s.push({ type: "start" });
          s.push({ type: "message_end", message });
          s.end(message);
        });
        return s;
      },
    },
  });
}
```

The smoke test itself: one turn driven entirely by the scripted provider —
a single assistant response ends it. Assert `session.messages` contains the
assistant entry and the run settled without error. (Tool-loop depth is proven
by Task 2's test; the smoke only proves session + provider + event wiring.)

```ts
describe("autocompact A/B harness", () => {
  test("smoke: scripted provider drives a real tool-loop turn", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "ac-ab-"));
    try {
      const scriptedProviderExt: InlineExtension = {
        name: "scripted-provider",
        factory: (pi) => {
          pi.registerProvider(makeScriptedProvider(() => ({
            role: "assistant",
            content: "smoke",
            stopReason: "stop",
            usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
          })));
        },
      };
      const loader = new DefaultResourceLoader({
        cwd: agentDir,
        agentDir,
        extensionFactories: [scriptedProviderExt],
      });
      await loader.reload();
      const { session } = await createAgentSession({
        resourceLoader: loader,
        model: SCRIPTED_MODEL as never,
        sessionManager: undefined, // in-file sessions under agentDir
      });
      await session.prompt("smoke");
      expect(session.messages.some((m) => m.role === "assistant")).toBe(true);
      session.dispose();
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL, then fix against reality**

Run: `( cd bun-apps/s2-agent-ext-power-tool && bun test src/__tests__/autocompact-ab.test.ts )`

Expected first run: FAIL on one of the two known ordering risks. Fix in this
order (both fixes stay inside this file):
1. If `model: SCRIPTED_MODEL` is rejected (provider not yet registered at
   option-resolution time): drop the `model` option and instead call
   `await pi.setModel(SCRIPTED_MODEL)` inside the factory AFTER
   `registerProvider`.
2. If the agent loop rejects the event sequence: read the real minimal
   sequence from
   `bun-apps/s2-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts`
   (`AssistantMessageEvent` union) and adjust the pushed events — keep
   `s.end(message)` last.
3. If `AssistantMessageLike` shape mismatches (e.g. `timestamp` required),
   add the field from the `AssistantMessage` interface in the same types file.

Expected end state: PASS, and `powerToolFactory` can be added to
`extensionFactories` alongside `scriptedProviderExt` without error (extend
the array in the same run; assert `pi` wiring by checking the session starts).

- [ ] **Step 3: Commit**

```bash
git add bun-apps/s2-agent-ext-power-tool/src/__tests__/autocompact-ab.test.ts
git commit -m "test(power-tool): autocompact A/B smoke — scripted provider drives a real turn"
```

---

### Task 2: Usage-curve script + emit_blob tool + compaction-summary lane

**Files:**
- Modify: `bun-apps/s2-agent-ext-power-tool/src/__tests__/autocompact-ab.test.ts`

**Interfaces:**
- Produces:
  - `interface ScriptStep { content: string; toolCall?: { args: { size: number } }; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }`
  - `const PROVOCATION_SCRIPT: ScriptStep[]` — 8 tool loops walking context tokens 5k → 70k, then a final text-only step (exact numbers in code below).
  - `const EMIT_BLOB_TOOL` — a `customTools` entry named `emit_blob` returning `"x".repeat(size)`.
  - `makeScriptedProviderFromScript(script: ScriptStep[])` — pops script steps for normal turns; when the request is a compaction summarizer call (detection below), returns a fixed summary with small usage instead of popping.

- [ ] **Step 1: Write the failing test (curve reaches tool-loop depth)**

```ts
// Usage curve: contextTokens after each assistant response.
// _checkCompaction uses calculateContextTokens(usage) = totalTokens || input+output+cacheRead+cacheWrite.
const USAGE_CURVE = [5_000, 12_000, 20_000, 30_000, 42_000, 55_000, 63_000, 70_000];
const BLOB_SIZE = 4_000; // large tool result = #6879 trigger condition

const PROVOCATION_SCRIPT: ScriptStep[] = USAGE_CURVE.map((contextTokens, i) => ({
  content: `step ${i}`,
  toolCall: i < USAGE_CURVE.length - 1 ? { args: { size: BLOB_SIZE } } : undefined,
  usage: { input: contextTokens - 500, output: 400, cacheRead: 0, cacheWrite: 100 },
}));
const FINAL_STEP: ScriptStep = {
  content: "done",
  usage: { input: 70_000, output: 100, cacheRead: 0, cacheWrite: 0 },
};

function isSummarizerCall(context: { messages?: Array<{ role: string; content?: unknown }> }): boolean {
  const first = context.messages?.[0];
  return first?.role === "system" && String(first.content).toLowerCase().includes("summar");
}
```

Test: drive one session with `PROVOCATION_SCRIPT`; assert the turn completes
and `session.messages` shows ≥ 6 tool-result entries (the loop actually ran
deep). This fails before the script/tool wiring exists.

- [ ] **Step 2: Implement script + tool, verify pass**

Wire `emit_blob` via `createAgentSession({ customTools: [EMIT_BLOB_TOOL] })`:

```ts
const EMIT_BLOB_TOOL = {
  name: "emit_blob",
  description: "Returns a blob of the requested size (A/B harness).",
  parameters: {
    type: "object",
    properties: { size: { type: "number", description: "blob length in chars" } },
    required: ["size"],
  },
  execute: async (args: { size: number }) => ({
    content: [{ type: "text", text: "x".repeat(args.size) }],
  }),
};
```

`makeScriptedProviderFromScript` holds a mutable cursor; in `stream()`:
`isSummarizerCall(context)` → return fixed `{ role: "assistant", content: "[A/B summary] compacted", stopReason: "stop", usage: { input: 1_500, output: 100, cacheRead: 0, cacheWrite: 0 } }`; else pop the next step (throw `Error("script exhausted")` when empty — loud, never silent). Map each step to the streamed message (field names per the `AssistantMessage` interface verified in Task 1):

```ts
const message = step.toolCall
  ? {
      role: "assistant",
      content: [{ type: "text", text: step.content }],
      toolCalls: [{ id: `call-${cursor}`, name: "emit_blob", arguments: step.toolCall.args }],
      stopReason: "toolCall",
      usage: step.usage,
    }
  : { role: "assistant", content: [{ type: "text", text: step.content }], stopReason: "stop", usage: step.usage };
```

Run: `( cd bun-apps/s2-agent-ext-power-tool && bun test src/__tests__/autocompact-ab.test.ts )` → PASS.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/s2-agent-ext-power-tool/src/__tests__/autocompact-ab.test.ts
git commit -m "test(power-tool): A/B script — usage curve, emit_blob, summarizer lane"
```

---

### Task 3: Recorder extension + context-token capture

**Files:**
- Modify: `bun-apps/s2-agent-ext-power-tool/src/__tests__/autocompact-ab.test.ts`

**Interfaces:**
- Produces:
  - `interface AbRow { arm: string; event: "compact" | "compact_failed" | "settled" | "turn_end"; reason?: "manual" | "threshold" | "overflow"; contextTokens: number | null; loopIndex: number }`
  - `makeRecorder(arm: string, rows: AbRow[])` → `InlineExtension` (name `"ab-recorder"`) subscribing `session_compact`, `session_compact_failed`, `agent_settled`, `turn_end`; `contextTokens` from `ctx.getContextUsage()?.tokens ?? null`; `loopIndex` = count of `turn_end` rows so far.

- [ ] **Step 1: Write the failing test**

Inject a `threshold` compaction by running the Task-2 script with a
`settings.json` `{ "compaction": { "enabled": true, "reserveTokens": 68_000 } }`
written into the arm's temp `agentDir` before `createAgentSession`. Assert:
`rows` contains ≥ 1 `{ event: "compact", reason: "threshold" }` row whose
`contextTokens` is > 60_000, and ≥ 1 `settled` row.

- [ ] **Step 2: Implement recorder, verify pass**

```ts
function makeRecorder(arm: string, rows: AbRow[]): InlineExtension {
  return {
    name: "ab-recorder",
    factory: (pi) => {
      let turnEnds = 0;
      const snap = (ctx: { getContextUsage?: () => { tokens: number | null } | undefined }) =>
        ctx.getContextUsage?.()?.tokens ?? null;
      pi.on("turn_end", (e: never, ctx: never) => {
        rows.push({ arm, event: "turn_end", contextTokens: snap(ctx), loopIndex: turnEnds++ });
      });
      pi.on("session_compact", (e: { reason: AbRow["reason"] }, ctx: never) => {
        rows.push({ arm, event: "compact", reason: e.reason, contextTokens: snap(ctx), loopIndex: turnEnds });
      });
      pi.on("session_compact_failed", (e: { reason: AbRow["reason"] }, ctx: never) => {
        rows.push({ arm, event: "compact_failed", reason: e.reason, contextTokens: snap(ctx), loopIndex: turnEnds });
      });
      pi.on("agent_settled", (_e: never, ctx: never) => {
        rows.push({ arm, event: "settled", contextTokens: snap(ctx), loopIndex: turnEnds });
      });
    },
  };
}
```

Run the test → PASS (this also proves the `#6879` mid-run path is reachable —
the validity gate's foundation).

- [ ] **Step 3: Commit**

```bash
git add bun-apps/s2-agent-ext-power-tool/src/__tests__/autocompact-ab.test.ts
git commit -m "test(power-tool): A/B recorder — session_compact/agent_settled rows with token snapshot"
```

---

### Task 4: Arms S1–S4 runner + validity gate + report

**Files:**
- Modify: `bun-apps/s2-agent-ext-power-tool/src/__tests__/autocompact-ab.test.ts`

**Interfaces:**
- Consumes: `setThreshold` from `../autocompact.ts` (module identity with the loaded factory is guaranteed because the factory is passed as an inline `extensionFactories` entry imported from `../index.ts` — same module graph, no file-path loader).
- Produces: `runArm(arm: ArmSpec)` → `Promise<AbRow[]>`; `renderReport(rows: AbRow[]): string`; `interface ArmSpec { arm: string; compaction: { enabled: boolean; reserveTokens: number }; extThreshold?: number }`.

- [ ] **Step 1: Write the failing test (full matrix)**

```ts
const ARMS: ArmSpec[] = [
  { arm: "S1-baseline", compaction: { enabled: true, reserveTokens: 68_000 } },
  { arm: "S2-matched", compaction: { enabled: true, reserveTokens: 68_000 }, extThreshold: 60_000 },
  { arm: "S3-standalone", compaction: { enabled: false, reserveTokens: 16_384 }, extThreshold: 50_000 },
  { arm: "S4-niche", compaction: { enabled: true, reserveTokens: 8_000 }, extThreshold: 50_000 },
];
```

Test body: for each arm, `runArm` (fresh temp `agentDir`, `settings.json`
from `arm.compaction`, factories `[powerToolFactory, scriptedProviderExt, makeRecorder(arm, rows)]`,
`customTools: [EMIT_BLOB_TOOL]`, `session.prompt("run the plan")` raced
against a 30 s timeout), collect rows, then:

Validity gate (CI-asserted):
```ts
const s1ThresholdCompacts = rows.filter((r) => r.arm === "S1-baseline" && r.event === "compact" && r.reason === "threshold");
expect(s1ThresholdCompacts.length).toBeGreaterThanOrEqual(1); // else the mock world never reached #6879 — harness invalid
```
Regression guard: `S3-standalone` must contain ≥ 1 `{ event: "compact", reason: "manual" }` row (ext fires alone).

Report (stdout only, never asserted):
```ts
console.log(renderReport(rows));
```

- [ ] **Step 2: Implement runner + report, verify pass**

`runArm` reuses every earlier piece; `setThreshold(session.sessionId, spec.extThreshold)`
arms the ext between session creation and `prompt()`. `renderReport` prints a
per-arm markdown table: compaction count by reason (`threshold` vs `manual`),
contextTokens at each fire, peak `turn_end` tokens, final `settled` tokens,
plus a verdict line computed from the spec's verdict rules:

- S2 has zero `manual` compacts → ext absorbed at matched thresholds.
- S4 has ≥ 1 `manual` compact firing earlier than any S4 `threshold` compact → niche real.
- S4 has zero `manual` compacts → retire signal.
- any arm has a `manual` compact adjacent (same loopIndex) to a `threshold` compact → collision signal.

Run: `( cd bun-apps/s2-agent-ext-power-tool && bun test src/__tests__/autocompact-ab.test.ts )` → PASS; the package's canonical
`( cd bun-apps/s2-agent-ext-power-tool && bun run test )` also passes within its normal duration (harness adds seconds, not minutes).

- [ ] **Step 3: Commit**

```bash
git add bun-apps/s2-agent-ext-power-tool/src/__tests__/autocompact-ab.test.ts
git commit -m "feat(power-tool): autocompact A/B harness — arms S1-S4, validity gate, verdict report"
```

---

### Task 5: Run the A/B, record the measured verdict

**Files:**
- Modify: `.planning/specs/2026-08-30-autocompact-ab-harness-design.md` (append `## Measured (YYYY-MM-DD)` section)
- Modify (only if the verdict is "reposition"): `bun-apps/s2-agent-ext-power-tool/src/autocompact.ts:1-15` header comment + `renderStatus` output to state the low-absolute-threshold niche explicitly.

- [ ] **Step 1: Run the harness and capture the report**

Run: `( cd bun-apps/s2-agent-ext-power-tool && bun test src/__tests__/autocompact-ab.test.ts 2>&1 | tail -60 )`
Capture the full `renderReport` output verbatim.

- [ ] **Step 2: Append the Measured section to the spec**

Paste the report + the verdict the rules selected (keep / reposition / retire /
collision-guard), with the four arms' key numbers. If the verdict is
"reposition", apply the `autocompact.ts` doc-comment + status-output edit in
the same commit. If the verdict is "retire" or "collision-guard", STOP — that
is new work needing its own brainstorm/decision (note it as the section's
"Next" line; do not implement here).

- [ ] **Step 3: Commit**

```bash
git add .planning/specs/2026-08-30-autocompact-ab-harness-design.md bun-apps/s2-agent-ext-power-tool/src/autocompact.ts
git commit -m "docs(planning): autocompact A/B measured verdict"
```
