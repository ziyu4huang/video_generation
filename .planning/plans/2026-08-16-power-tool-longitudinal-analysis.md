# power-tool Longitudinal Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give power-tool a memory — replay the existing pathology detectors over historical session transcripts so agent-behaviour pathology and tool-health regressions can be tracked over time.

**Architecture:** Derive-first. The transcript archive at `~/.pi/agent/sessions/**/*.jsonl` already holds every tool call, its arguments, its error state, and per-turn token usage. A new `src/history/` module scans it, feeds the **existing, unmodified** `analyzePathology()` (already a pure function over `PathologyInput`), and aggregates per-session findings into occurrence-rate series with a regression verdict. A minimal `session_start` sidecar records only environment facts (git sha, pi version, tool fingerprint) that transcripts cannot reconstruct. No derived number is ever stored, so a threshold change re-derives the whole history consistently.

**Tech Stack:** Bun, TypeScript, `bun:test`. No new dependencies.

**Spec:** `.planning/specs/2026-08-16-power-tool-longitudinal-analysis-design.md`

**Measured before planning** (full family corpus, 3,391 transcripts / 491 MB):
full scan 1.0 s · full detector replay 0.94 s · 1,165 sessions contain tool calls ·
base rates long-session 37.0% / consecutive-error 5.7% / error-storm 1.8% /
retry-loop 0.9% / context-saturation 0%.

---

## File Structure

| File | Responsibility |
|---|---|
| `bun-apps/pi-agent-ext-power-tool/src/history/scan.ts` | **Sole** transcript reader. Relocated from `tools-metrics.ts`, then widened to also carry tool-call arguments, per-turn token usage, and the session's model. |
| `bun-apps/pi-agent-ext-power-tool/src/history/replay.ts` | Pure: `SessionScan` → `PathologyInput` → `analyzePathology()`. Owns context-window resolution. |
| `bun-apps/pi-agent-ext-power-tool/src/history/scope.ts` | Pure: decide whether a session's `cwd` belongs to this repo family. |
| `bun-apps/pi-agent-ext-power-tool/src/history/aggregate.ts` | Pure: per-session findings → occurrence-rate series + regression verdicts. |
| `bun-apps/pi-agent-ext-power-tool/src/history/sidecar.ts` | The only new write path: `session_start` environment fingerprint. |
| `bun-apps/pi-agent-ext-power-tool/src/history/index.ts` | Barrel — the package's `./history` export subpath. |
| `bun-apps/pi-agent/src/cli/commands/agent-trends.ts` | CLI shell: filesystem wiring + formatting. |
| `bun-apps/pi-agent/src/cli/commands/tools-metrics.ts` | Modified: its scanner is deleted and imported from power-tool instead. |

**Precondition handling.** The spec names step 2c (relocate `tools-metrics` into
power-tool) as a precondition. Task 1 executes the *thin slice* of 2c that actually
matters here — moving the transcript scanner and pointing `tools-metrics` at it —
rather than waiting for the full command relocation. This keeps the "one reader, two
consumers" invariant from day one. Precedent: `tools-metrics.ts` already imports
`@repo/pi-agent-ext-power-tool/schema-cost`.

---

## Task 1: Relocate the transcript scanner into power-tool

**Files:**
- Create: `bun-apps/pi-agent-ext-power-tool/src/history/scan.ts`
- Create: `bun-apps/pi-agent-ext-power-tool/src/history/index.ts`
- Modify: `bun-apps/pi-agent-ext-power-tool/package.json` (add `./history` export)
- Modify: `bun-apps/pi-agent/src/cli/commands/tools-metrics.ts` (delete scanner, import it)
- Test: `bun-apps/pi-agent-ext-power-tool/src/history/__tests__/scan.test.ts`

- [ ] **Step 1: FREEZE the corpus, then capture a golden baseline**

This is a refactor of code that has no direct test, so real output is the only proof
the move is faithful. **The live archive cannot be used as the baseline**: other
pi-agent sessions on this machine append to their transcripts continuously, so two
runs minutes apart legitimately differ (observed during execution: `calls`
69,639 → 69,641 with the session count unchanged). Diffing against the live tree
produces a false failure and hides real ones.

Freeze a snapshot first — it takes about a second — and point every comparison run
at it with `--sessions-dir`:

```bash
SNAP="$SCRATCH/frozen"
rm -rf "$SNAP" && cp -R ~/.pi/agent/sessions "$SNAP"
find "$SNAP" -name '*.jsonl' | wc -l
bun bun-apps/pi-agent/src/cli.ts cli tools-metrics --sessions-dir "$SNAP" --json > "$SCRATCH/tm-before.json"
wc -c "$SCRATCH/tm-before.json"
```

Expected: a JSON file of tens of KB. If this command fails, stop and fix that
first — the baseline is the only proof this task is safe.

- [ ] **Step 2: Write the failing test**

Create `bun-apps/pi-agent-ext-power-tool/src/history/__tests__/scan.test.ts`:

```typescript
/**
 * Tests for the transcript scanner.
 *
 * parseSessionLines is PURE over an array of raw JSONL lines — no filesystem —
 * so the whole parser is exercised with inline fixtures.
 */
import { test, expect, describe } from "bun:test";
import { parseSessionLines } from "../scan.ts";

/** Build one JSONL line for a `session` header event. */
function sessionLine(cwd: string, ts: string): string {
  return JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: ts, cwd });
}

/** Build one JSONL line for an assistant message carrying toolCall blocks. */
function assistantLine(
  ts: string,
  calls: Array<{ id: string; name: string; arguments?: unknown }>,
): string {
  return JSON.stringify({
    type: "message",
    timestamp: ts,
    message: {
      role: "assistant",
      content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments })),
    },
  });
}

/** Build one JSONL line for a toolResult message. */
function resultLine(ts: string, callId: string, toolName: string, isError = false): string {
  return JSON.stringify({
    type: "message",
    timestamp: ts,
    message: { role: "toolResult", toolCallId: callId, toolName, isError },
  });
}

describe("parseSessionLines", () => {
  test("reads cwd and startedAt from the session event", () => {
    const scan = parseSessionLines([sessionLine("/repo/x", "2026-08-01T00:00:00.000Z")]);
    expect(scan.cwd).toBe("/repo/x");
    expect(scan.startedAt).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
  });

  test("pairs a toolCall with its toolResult by callId", () => {
    const scan = parseSessionLines([
      sessionLine("/repo/x", "2026-08-01T00:00:00.000Z"),
      assistantLine("2026-08-01T00:00:01.000Z", [{ id: "c1", name: "bash" }]),
      resultLine("2026-08-01T00:00:03.000Z", "c1", "bash"),
    ]);
    expect(scan.calls).toHaveLength(1);
    expect(scan.calls[0]!.callId).toBe("c1");
    expect(scan.results).toHaveLength(1);
    expect(scan.results[0]!.t1 - scan.calls[0]!.t0).toBe(2000);
  });

  test("skips malformed lines instead of throwing", () => {
    const scan = parseSessionLines(["{not json", "", sessionLine("/repo/x", "2026-08-01T00:00:00.000Z")]);
    expect(scan.cwd).toBe("/repo/x");
  });

  test("gives a toolResult without a callId a non-pairing synthetic id", () => {
    const scan = parseSessionLines([
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-01T00:00:01.000Z",
        message: { role: "toolResult", toolName: "bash", isError: true },
      }),
    ]);
    expect(scan.results).toHaveLength(1);
    expect(scan.results[0]!.callId).toContain("__orphan__");
    expect(scan.results[0]!.isError).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool src/history/__tests__/scan.test.ts
```

Expected: FAIL — `Cannot find module '../scan.ts'`.

- [ ] **Step 4: Create `src/history/scan.ts` by moving the parser out of tools-metrics**

Move — do not retype — these symbols from `bun-apps/pi-agent/src/cli/commands/tools-metrics.ts`
into the new file: `AnyEvent`, `CallRec`, `ResultRec`, `SessionScan`,
`parseSessionLines`, `parseTs`. Keep the bodies byte-identical; only the header
comment and the `export` on `CallRec` / `ResultRec` change.

Note the indentation switch: `tools-metrics.ts` uses tabs, power-tool `src/` uses
2 spaces. Reindent to 2 spaces to match the destination package.

