import { describe, expect, test } from "bun:test";
import type { AgentHistoryEntry } from "../src/agent-history.js";
import type { RunRecord } from "../src/run-view.js";
import { buildRunView } from "../src/run-view.js";

function baseRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    startedAt: 1000,
    taskPreview: "do the thing",
    status: "running",
    ...overrides,
  };
}

function hist(...entries: Record<string, unknown>[]): AgentHistoryEntry[] {
  return entries as unknown as AgentHistoryEntry[];
}

describe("buildRunView — elapsed", () => {
  test("terminal + endedAt → frozen at endedAt - startedAt", () => {
    const v = buildRunView(baseRun({ status: "done", endedAt: 5000 }), 999_999);
    expect(v.elapsedMs).toBe(4000);
    expect(v.elapsedFrozen).toBe(true);
  });

  test("running → live now - startedAt, not frozen", () => {
    const v = buildRunView(baseRun(), 6000);
    expect(v.elapsedMs).toBe(5000);
    expect(v.elapsedFrozen).toBe(false);
  });
});

describe("buildRunView — modelSeg", () => {
  test("fallback branch: resolved→requested", () => {
    const v = buildRunView(
      baseRun({
        fellBack: true,
        requestedModel: "anthropic/claude-opus",
        resolvedModel: "google/gemini-2.5-pro",
      }),
      0,
    );
    expect(v.modelSeg).toBe("gemini-2.5-pro→claude-opus");
  });

  test("no fallback: resolved wins, provider prefix dropped", () => {
    const v = buildRunView(baseRun({ resolvedModel: "google/gemini-2.5-pro" }), 0);
    expect(v.modelSeg).toBe("gemini-2.5-pro");
  });

  test("nothing resolved: model slot, else 'default'", () => {
    expect(buildRunView(baseRun({ model: "opus" }), 0).modelSeg).toBe("opus");
    expect(buildRunView(baseRun(), 0).modelSeg).toBe("default");
  });
});

describe("buildRunView — history-derived", () => {
  test("toolCallCount counts only kind === 'toolCall'", () => {
    const v = buildRunView(
      baseRun({
        history: hist(
          { kind: "toolCall", title: "read file" },
          { kind: "assistant", text: "thinking" },
          { kind: "toolCall", title: "bash ls" },
        ),
      }),
      0,
    );
    expect(v.toolCallCount).toBe(2);
  });

  test("latestAction: last toolCall wins, falls back to taskPreview", () => {
    const v = buildRunView(
      baseRun({ history: hist({ kind: "toolCall", title: "a" }, { kind: "toolCall", name: "b" }) }),
      0,
    );
    expect(v.latestAction).toBe("b");

    const noTools = buildRunView(baseRun({ history: hist({ kind: "assistant" }) }), 0);
    expect(noTools.latestAction).toBe("do the thing");
  });
});

test("actor defaults to general-purpose; foreground defaults false; abortable from abort lever", () => {
  const v = buildRunView(baseRun(), 0);
  expect(v.actor).toBe("general-purpose");
  expect(v.foreground).toBe(false);
  expect(v.abortable).toBe(false);
  expect(buildRunView(baseRun({ agent: "impl", abort: () => {} }), 0).actor).toBe("impl");
  expect(buildRunView(baseRun({ abort: () => {} }), 0).abortable).toBe(true);
});

describe("buildRunView — accrued usage projection", () => {
  test("projects usageAccrued costUsd/tokensIn/tokensOut", () => {
    const v = buildRunView(baseRun({ usageAccrued: { costUsd: 0.04, tokensIn: 100, tokensOut: 200 } }), 0);
    expect(v.costUsd).toBe(0.04);
    expect(v.tokensIn).toBe(100);
    expect(v.tokensOut).toBe(200);
  });

  test("usage fields default to 0 when usageAccrued absent", () => {
    const v = buildRunView(baseRun(), 0);
    expect(v.costUsd).toBe(0);
    expect(v.tokensIn).toBe(0);
    expect(v.tokensOut).toBe(0);
  });
});

// ── width-aware model segment cap (2026-08-19 core-runtime width adoption) ──

describe("buildRunView — modelSeg column-aware cap", () => {
  test("ASCII segment keeps legacy 24-char semantics byte-identical", () => {
    const seg = "x".repeat(40);
    expect(buildRunView(baseRun({ resolvedModel: `prov/${seg}` }), 0).modelSeg).toBe(`${"x".repeat(23)}…`);
  });

  test("CJK segment is capped by terminal columns, never overshoots 24", () => {
    const v = buildRunView(baseRun({ resolvedModel: `prov/${"你".repeat(40)}` }), 0);
    expect(v.modelSeg).toBe(`${"你".repeat(11)}…`); // 11×2 + 1 = 23 columns
  });
});