```typescript
/**
 * Transcript scanner — the ONE reader of pi-agent session logs.
 *
 * Every pi-agent run appends a JSONL transcript under
 * `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`, recording:
 *   - `assistant` messages whose `content[]` holds `{type:"toolCall", id, name, arguments}`
 *   - `toolResult` messages carrying `{toolCallId, toolName, isError}` + an ISO `timestamp`
 *   - a `session` header with the authoritative `cwd`
 *
 * Relocated here from `pi-agent/src/cli/commands/tools-metrics.ts` so tool-health
 * metrics and pathology replay share one parser. A second parser would let the two
 * disagree about what a session contains, and the divergence would be invisible.
 *
 * `bashExecution` messages are deliberately IGNORED — a separate detail log whose
 * call/result/error signal already appears on the `bash` tool's own records.
 * Counting both would double-count bash.
 *
 * PURE: parseSessionLines takes already-read lines, so the parser is unit-testable
 * with zero filesystem access.
 */

/** Minimal shape of a JSONL event line — only the fields we read. */
interface AnyEvent {
  type: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      id?: string;
      name?: string;
    }>;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };
}

/** One toolCall block, flattened. */
export interface CallRec {
  callId: string;
  name: string;
  t0: number;
}

/** One toolResult message, flattened. */
export interface ResultRec {
  callId: string;
  name: string;
  t1: number;
  isError: boolean;
}

/** Parsed view of a single transcript file. */
export interface SessionScan {
  cwd?: string;
  startedAt?: number; // epoch ms of the `session` event (earliest event)
  calls: CallRec[];
  results: ResultRec[];
}

/** Parse an event timestamp (ISO string or epoch-ms number) → epoch ms. */
function parseTs(ts: unknown): number | undefined {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const n = Date.parse(ts);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

/** Parse one JSONL transcript (array of raw lines) into a SessionScan. */
export function parseSessionLines(lines: string[]): SessionScan {
  const scan: SessionScan = { calls: [], results: [] };
  let earliest: number | undefined;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let ev: AnyEvent;
    try {
      ev = JSON.parse(trimmed) as AnyEvent;
    } catch {
      continue; // skip malformed lines silently
    }
    const t = parseTs(ev.timestamp);
    if (t !== undefined && (earliest === undefined || t < earliest)) earliest = t;

    if (ev.type === "session" && typeof ev.cwd === "string") {
      scan.cwd = ev.cwd;
      if (scan.startedAt === undefined && t !== undefined) scan.startedAt = t;
    }

    if (ev.type !== "message" || !ev.message) continue;
    const m = ev.message;

    if (m.role === "assistant" && Array.isArray(m.content) && t !== undefined) {
      for (const b of m.content) {
        if (b?.type === "toolCall" && b.id && b.name) {
          scan.calls.push({ callId: b.id, name: b.name, t0: t });
        }
      }
    } else if (m.role === "toolResult" && t !== undefined) {
      const callId = m.toolCallId;
      const name = m.toolName ?? "(unknown)";
      if (callId) {
        scan.results.push({ callId, name, t1: t, isError: !!m.isError });
      } else {
        // toolResult without a callId still counts toward results/errors;
        // use a synthetic unique id so it can't accidentally pair.
        scan.results.push({
          callId: `__orphan__${name}__${scan.results.length}`,
          name,
          t1: t,
          isError: !!m.isError,
        });
      }
    }
  }

  if (scan.startedAt === undefined) scan.startedAt = earliest;
  return scan;
}
```

- [ ] **Step 5: Create the barrel `src/history/index.ts`**

```typescript
/**
 * power-tool history — longitudinal analysis over pi-agent session transcripts.
 *
 * Layering (strictly one-way): scan → replay → aggregate. `scope` and `sidecar`
 * are leaves. Nothing here imports a tool module or the extension entry.
 */
export { type CallRec, type ResultRec, type SessionScan, parseSessionLines } from "./scan.ts";
```

- [ ] **Step 6: Add the `./history` export subpath**

In `bun-apps/pi-agent-ext-power-tool/package.json`, change the `exports` block to:

```json
  "exports": {
    ".": "./src/index.ts",
    "./extensions/*": "./extensions/*",
    "./history": "./src/history/index.ts",
    "./schema-cost": "./src/schema-cost/index.ts"
  },
```

- [ ] **Step 7: Point tools-metrics at the relocated scanner**

In `bun-apps/pi-agent/src/cli/commands/tools-metrics.ts`, delete the `AnyEvent`,
`CallRec`, `ResultRec`, `SessionScan`, `parseSessionLines` and `parseTs`
definitions, and add this import beside the existing `schema-cost` one:

```typescript
import {
	type CallRec,
	type ResultRec,
	type SessionScan,
	parseSessionLines,
} from "@repo/pi-agent-ext-power-tool/history";
```

Then re-export the two names the command's own public surface already exposed, so
no external consumer breaks:

```typescript
export type { SessionScan } from "@repo/pi-agent-ext-power-tool/history";
export { parseSessionLines } from "@repo/pi-agent-ext-power-tool/history";
```

- [ ] **Step 8: Run the tests**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool src/history/__tests__/scan.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 9: Prove the refactor changed no behaviour**

Against the FROZEN snapshot from Step 1 — never the live tree.

```bash
bun bun-apps/pi-agent/src/cli.ts cli tools-metrics --sessions-dir "$SNAP" --json > "$SCRATCH/tm-after.json"
diff "$SCRATCH/tm-before.json" "$SCRATCH/tm-after.json" && echo "IDENTICAL"
```

Expected: `IDENTICAL`. Any diff means the move was not faithful — fix it before
continuing rather than accepting a "close enough" output.

If Step 1's baseline was somehow taken before the freeze, recover it by stashing
just the two changed files and re-running the old code against the snapshot:

```bash
git stash push -- bun-apps/pi-agent/src/cli/commands/tools-metrics.ts bun-apps/pi-agent-ext-power-tool/package.json
bun bun-apps/pi-agent/src/cli.ts cli tools-metrics --sessions-dir "$SNAP" --json > "$SCRATCH/tm-before.json"
git stash pop
```

- [ ] **Step 10: Run both package gates**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool
bun run --cwd bun-apps/pi-agent-ext-power-tool typecheck
bun test --cwd bun-apps/pi-agent
```

Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/history bun-apps/pi-agent-ext-power-tool/package.json bun-apps/pi-agent/src/cli/commands/tools-metrics.ts
git commit -m "refactor(power-tool): relocate transcript scanner from tools-metrics"
```

---

## Task 2: Widen the scanner with arguments, usage, and model

**Files:**
- Modify: `bun-apps/pi-agent-ext-power-tool/src/history/scan.ts`
- Test: `bun-apps/pi-agent-ext-power-tool/src/history/__tests__/scan.test.ts`

The relocated scanner reads only `{type, name, id}`. Pathology replay additionally
needs each call's `arguments` (for `argsSig`), the per-turn token usage (for
context fill), and the session's model (to resolve the context window).

- [ ] **Step 1: Write the failing tests**

Append to `src/history/__tests__/scan.test.ts`:

```typescript
describe("parseSessionLines — widened fields", () => {
  test("captures toolCall arguments", () => {
    const scan = parseSessionLines([
      assistantLine("2026-08-01T00:00:01.000Z", [
        { id: "c1", name: "bash", arguments: { cmd: "ls" } },
      ]),
    ]);
    expect(scan.calls[0]!.args).toEqual({ cmd: "ls" });
  });

  test("records the highest observed totalTokens", () => {
    const line = (total: number) =>
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-01T00:00:01.000Z",
        message: { role: "assistant", content: [], usage: { totalTokens: total } },
      });
    const scan = parseSessionLines([line(100), line(900), line(400)]);
    expect(scan.maxTotalTokens).toBe(900);
  });

  test("counts assistant messages as the turn-count proxy", () => {
    const scan = parseSessionLines([
      assistantLine("2026-08-01T00:00:01.000Z", []),
      assistantLine("2026-08-01T00:00:02.000Z", []),
      resultLine("2026-08-01T00:00:03.000Z", "c1", "bash"),
    ]);
    expect(scan.assistantMessages).toBe(2);
  });

  test("takes provider and modelId from the last model_change", () => {
    const mc = (provider: string, modelId: string) =>
      JSON.stringify({ type: "model_change", timestamp: "2026-08-01T00:00:00.000Z", provider, modelId });
    const scan = parseSessionLines([mc("zai", "glm-5.2"), mc("anthropic", "claude-opus-5")]);
    expect(scan.provider).toBe("anthropic");
    expect(scan.modelId).toBe("claude-opus-5");
  });

  test("leaves maxTotalTokens at 0 when no usage is present", () => {
    const scan = parseSessionLines([assistantLine("2026-08-01T00:00:01.000Z", [])]);
    expect(scan.maxTotalTokens).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool src/history/__tests__/scan.test.ts
```

Expected: FAIL — `scan.calls[0].args` undefined, `maxTotalTokens` undefined.

- [ ] **Step 3: Widen the types in `scan.ts`**

Replace the `AnyEvent`, `CallRec` and `SessionScan` declarations with:

```typescript
/** Minimal shape of a JSONL event line — only the fields we read. */
interface AnyEvent {
  type: string;
  timestamp?: string;
  cwd?: string;
  provider?: string;
  modelId?: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      id?: string;
      name?: string;
      arguments?: unknown;
    }>;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    usage?: { totalTokens?: number };
  };
}

/** One toolCall block, flattened. */
export interface CallRec {
  callId: string;
  name: string;
  t0: number;
  /** Raw call arguments — fed to argsSig() by the replay, unused by tool metrics. */
  args?: unknown;
}

/** Parsed view of a single transcript file. */
export interface SessionScan {
  cwd?: string;
  startedAt?: number; // epoch ms of the `session` event (earliest event)
  calls: CallRec[];
  results: ResultRec[];
  /** Highest `usage.totalTokens` seen — the session's peak context fill, in tokens. */
  maxTotalTokens: number;
  /** Assistant message count — the turn-count proxy. Transcripts carry no turn_end
   *  event, so this is an APPROXIMATION of the accumulator's turnCount. */
  assistantMessages: number;
  /** From the last `model_change` event — used to resolve the context window. */
  provider?: string;
  modelId?: string;
}
```

- [ ] **Step 4: Widen the parser body**

In `parseSessionLines`, change the initializer:

```typescript
  const scan: SessionScan = { calls: [], results: [], maxTotalTokens: 0, assistantMessages: 0 };
```

Add a `model_change` branch immediately after the `session` branch:

```typescript
    if (ev.type === "model_change") {
      if (typeof ev.provider === "string") scan.provider = ev.provider;
      if (typeof ev.modelId === "string") scan.modelId = ev.modelId;
    }
```

Replace the assistant branch with:

```typescript
    if (m.role === "assistant") {
      scan.assistantMessages++;
      const total = m.usage?.totalTokens;
      if (typeof total === "number" && total > scan.maxTotalTokens) scan.maxTotalTokens = total;
      if (Array.isArray(m.content) && t !== undefined) {
        for (const b of m.content) {
          if (b?.type === "toolCall" && b.id && b.name) {
            scan.calls.push({ callId: b.id, name: b.name, t0: t, args: b.arguments });
          }
        }
      }
    } else if (m.role === "toolResult" && t !== undefined) {
```

Note the restructure: turn counting and usage must happen even when the assistant
message has no `content` array and even when the timestamp is unparseable, so the
`t !== undefined` guard moves inside.

- [ ] **Step 5: Run tests**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool src/history/__tests__/scan.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Re-prove tools-metrics is unaffected**

```bash
bun bun-apps/pi-agent/src/cli.ts cli tools-metrics --json > /tmp/tools-metrics-after2.json
diff /tmp/tools-metrics-before.json /tmp/tools-metrics-after2.json && echo "IDENTICAL"
```

Expected: `IDENTICAL` — the widening is additive.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/history
git commit -m "feat(power-tool): scanner captures call args, token usage, model"
```

---

## Task 3: Replay the detectors over a scanned session

**Files:**
- Create: `bun-apps/pi-agent-ext-power-tool/src/history/replay.ts`
- Modify: `bun-apps/pi-agent-ext-power-tool/src/history/index.ts`
- Test: `bun-apps/pi-agent-ext-power-tool/src/history/__tests__/replay.test.ts`

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-power-tool/src/history/__tests__/replay.test.ts`:

```typescript
/**
 * Tests for historical replay.
 *
 * replayScan() is PURE — a SessionScan in, Finding[] out. It must reuse the same
 * argsSig() the live accumulator uses, so a retry loop detected live and the same
 * call sequence replayed from a transcript produce the same finding.
 */
import { test, expect, describe } from "bun:test";
import { replayScan, resolveContextPercent } from "../replay.ts";
import type { SessionScan } from "../scan.ts";

/** Build a SessionScan with N identical back-to-back bash calls. */
function scanWithRepeats(n: number): SessionScan {
  const calls = Array.from({ length: n }, (_, i) => ({
    callId: `c${i}`,
    name: "bash",
    t0: i * 1000,
    args: { cmd: "git status" },
  }));
  return {
    cwd: "/repo",
    startedAt: 0,
    calls,
    results: calls.map((c) => ({ callId: c.callId, name: "bash", t1: c.t0 + 10, isError: false })),
    maxTotalTokens: 0,
    assistantMessages: 1,
  };
}

describe("replayScan", () => {
  test("detects a retry loop from a replayed transcript", () => {
    const findings = replayScan(scanWithRepeats(4), {});
    expect(findings.some((f) => f.check === "retry-loop")).toBe(true);
  });

  test("does not flag a retry loop below the threshold", () => {
    const findings = replayScan(scanWithRepeats(2), {});
    expect(findings.some((f) => f.check === "retry-loop")).toBe(false);
  });

  test("marks an errored call from its paired result", () => {
    const scan = scanWithRepeats(1);
    scan.results[0]!.isError = true;
    const findings = replayScan(scan, {});
    const stats = findings.find((f) => f.check === "session-stats");
    expect((stats!.detail as { errors: number }).errors).toBe(1);
  });

  test("counts an orphan error result as a call", () => {
    const scan = scanWithRepeats(0);
    scan.results.push({ callId: "__orphan__bash__0", name: "bash", t1: 5, isError: true });
    const findings = replayScan(scan, {});
    const stats = findings.find((f) => f.check === "session-stats");
    expect((stats!.detail as { calls: number }).calls).toBe(1);
  });
});

describe("resolveContextPercent", () => {
  const windows = new Map<string, number>([["glm-5.2", 200_000]]);

  test("computes percent from peak tokens and the model window", () => {
    const scan = { modelId: "glm-5.2", maxTotalTokens: 100_000 } as SessionScan;
    expect(resolveContextPercent(scan, windows)).toBe(50);
  });

  test("returns null — not 0 — when the model window is unknown", () => {
    const scan = { modelId: "gemma-4-26b-a4b-qat", maxTotalTokens: 100_000 } as SessionScan;
    expect(resolveContextPercent(scan, windows)).toBeNull();
  });

  test("returns null when no usage was recorded", () => {
    const scan = { modelId: "glm-5.2", maxTotalTokens: 0 } as SessionScan;
    expect(resolveContextPercent(scan, windows)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool src/history/__tests__/replay.test.ts
```

Expected: FAIL — `Cannot find module '../replay.ts'`.

- [ ] **Step 3: Implement `src/history/replay.ts`**

```typescript
/**
 * Historical replay — SessionScan → PathologyInput → analyzePathology(). PURE.
 *
 * The detectors are NOT modified and NOT reimplemented: analyzePathology() is
 * already a pure function over PathologyInput, so replaying history is a matter of
 * building that input from a transcript instead of from the live accumulator.
 *
 * argsSig is imported from the detector — the SAME function the accumulator uses
 * (see accumulator.ts). Reimplementing it would let live detection and historical
 * replay disagree about what "the same call" means, and that divergence would be
 * silent.
 *
 * Two documented approximations, both inherited from what transcripts record:
 *  - turnCount uses the assistant-message count; transcripts carry no turn_end event.
 *  - contextPercent uses the session's PEAK usage.totalTokens over the model's
 *    context window, and is null when the window cannot be resolved.
 */
import { analyzePathology, argsSig } from "../pathology/detector.ts";
import type { PathologyInput, ToolCallRecord } from "../pathology/types.ts";
import type { Finding } from "../findings.ts";
import type { SessionScan } from "./scan.ts";

/** Threshold overrides forwarded verbatim to analyzePathology(). */
export type ReplayOptions = Omit<PathologyInput, "calls" | "contextPercent" | "turnCount"> & {
  /** modelId → context window in tokens. Omit to leave contextPercent null. */
  windows?: Map<string, number>;
};

/**
 * Peak context fill as a percentage, or null when unmeasurable.
 *
 * Returns null — never 0 — when the model's window is unknown or no usage was
 * recorded. A silently-zero series is indistinguishable from a healthy one, which
 * is the worse failure for a trend report.
 */
export function resolveContextPercent(
  scan: Pick<SessionScan, "modelId" | "maxTotalTokens">,
  windows: Map<string, number> | undefined,
): number | null {
  if (!windows || !scan.modelId || !scan.maxTotalTokens) return null;
  const w = windows.get(scan.modelId);
  if (!w) return null;
  return (scan.maxTotalTokens / w) * 100;
}

/** Build the detector input from a scanned transcript. */
export function toPathologyInput(scan: SessionScan, opts: ReplayOptions = {}): PathologyInput {
  const { windows, ...thresholds } = opts;

  // Pair results back onto their calls by callId, mirroring what the live
  // accumulator does with tool_execution_start / tool_execution_end.
  const errorByCallId = new Map<string, boolean>();
  for (const r of scan.results) errorByCallId.set(r.callId, r.isError);

  const calls: ToolCallRecord[] = scan.calls.map((c) => ({
    toolName: c.name,
    argsSig: argsSig(c.args),
    isError: errorByCallId.get(c.callId) ?? false,
    ts: c.t0,
  }));

  // A result with no matching call still carries a real success/failure fact —
  // the accumulator records these too (accumulator.ts recordCallEnd fallback).
  const callIds = new Set(scan.calls.map((c) => c.callId));
  for (const r of scan.results) {
    if (!callIds.has(r.callId)) {
      calls.push({ toolName: r.name, argsSig: "(end-only)", isError: r.isError, ts: r.t1 });
    }
  }
  calls.sort((a, b) => a.ts - b.ts);

  return {
    ...thresholds,
    calls,
    contextPercent: resolveContextPercent(scan, windows),
    turnCount: scan.assistantMessages,
  };
}

/** Replay every detector over one historical session. */
export function replayScan(scan: SessionScan, opts: ReplayOptions = {}): Finding[] {
  return analyzePathology(toPathologyInput(scan, opts));
}
```

- [ ] **Step 4: Export from the barrel**

Add to `src/history/index.ts`:

```typescript
export {
  type ReplayOptions,
  replayScan,
  resolveContextPercent,
  toPathologyInput,
} from "./replay.ts";
```

- [ ] **Step 5: Add the live-vs-replay parity test**

This is the test that keeps the two paths honest. If replay ever stops matching what
the live accumulator produces from the same call sequence, every historical trend
silently stops describing the thing the status-line warning describes.

Append to `src/history/__tests__/replay.test.ts`:

```typescript
import {
  getCalls,
  recordCallEnd,
  recordCallStart,
  resetAccumulator,
} from "../../pathology/accumulator.ts";
import { analyzePathology } from "../../pathology/detector.ts";

describe("live/replay parity", () => {
  test("replaying a transcript reproduces the live accumulator's findings", () => {
    const seq = [
      { id: "c0", name: "bash", args: { cmd: "git status" }, isError: true },
      { id: "c1", name: "bash", args: { cmd: "git status" }, isError: true },
      { id: "c2", name: "bash", args: { cmd: "git status" }, isError: true },
      { id: "c3", name: "read", args: { path: "/a" }, isError: false },
    ];

    // ── live path: feed the accumulator exactly as the SDK hooks do ──
    resetAccumulator();
    for (const s of seq) {
      recordCallStart({ toolCallId: s.id, toolName: s.name, args: s.args });
      recordCallEnd({ toolCallId: s.id, toolName: s.name, result: null, isError: s.isError });
    }
    const live = analyzePathology({ calls: getCalls(), contextPercent: null, turnCount: 1 });
    resetAccumulator();

    // ── replay path: the same sequence as a scanned transcript ──
    const scan: SessionScan = {
      cwd: "/repo",
      startedAt: 0,
      calls: seq.map((s, i) => ({ callId: s.id, name: s.name, t0: i * 10, args: s.args })),
      results: seq.map((s, i) => ({ callId: s.id, name: s.name, t1: i * 10 + 1, isError: s.isError })),
      maxTotalTokens: 0,
      assistantMessages: 1,
    };
    const replayed = replayScan(scan, {});

    const shape = (fs: typeof live) =>
      fs.filter((f) => f.check !== "session-stats").map((f) => `${f.severity}:${f.check}:${f.message}`).sort();

    expect(shape(replayed)).toEqual(shape(live));
    // and the sequence must actually have tripped something, or this proves nothing
    expect(shape(live).length).toBeGreaterThan(0);
  });
});
```

Note the final assertion: a parity test over two empty finding sets passes
vacuously, which would make it worse than no test.

- [ ] **Step 6: Run tests**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool src/history/__tests__/replay.test.ts
```

Expected: PASS, 8 tests.

If the parity test fails, the cause is almost certainly an ordering or
args-signature difference — do NOT fix it by loosening the assertion. The two paths
disagreeing is exactly the defect this test exists to catch.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/history
git commit -m "feat(power-tool): replay pathology detectors over historical transcripts"
```

---

## Task 4: Scope resolution

**Files:**
- Create: `bun-apps/pi-agent-ext-power-tool/src/history/scope.ts`
- Modify: `bun-apps/pi-agent-ext-power-tool/src/history/index.ts`
- Test: `bun-apps/pi-agent-ext-power-tool/src/history/__tests__/scope.test.ts`

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-power-tool/src/history/__tests__/scope.test.ts`:

```typescript
/**
 * Tests for scope resolution.
 *
 * Two real hazards drive these cases:
 *  - a DELETED worktree still owns session history, and those are the finished
 *    efforts, so the family prefix must keep them;
 *  - a LIVE worktree can sit outside the family prefix (/private/tmp/...), so the
 *    worktree roots must be unioned in.
 */
import { test, expect, describe } from "bun:test";
import { buildScope, inScope } from "../scope.ts";

const scope = buildScope("/Users/me/proj/video_generation", [
  "/Users/me/proj/video_generation",
  "/private/tmp/precheck-rename",
]);

describe("inScope", () => {
  test("accepts the main worktree", () => {
    expect(inScope("/Users/me/proj/video_generation", scope)).toBe(true);
  });

  test("accepts a sibling worktree by family prefix", () => {
    expect(inScope("/Users/me/proj/video_generation__embed", scope)).toBe(true);
  });

  test("accepts a DELETED worktree still holding history", () => {
    expect(inScope("/Users/me/proj/video_generation__archify", scope)).toBe(true);
  });

  test("accepts a subdirectory of a worktree", () => {
    expect(inScope("/Users/me/proj/video_generation__archify/bun-apps/pi-agent", scope)).toBe(true);
  });

  test("accepts a live worktree outside the family prefix", () => {
    expect(inScope("/private/tmp/precheck-rename", scope)).toBe(true);
  });

  test("rejects an unrelated repo", () => {
    expect(inScope("/Users/me/proj/something_else", scope)).toBe(false);
  });

  test("rejects a scratchpad under an unrelated tmp path", () => {
    expect(inScope("/private/tmp/claude-501/scratchpad", scope)).toBe(false);
  });

  test("rejects a session with no cwd", () => {
    expect(inScope(undefined, scope)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool src/history/__tests__/scope.test.ts
```

Expected: FAIL — `Cannot find module '../scope.ts'`.

- [ ] **Step 3: Implement `src/history/scope.ts`**

```typescript
/**
 * Scope resolution — does a session belong to this repo family? PURE.
 *
 * Matching uses the transcript's `cwd` field, NEVER the session directory name:
 * two incompatible cwd encodings coexist on disk
 * (`--Users-…-video_generation__memory--` keeps underscores,
 * `-Users-…-video-generation--embed` converts them to dashes), so decoding
 * directory names would silently drop data at the encoder-version boundary.
 *
 * Scope is the UNION of two rules, because neither alone is sufficient:
 *  - the family prefix keeps DELETED worktrees, which own the history of finished
 *    efforts (`git worktree list` has already forgotten them);
 *  - the live worktree roots keep worktrees living outside the family prefix.
 */

export interface ScopeSpec {
  /** Literal string prefix, e.g. "/Users/me/proj/video_generation". */
  familyPrefix: string;
  /** Absolute worktree roots; a cwd matches a root or any path under it. */
  roots: string[];
}

/**
 * Build a scope from the main worktree path and the live worktree roots.
 *
 * The family prefix is the main worktree path used as a LITERAL string prefix, so
 * `<path>__embed` matches. The tradeoff is deliberate: an unrelated sibling named
 * `<path>_unrelated` would also match. Requiring a `/` boundary instead would drop
 * every `__suffix` worktree, which is the whole population we care about.
 */
export function buildScope(mainWorktree: string, roots: string[]): ScopeSpec {
  return { familyPrefix: mainWorktree.replace(/\/+$/, ""), roots: roots.map((r) => r.replace(/\/+$/, "")) };
}

/** Is this session's cwd inside the scope? */
export function inScope(cwd: string | undefined, scope: ScopeSpec): boolean {
  if (!cwd) return false;
  const p = cwd.replace(/\/+$/, "");
  if (p.startsWith(scope.familyPrefix)) return true;
  return scope.roots.some((r) => p === r || p.startsWith(`${r}/`));
}
```

- [ ] **Step 4: Export from the barrel**

Add to `src/history/index.ts`:

```typescript
export { type ScopeSpec, buildScope, inScope } from "./scope.ts";
```

- [ ] **Step 5: Run tests**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool src/history/__tests__/scope.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/history
git commit -m "feat(power-tool): repo-family scope resolution for transcripts"
```

---

## Task 5: Aggregate into series and regression verdicts

**Files:**
- Create: `bun-apps/pi-agent-ext-power-tool/src/history/aggregate.ts`
- Modify: `bun-apps/pi-agent-ext-power-tool/src/history/index.ts`
- Test: `bun-apps/pi-agent-ext-power-tool/src/history/__tests__/aggregate.test.ts`

The calibration that matters: `retry-loop` fires in 0.9% of sessions and
`error-storm` in 1.8%. Over a 200-session window that is ~1.8 and ~3.6 expected
events. A verdict computed from that is noise. The `minEvents` guard exists to
return `insufficient-signal` instead.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-power-tool/src/history/__tests__/aggregate.test.ts`:

```typescript
/**
 * Tests for longitudinal aggregation.
 *
 * The load-bearing rule is the minEvents guard: measured base rates make
 * retry-loop (0.9%) and error-storm (1.8%) far too sparse for a windowed verdict,
 * so those must report insufficient-signal rather than a confident direction.
 */
import { test, expect, describe } from "bun:test";
import { aggregate, type SessionResult } from "../aggregate.ts";

/** N sessions, the first `hits` of which fired `check`. */
function sessions(n: number, check: string, hits: number, startTs = 0): SessionResult[] {
  return Array.from({ length: n }, (_, i) => ({
    startedAt: startTs + i * 1000,
    checks: i < hits ? [check] : [],
  }));
}

describe("aggregate", () => {
  test("computes occurrence rate per bucket", () => {
    const out = aggregate(sessions(10, "retry-loop", 3), { windowSize: 5, minEvents: 1, deltaPct: 10 });
    const s = out.series.find((x) => x.check === "retry-loop")!;
    expect(s.points.map((p) => p.ratePct)).toEqual([60, 0]);
  });

  test("reports insufficient-signal when the baseline is too sparse", () => {
    // 2 events in the baseline window, minEvents 10 → no verdict.
    const rows = [...sessions(100, "retry-loop", 2), ...sessions(100, "retry-loop", 40, 1_000_000)];
    const out = aggregate(rows, { windowSize: 100, minEvents: 10, deltaPct: 10 });
    const v = out.verdicts.find((x) => x.check === "retry-loop")!;
    expect(v.verdict).toBe("insufficient-signal");
  });

  test("flags a regression when the rate climbs past the delta", () => {
    const rows = [...sessions(100, "consec", 20), ...sessions(100, "consec", 60, 1_000_000)];
    const out = aggregate(rows, { windowSize: 100, minEvents: 10, deltaPct: 10 });
    const v = out.verdicts.find((x) => x.check === "consec")!;
    expect(v.verdict).toBe("regressed");
    expect(v.deltaPct).toBe(40);
  });

  test("flags an improvement when the rate falls past the delta", () => {
    const rows = [...sessions(100, "consec", 60), ...sessions(100, "consec", 20, 1_000_000)];
    const out = aggregate(rows, { windowSize: 100, minEvents: 10, deltaPct: 10 });
    expect(out.verdicts.find((x) => x.check === "consec")!.verdict).toBe("improved");
  });

  test("calls a small move stable", () => {
    const rows = [...sessions(100, "consec", 20), ...sessions(100, "consec", 25, 1_000_000)];
    const out = aggregate(rows, { windowSize: 100, minEvents: 10, deltaPct: 10 });
    expect(out.verdicts.find((x) => x.check === "consec")!.verdict).toBe("stable");
  });

  test("emits no verdict when there is only one window of history", () => {
    const out = aggregate(sessions(50, "consec", 25), { windowSize: 100, minEvents: 10, deltaPct: 10 });
    expect(out.verdicts).toHaveLength(0);
  });

  test("orders sessions by time regardless of input order", () => {
    const rows = [...sessions(5, "c", 0, 1_000_000), ...sessions(5, "c", 5, 0)];
    const out = aggregate(rows, { windowSize: 5, minEvents: 1, deltaPct: 10 });
    expect(out.series.find((x) => x.check === "c")!.points.map((p) => p.ratePct)).toEqual([100, 0]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool src/history/__tests__/aggregate.test.ts
```

Expected: FAIL — `Cannot find module '../aggregate.ts'`.

- [ ] **Step 3: Implement `src/history/aggregate.ts`**

```typescript
/**
 * Longitudinal aggregation — per-session results → rate series + verdicts. PURE.
 *
 * Rate, not count. Session lengths vary by an order of magnitude, so a count-based
 * series is dominated by a handful of long sessions and a busy week reads as a
 * regression when nothing degraded.
 *
 * The caller is responsible for passing ONLY sessions that contain at least one
 * tool call. Measured: 2,226 of 3,391 family sessions have no tool call at all and
 * cannot trigger any detector; including them dilutes every rate ~3× and makes the
 * series track prompt volume instead of agent behaviour.
 *
 * No significance testing. CONTEXT.md defines a pathology detector as deterministic
 * and signal-driven (_Avoid: heuristic_); a p-value over a sample that is neither
 * independent nor identically distributed would manufacture false rigour. The
 * honesty mechanism is minEvents, which withholds a verdict instead of guessing.
 */

/** One replayed session, reduced to the checks it fired. */
export interface SessionResult {
  startedAt: number;
  /** Distinct check ids that fired, excluding the info-level session-stats. */
  checks: string[];
}

export interface AggregateOptions {
  /** Sessions per window. Measured default: 200 (~8 days at the observed rate). */
  windowSize: number;
  /** Minimum baseline-window occurrences required to issue a verdict. */
  minEvents: number;
  /** Percentage-point move that counts as a regression / improvement. */
  deltaPct: number;
}

export interface SeriesPoint {
  /** 0-based window index, oldest first. */
  window: number;
  sessions: number;
  occurrences: number;
  ratePct: number;
}

export interface CheckSeries {
  check: string;
  points: SeriesPoint[];
}

export type Verdict = "regressed" | "improved" | "stable" | "insufficient-signal";

export interface RegressionVerdict {
  check: string;
  baselineRatePct: number;
  recentRatePct: number;
  /** recent − baseline, in percentage points. */
  deltaPct: number;
  baselineEvents: number;
  verdict: Verdict;
}

export interface AggregateReport {
  totalSessions: number;
  windows: number;
  series: CheckSeries[];
  verdicts: RegressionVerdict[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Bucket sessions into fixed-size windows (oldest first) and rate each check. */
export function aggregate(rows: SessionResult[], opts: AggregateOptions): AggregateReport {
  const sorted = [...rows].sort((a, b) => a.startedAt - b.startedAt);

  const windows: SessionResult[][] = [];
  for (let i = 0; i < sorted.length; i += opts.windowSize) {
    windows.push(sorted.slice(i, i + opts.windowSize));
  }

  const checks = [...new Set(sorted.flatMap((r) => r.checks))].sort();

  const series: CheckSeries[] = checks.map((check) => ({
    check,
    points: windows.map((w, i) => {
      const occurrences = w.filter((r) => r.checks.includes(check)).length;
      return {
        window: i,
        sessions: w.length,
        occurrences,
        ratePct: w.length ? round1((occurrences / w.length) * 100) : 0,
      };
    }),
  }));

  // A verdict needs a full baseline window and a recent window to compare.
  const verdicts: RegressionVerdict[] = [];
  if (windows.length >= 2) {
    for (const s of series) {
      const baseline = s.points[s.points.length - 2]!;
      const recent = s.points[s.points.length - 1]!;
      const deltaPct = round1(recent.ratePct - baseline.ratePct);
      const verdict: Verdict =
        baseline.occurrences < opts.minEvents
          ? "insufficient-signal"
          : deltaPct >= opts.deltaPct
            ? "regressed"
            : deltaPct <= -opts.deltaPct
              ? "improved"
              : "stable";
      verdicts.push({
        check: s.check,
        baselineRatePct: baseline.ratePct,
        recentRatePct: recent.ratePct,
        deltaPct,
        baselineEvents: baseline.occurrences,
        verdict,
      });
    }
  }

  return { totalSessions: sorted.length, windows: windows.length, series, verdicts };
}
```

- [ ] **Step 4: Export from the barrel**

Add to `src/history/index.ts`:

```typescript
export {
  type AggregateOptions,
  type AggregateReport,
  type CheckSeries,
  type RegressionVerdict,
  type SeriesPoint,
  type SessionResult,
  type Verdict,
  aggregate,
} from "./aggregate.ts";
```

- [ ] **Step 5: Run tests**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool src/history/__tests__/aggregate.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/history
git commit -m "feat(power-tool): occurrence-rate series with minEvents-guarded verdicts"
```

---

## Task 6: Environment sidecar

**Files:**
- Create: `bun-apps/pi-agent-ext-power-tool/src/history/sidecar.ts`
- Modify: `bun-apps/pi-agent-ext-power-tool/src/history/index.ts`
- Modify: `bun-apps/pi-agent-ext-power-tool/src/index.ts` (hook registration)
- Test: `bun-apps/pi-agent-ext-power-tool/src/history/__tests__/sidecar.test.ts`

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-power-tool/src/history/__tests__/sidecar.test.ts`:

```typescript
/**
 * Tests for the environment sidecar.
 *
 * The load-bearing property is that a write failure NEVER propagates: a diagnostic
 * tool must not break the session it is diagnosing.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSidecarRecord, readSidecar, writeSidecar } from "../sidecar.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sidecar-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("buildSidecarRecord", () => {
  test("fingerprints the tool list order-independently", () => {
    const a = buildSidecarRecord({ sessionId: "s", cwd: "/r", ts: 1, toolNames: ["b", "a"] });
    const b = buildSidecarRecord({ sessionId: "s", cwd: "/r", ts: 1, toolNames: ["a", "b"] });
    expect(a.toolFingerprint).toBe(b.toolFingerprint);
    expect(a.toolCount).toBe(2);
  });

  test("changes the fingerprint when a tool is added", () => {
    const a = buildSidecarRecord({ sessionId: "s", cwd: "/r", ts: 1, toolNames: ["a"] });
    const b = buildSidecarRecord({ sessionId: "s", cwd: "/r", ts: 1, toolNames: ["a", "c"] });
    expect(a.toolFingerprint).not.toBe(b.toolFingerprint);
  });

  test("stores no derived metric", () => {
    const r = buildSidecarRecord({ sessionId: "s", cwd: "/r", ts: 1, toolNames: [] });
    expect(Object.keys(r).sort()).toEqual(
      ["cwd", "gitSha", "piVersion", "sessionId", "toolCount", "toolFingerprint", "ts"].sort(),
    );
  });
});

describe("writeSidecar", () => {
  test("appends one JSON line per call", () => {
    const file = join(tmp(), "env.jsonl");
    writeSidecar(file, buildSidecarRecord({ sessionId: "a", cwd: "/r", ts: 1, toolNames: [] }));
    writeSidecar(file, buildSidecarRecord({ sessionId: "b", cwd: "/r", ts: 2, toolNames: [] }));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).sessionId).toBe("b");
  });

  test("swallows a write failure instead of throwing", () => {
    const unwritable = join(tmp(), "nope", "deep", "env.jsonl");
    rmSync(join(unwritable, ".."), { recursive: true, force: true });
    expect(() =>
      writeSidecar(unwritable, buildSidecarRecord({ sessionId: "a", cwd: "/r", ts: 1, toolNames: [] }), {
        mkdir: false,
      }),
    ).not.toThrow();
  });
});

describe("readSidecar", () => {
  test("returns an empty map for a missing file", () => {
    expect(readSidecar(join(tmp(), "absent.jsonl")).size).toBe(0);
  });

  test("indexes records by sessionId, last write winning", () => {
    const file = join(tmp(), "env.jsonl");
    writeSidecar(file, buildSidecarRecord({ sessionId: "a", cwd: "/one", ts: 1, toolNames: [] }));
    writeSidecar(file, buildSidecarRecord({ sessionId: "a", cwd: "/two", ts: 2, toolNames: [] }));
    expect(readSidecar(file).get("a")!.cwd).toBe("/two");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool src/history/__tests__/sidecar.test.ts
```

Expected: FAIL — `Cannot find module '../sidecar.ts'`.

- [ ] **Step 3: Implement `src/history/sidecar.ts`**

```typescript
/**
 * Environment sidecar — the ONLY new write path in the history subsystem.
 *
 * Records exactly the facts a transcript cannot reconstruct: which commit was
 * checked out, which pi-agent version ran, and which tools were loaded. NO derived
 * metric is ever written here. Storing a computed rate would freeze it against
 * whatever thresholds were current that day, and the whole point of deriving
 * everything else is that a threshold change re-derives the entire history
 * consistently.
 *
 * Written at session_start, NOT session_shutdown: shutdown does not fire on a crash
 * or `kill -9`, and long sessions that die are among the most diagnostic ones.
 * Everything needed is already known at start.
 *
 * Every write is best-effort and swallows its errors — a diagnostic tool must never
 * break the session it is diagnosing.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { argsSig } from "../pathology/detector.ts";

export interface SidecarRecord {
  sessionId: string;
  /** epoch ms */
  ts: number;
  cwd: string;
  gitSha: string | null;
  piVersion: string | null;
  /** Stable, order-independent signature of the loaded tool names. */
  toolFingerprint: string;
  toolCount: number;
}

export interface BuildInput {
  sessionId: string;
  ts: number;
  cwd: string;
  toolNames: string[];
  gitSha?: string | null;
  piVersion?: string | null;
}

/** Default sidecar location. */
export function defaultSidecarPath(home = homedir()): string {
  return join(home, ".pi", "agent", "power-tool", "env.jsonl");
}

/**
 * Build one record. The tool fingerprint reuses argsSig() — the same canonicalize +
 * bounded-truncate + FNV disambiguation the detector already provides — rather than
 * adding a second hash util to the package.
 */
export function buildSidecarRecord(input: BuildInput): SidecarRecord {
  const names = [...input.toolNames].sort();
  return {
    sessionId: input.sessionId,
    ts: input.ts,
    cwd: input.cwd,
    gitSha: input.gitSha ?? null,
    piVersion: input.piVersion ?? null,
    toolFingerprint: argsSig(names),
    toolCount: names.length,
  };
}

/** Resolve HEAD for a working directory. Returns null on any failure. */
export function resolveGitSha(cwd: string): string | null {
  try {
    const out = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    if (out.exitCode !== 0) return null;
    const sha = out.stdout.toString().trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Append one record. Never throws. */
export function writeSidecar(
  path: string,
  record: SidecarRecord,
  opts: { mkdir?: boolean } = {},
): void {
  try {
    if (opts.mkdir !== false) mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Best-effort by design — see the header.
  }
}

/** Read the sidecar, indexed by sessionId. Missing file → empty map. */
export function readSidecar(path: string): Map<string, SidecarRecord> {
  const out = new Map<string, SidecarRecord>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as SidecarRecord;
      if (rec?.sessionId) out.set(rec.sessionId, rec);
    } catch {
      // skip malformed lines silently
    }
  }
  return out;
}
```

- [ ] **Step 4: Export from the barrel**

Add to `src/history/index.ts`:

```typescript
export {
  type BuildInput,
  type SidecarRecord,
  buildSidecarRecord,
  defaultSidecarPath,
  readSidecar,
  resolveGitSha,
  writeSidecar,
} from "./sidecar.ts";
```

- [ ] **Step 5: Run tests**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool src/history/__tests__/sidecar.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Wire the hook in `src/index.ts`**

Add the import beside the existing pathology import:

```typescript
import {
  buildSidecarRecord,
  defaultSidecarPath,
  resolveGitSha,
  writeSidecar,
} from "./history/sidecar.ts";
```

Then extend the existing `session_start` handler — do NOT add a second one:

```typescript
  pi.on("session_start", (_e, ctx) => {
    resetAccumulator(ctx?.sessionManager?.getSessionId());
    resetWarning();
    // Record the environment fingerprint for longitudinal analysis. Everything
    // else the analyzer needs is derived from transcripts; only these facts
    // cannot be reconstructed later. Fully best-effort: writeSidecar swallows
    // its own errors, and this block must never fail a session start.
    try {
      const cwd = process.cwd();
      writeSidecar(
        defaultSidecarPath(),
        buildSidecarRecord({
          sessionId: ctx?.sessionManager?.getSessionId() ?? "",
          ts: Date.now(),
          cwd,
          toolNames: pi.getAllTools().map((t) => t.name),
          gitSha: resolveGitSha(cwd),
        }),
      );
    } catch {
      // never break session start
    }
  });
```

- [ ] **Step 7: Verify the hook fires against a real session**

```bash
rm -f ~/.pi/agent/power-tool/env.jsonl
bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-power-tool/extensions/power-tool.ts -p "say ok"
cat ~/.pi/agent/power-tool/env.jsonl
```

Expected: exactly one JSON line carrying a 40-char `gitSha`, a non-zero `toolCount`,
and no derived metric field.

- [ ] **Step 8: Run the full package gates**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool
bun run --cwd bun-apps/pi-agent-ext-power-tool typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src
git commit -m "feat(power-tool): session_start environment sidecar"
```

---

## Task 7: The `agent-trends` CLI command

**Files:**
- Create: `bun-apps/pi-agent/src/cli/commands/agent-trends.ts`
- Modify: `bun-apps/pi-agent/src/cli/dispatch.ts`
- Test: `bun-apps/pi-agent/src/cli/__tests__/agent-trends.test.ts`

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent/src/cli/__tests__/agent-trends.test.ts`:

```typescript
/**
 * Tests for agent-trends formatting.
 *
 * The filesystem wiring is exercised live in Task 8; these cover the pure
 * formatting decisions, above all that an unmeasurable metric is never printed
 * as a zero and a suppressed verdict is never printed as a direction.
 */
import { test, expect, describe } from "bun:test";
import { formatTrendReport } from "../commands/agent-trends.ts";

const base = {
	totalSessions: 400,
	windows: 2,
	series: [
		{
			check: "consecutive-error",
			points: [
				{ window: 0, sessions: 200, occurrences: 20, ratePct: 10 },
				{ window: 1, sessions: 200, occurrences: 60, ratePct: 30 },
			],
		},
	],
	verdicts: [
		{
			check: "consecutive-error",
			baselineRatePct: 10,
			recentRatePct: 30,
			deltaPct: 20,
			baselineEvents: 20,
			verdict: "regressed" as const,
		},
	],
};

describe("formatTrendReport", () => {
	test("prints the regression direction", () => {
		const text = formatTrendReport(base, { unmeasurableSessions: 0 }).join("\n");
		expect(text).toContain("consecutive-error");
		expect(text).toContain("regressed");
	});

	test("prints insufficient-signal instead of a direction", () => {
		const report = {
			...base,
			verdicts: [{ ...base.verdicts[0]!, baselineEvents: 2, verdict: "insufficient-signal" as const }],
		};
		const text = formatTrendReport(report, { unmeasurableSessions: 0 }).join("\n");
		expect(text).toContain("insufficient signal");
		expect(text).not.toContain("regressed");
	});

	test("discloses how many sessions were unmeasurable", () => {
		const text = formatTrendReport(base, { unmeasurableSessions: 533 }).join("\n");
		expect(text).toContain("533");
		expect(text).toContain("unmeasurable");
	});

	test("says so plainly when there is not enough history for any window", () => {
		const text = formatTrendReport(
			{ totalSessions: 12, windows: 1, series: [], verdicts: [] },
			{ unmeasurableSessions: 0 },
		).join("\n");
		expect(text).toContain("not enough history");
	});
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test --cwd bun-apps/pi-agent src/cli/__tests__/agent-trends.test.ts
```

Expected: FAIL — `Cannot find module '../commands/agent-trends.ts'`.

- [ ] **Step 3: Implement `bun-apps/pi-agent/src/cli/commands/agent-trends.ts`**

This file uses TABS, matching its `commands/` neighbours.

```typescript
/**
 * `agent-trends` — longitudinal pathology + tool-health trends from session logs.
 *
 * Deterministic command (no LLM, no agent boot): scans the transcript archive,
 * replays the pathology detectors over each historical session, and reports
 * occurrence-rate series plus regression verdicts.
 *
 * All analysis lives in @repo/pi-agent-ext-power-tool/history — this file is only
 * the filesystem wiring and the formatting, mirroring how `tools-metrics` keeps
 * `computeMetrics` pure and separate.
 *
 * Nothing leaves the machine: transcripts contain everything ever typed into a
 * session, so this command reads them locally and prints only aggregate counts
 * and bounded arg signatures — never raw arguments.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AggregateReport,
	type SessionResult,
	aggregate,
	buildScope,
	inScope,
	parseSessionLines,
	replayScan,
	resolveContextPercent,
} from "@repo/pi-agent-ext-power-tool/history";
import type { ParsedArgs } from "../args.ts";

/** Calibrated against the real corpus — see the plan's measured base rates. */
const DEFAULT_WINDOW = 200;
const DEFAULT_MIN_EVENTS = 10;
const DEFAULT_DELTA_PCT = 10;

interface FormatContext {
	unmeasurableSessions: number;
}

/** Render the report as terminal lines. PURE. */
export function formatTrendReport(report: AggregateReport, ctx: FormatContext): string[] {
	const out: string[] = [];
	out.push(`agent-trends — ${report.totalSessions} tool-using session(s), ${report.windows} window(s)`);
	out.push("");

	if (report.windows < 2) {
		out.push("not enough history for a windowed comparison (need at least 2 full windows)");
		return out;
	}

	for (const v of report.verdicts) {
		const arrow = v.deltaPct > 0 ? "+" : "";
		const tail =
			v.verdict === "insufficient-signal"
				? `insufficient signal (${v.baselineEvents} baseline event(s))`
				: v.verdict;
		out.push(
			`  ${v.check.padEnd(28)} ${String(v.baselineRatePct).padStart(5)}% → ` +
				`${String(v.recentRatePct).padStart(5)}%  (${arrow}${v.deltaPct}pp)  ${tail}`,
		);
	}

	out.push("");
	for (const s of report.series) {
		out.push(`  ${s.check}: ${s.points.map((p) => `${p.ratePct}%`).join(" · ")}`);
	}

	if (ctx.unmeasurableSessions > 0) {
		out.push("");
		out.push(
			`note: context fill was unmeasurable for ${ctx.unmeasurableSessions} session(s) ` +
				"(model context window not in models-store.json); those are excluded from " +
				"context-saturation, not counted as 0%",
		);
	}
	return out;
}

/** Default transcript archive root. */
function resolveSessionsDir(env: NodeJS.ProcessEnv): string {
	return env.PI_SESSIONS_DIR ?? join(homedir(), ".pi", "agent", "sessions");
}

/** Every *.jsonl under every subdirectory of the sessions root. */
function listSessionFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	for (const dir of readdirSync(root)) {
		try {
			for (const f of readdirSync(join(root, dir))) {
				if (f.endsWith(".jsonl")) files.push(join(root, dir, f));
			}
		} catch {
			// unreadable directory — skip
		}
	}
	return files;
}

/** modelId → context window, read shape-agnostically from the models store. */
function loadContextWindows(home: string): Map<string, number> {
	const windows = new Map<string, number>();
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(home, ".pi", "agent", "models-store.json"), "utf8"));
	} catch {
		return windows;
	}
	// The store's nesting is not a contract we own, so walk for any {id, contextWindow}.
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (v && typeof v === "object") {
			const o = v as Record<string, unknown>;
			if (typeof o.id === "string" && typeof o.contextWindow === "number") {
				windows.set(o.id, o.contextWindow);
			}
			for (const x of Object.values(o)) walk(x);
		}
	};
	walk(raw);
	return windows;
}

/** Live worktree roots, main worktree first. Empty on any failure. */
function listWorktrees(cwd: string): string[] {
	try {
		const out = Bun.spawnSync(["git", "-C", cwd, "worktree", "list", "--porcelain"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		if (out.exitCode !== 0) return [];
		return out.stdout
			.toString()
			.split("\n")
			.filter((l) => l.startsWith("worktree "))
			.map((l) => l.slice("worktree ".length).trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

export const agentTrendsCommand = {
	name: "agent-trends",
	summary: "meta: longitudinal pathology + tool-health trends from session logs",
	details: `Usage:
  pi-agent cli agent-trends [options]

Replays the power-tool pathology detectors over every historical transcript in
~/.pi/agent/sessions and reports occurrence-rate series plus regression verdicts.
Nothing is uploaded; nothing derived is persisted — every number is recomputed
from transcripts on each run, so changing a detector threshold re-derives the
entire history consistently.

Scope (default: this repo family):
  --all              Scan every project, not just this repo and its worktrees
  --sessions-dir <p> Override the sessions root (default: ~/.pi/agent/sessions)

Windowing:
  --window <n>       Sessions per comparison window (default: ${DEFAULT_WINDOW})
  --min-events <n>   Baseline occurrences required for a verdict (default: ${DEFAULT_MIN_EVENTS})
  --delta <pp>       Percentage-point move counting as a change (default: ${DEFAULT_DELTA_PCT})

Output:
  --json             Emit a single JSON object to stdout

Examples:
  pi-agent cli agent-trends
  pi-agent cli agent-trends --window 100 --json`,
	async run(parsed: ParsedArgs): Promise<void> {
		const rest = parsed.rest;
		const flag = (name: string): string | undefined => {
			const i = rest.indexOf(name);
			return i >= 0 ? rest[i + 1] : undefined;
		};
		const has = (name: string): boolean => rest.includes(name);
		const num = (name: string, dflt: number): number => {
			const v = flag(name);
			const n = v !== undefined ? Number(v) : NaN;
			return Number.isFinite(n) && n > 0 ? n : dflt;
		};

		const home = homedir();
		const sessionsDir = flag("--sessions-dir") ?? resolveSessionsDir(process.env);
		const windows = loadContextWindows(home);

		const cwd = process.cwd();
		const roots = listWorktrees(cwd);
		const scope = roots.length ? buildScope(roots[0]!, roots) : buildScope(cwd, [cwd]);
		const scanAll = has("--all");

		const rows: SessionResult[] = [];
		let unmeasurable = 0;

		for (const file of listSessionFiles(sessionsDir)) {
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const scan = parseSessionLines(text.split("\n"));
			if (!scanAll && !inScope(scan.cwd, scope)) continue;
			// Sessions with no tool call cannot trigger any detector; including them
			// would dilute every rate ~3× (measured: 2,226 of 3,391).
			if (scan.calls.length === 0 && scan.results.length === 0) continue;
			if (resolveContextPercent(scan, windows) === null) unmeasurable++;

			const findings = replayScan(scan, { windows });
			rows.push({
				startedAt: scan.startedAt ?? 0,
				checks: [...new Set(findings.filter((f) => f.check !== "session-stats").map((f) => f.check))],
			});
		}

		const report = aggregate(rows, {
			windowSize: num("--window", DEFAULT_WINDOW),
			minEvents: num("--min-events", DEFAULT_MIN_EVENTS),
			deltaPct: num("--delta", DEFAULT_DELTA_PCT),
		});

		if (parsed.json || parsed.mode === "json") {
			console.log(JSON.stringify({ ...report, unmeasurableSessions: unmeasurable }, null, 2));
			return;
		}
		for (const line of formatTrendReport(report, { unmeasurableSessions: unmeasurable })) {
			console.log(line);
		}
	},
};
```

- [ ] **Step 4: Register the command**

In `bun-apps/pi-agent/src/cli/dispatch.ts`, add the import beside the
`tools-metrics` one:

```typescript
import { agentTrendsCommand } from "./commands/agent-trends.ts";
```

and add it to `COMMANDS` immediately after `toolsMetricsCommand`:

```typescript
  toolsMetricsCommand,
  agentTrendsCommand,
```

- [ ] **Step 5: Run tests**

```bash
bun test --cwd bun-apps/pi-agent src/cli/__tests__/agent-trends.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Verify it is reachable from the CLI**

```bash
bun bun-apps/pi-agent/src/cli.ts cli help | grep agent-trends
```

Expected: the command appears in the listing.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent/src/cli
git commit -m "feat(pi-agent): agent-trends command"
```

---

## Task 8: Live verification against the real corpus

This is the task that decides whether the feature works. Everything before it is
tested against fixtures; this runs it against 3,391 real transcripts and checks the
output against numbers measured independently during design.

**Files:**
- Modify: `bun-apps/pi-agent-ext-power-tool/CONTEXT.md`
- Modify: `bun-apps/pi-agent-ext-power-tool/README.md`

- [ ] **Step 1: Run the command for real**

```bash
bun bun-apps/pi-agent/src/cli.ts cli agent-trends
```

Expected: a report naming ~1,165 tool-using sessions and roughly these base rates
(the corpus grows, so exact equality is not expected):
`long-session-recall-risk` ~37%, `consecutive-error` ~5.7%, `error-storm` ~1.8%,
`retry-loop` ~0.9%, and no `context-saturation` row at all.

**If `context-saturation` appears, stop** — it never fired in 3,391 sessions, so
its presence means the context-percent path is miscomputing.

- [ ] **Step 2: Verify the minEvents guard actually suppresses**

```bash
bun bun-apps/pi-agent/src/cli.ts cli agent-trends --json | \
  jq '.verdicts[] | {check, verdict, baselineEvents}'
```

Expected: `retry-loop` and `error-storm` report `insufficient-signal`;
`long-session-recall-risk` (and probably `consecutive-error`) report a real verdict.
A confident direction on a check with `baselineEvents` under 10 is a bug in the
guard.

- [ ] **Step 3: Verify scope filtering does something**

```bash
bun bun-apps/pi-agent/src/cli.ts cli agent-trends --json | jq .totalSessions
bun bun-apps/pi-agent/src/cli.ts cli agent-trends --all --json | jq .totalSessions
```

Expected: the `--all` number is strictly larger. Equal numbers mean the scope
filter is inert.

- [ ] **Step 4: Verify performance**

```bash
time bun bun-apps/pi-agent/src/cli.ts cli agent-trends --all > /dev/null
```

Expected: a few seconds. A measured raw replay over the same corpus takes 0.94 s; if
this exceeds ~30 s, something is quadratic and the cache decision needs revisiting.

- [ ] **Step 5: Verify recomputability**

```bash
bun bun-apps/pi-agent/src/cli.ts cli agent-trends --json | jq '.series[] | select(.check=="retry-loop") | .points[-1].occurrences'
bun bun-apps/pi-agent/src/cli.ts cli agent-trends --window 50 --json | jq '.windows'
```

Expected: changing `--window` re-derives a different window count from the same
transcripts with no cache to clear and no stored state to migrate. This is the
property the whole derive-first design exists to provide.

- [ ] **Step 6: Document the vocabulary in CONTEXT.md**

Append to the "Pathology detection" section of
`bun-apps/pi-agent-ext-power-tool/CONTEXT.md`:

```markdown
**Historical replay**:
Re-running the pathology detectors over past session transcripts
(`~/.pi/agent/sessions/**/*.jsonl`) instead of the live accumulator. The detectors
are unchanged — `analyzePathology()` is already pure over `PathologyInput`, so
replay only builds that input from a transcript. Because nothing derived is stored,
a threshold change re-derives the entire history consistently.
_Avoid_: backfill, import, migration (nothing is written; every number is recomputed)

**Environment sidecar**:
The one-line-per-session record of facts a transcript cannot reconstruct — git sha,
pi-agent version, loaded-tool fingerprint — appended at `session_start` to
`~/.pi/agent/power-tool/env.jsonl`. Carries no derived metric by design.
_Avoid_: telemetry, log, metrics (it records environment identity, never measurements)

**Occurrence rate**:
Sessions in which a pathology fired ÷ sessions **containing at least one tool call**.
The denominator excludes tool-less sessions deliberately: 2,226 of 3,391 measured
sessions have no tool call and cannot trigger any detector, so including them tracks
prompt volume rather than agent behaviour.
_Avoid_: frequency, count (a count series is dominated by long sessions)
```

- [ ] **Step 7: Document the command in README.md**

Append a section to `bun-apps/pi-agent-ext-power-tool/README.md`:

```markdown
## Longitudinal analysis

`pi-agent cli agent-trends` replays the pathology detectors over historical session
transcripts and reports occurrence-rate trends with regression verdicts.

Measured base rates over 1,165 tool-using sessions (49 days, 2026-06-28 → 2026-08-16):

| pathology | rate | sessions |
|---|---:|---:|
| long-session-recall-risk | 37.0% | 431 |
| consecutive-error | 5.7% | 66 |
| error-storm | 1.8% | 21 |
| retry-loop | 0.9% | 10 |
| context-saturation | 0% | 0 |

Two consequences worth knowing before reading a report:

- **`retry-loop` and `error-storm` are too sparse for a verdict** at this data
  volume — they report `insufficient signal` rather than a direction. That is the
  designed behaviour, not a missing feature.
- **`context-saturation` has never fired.** Peak context fill across the whole
  archive is 56.2% against an 85% threshold, so it is excluded from the trend views.
```

- [ ] **Step 8: Run every gate**

```bash
bun test --cwd bun-apps/pi-agent-ext-power-tool
bun run --cwd bun-apps/pi-agent-ext-power-tool typecheck
bun test --cwd bun-apps/pi-agent
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/CONTEXT.md bun-apps/pi-agent-ext-power-tool/README.md
git commit -m "docs(power-tool): document historical replay and measured base rates"
```

---

## Verification Checklist

Before calling this done, all of the following must hold:

- [ ] `tools-metrics --json` output is byte-identical to the pre-refactor baseline
- [ ] Exactly one transcript parser exists in the repo (`src/history/scan.ts`)
- [ ] The live/replay parity test passes AND is non-vacuous (live findings > 0)
- [ ] `agent-trends` reports base rates matching the independently measured values
- [ ] `retry-loop` and `error-storm` report `insufficient-signal`, not a direction
- [ ] `context-saturation` does not appear in the trend output
- [ ] `--all` returns strictly more sessions than the default scope
- [ ] The sidecar writes one line per session with a real git sha and no derived metric
- [ ] A sidecar write failure does not break `session_start`
- [ ] `bun test` and `typecheck` pass in both `pi-agent-ext-power-tool` and `pi-agent`

## Explicitly out of scope

- Full spec step 2c (relocating the whole `tools-metrics` command). Only the scanner
  moves here; the command shell stays in `pi-agent`.
- Steps 2a and 2b of the simplification spec (gating dedup, `inspect_*` collapse).
- Cost/schema-cost trending — deprioritized by the owner.
- Any change to detector thresholds. The 85% saturation threshold looks miscalibrated
  for this workload, but that is a detector question, not an analyzer question.
