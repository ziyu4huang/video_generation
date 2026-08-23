/**
 * vision-inference guard — the empty-output / reasoning-truncation footgun.
 *
 * The rest of the suite mocks `../src/vlm/vision-inference.ts` entirely (so the
 * runVisionInference wiring is stubbed). This file instead mocks the modules
 * runVisionInference DELEGATES TO — `roleAwareDirectCall` + `spawnSubagent` —
 * so the real guard logic in `src/vlm/vision-inference.ts` is exercised: it
 * must NOT return `ok:true + ""` for a completed-but-empty vision reply when
 * the caller opts into `emptyIsError`.
 *
 *   bun test __tests__/vision-inference-guard.test.ts
 */
import { describe, expect, mock, test } from "bun:test";

// --- control knobs ----------------------------------------------------------
let nextOutput = "";
let nextFailure: { message: string } | undefined;
const spawnCalls: { task: string; images: unknown[]; model?: string; capability?: string }[] = [];

mock.module("@repo/s2-agent-core-runtime", () => ({
  roleAwareDirectCall: () => ({ task: "recon-task" }),
  spawnSubagent: async (opts: any) => {
    spawnCalls.push(opts);
    return nextFailure ? { output: "", failure: nextFailure } : { output: nextOutput };
  },
}));

const { runVisionInference } = await import("../src/vlm/vision-inference.ts");

function reset(overrides: { output?: string; failure?: { message: string } | null } = {}) {
  nextOutput = overrides.output ?? "";
  nextFailure = overrides.failure ?? undefined;
  spawnCalls.length = 0;
}

describe("runVisionInference — empty-output guard (completed but no text)", () => {
  test("non-empty output → ok:true, empty:false even when emptyIsError", async () => {
    reset({ output: "the chart shows frequency vs gain." });
    const r = await runVisionInference({
      task: "describe",
      images: [{ type: "image", data: "x", mimeType: "image/png" }],
      llm: { provider: "lm-studio", modelId: "qwen/qwen3.8-27b", thinkingLevel: "off" },
      emptyIsError: true,
    });
    expect(r.ok).toBe(true);
    expect(r.output).toBe("the chart shows frequency vs gain.");
    expect(r.empty).toBeUndefined();
  });

  test("garbage/whitespace-only output is treated as empty (truncation symptom)", async () => {
    reset({ output: "   \n  " });
    const r = await runVisionInference({
      task: "describe",
      images: [{ type: "image", data: "x", mimeType: "image/png" }],
      llm: { provider: "lm-studio", modelId: "qwen/qwen3.8-27b", thinkingLevel: "off" },
      emptyIsError: true,
    });
    expect(r.ok).toBe(false);
    expect(r.output).toBe("");
    expect(r.empty).toBe(true);
    expect(r.error).toMatch(/no output text/);
  });

  test("empty output + emptyIsError=true → ok:false, empty:true (NOT ok:true + '')", async () => {
    reset({ output: "" });
    const r = await runVisionInference({
      task: "describe",
      images: [{ type: "image", data: "x", mimeType: "image/png" }],
      llm: { provider: "lm-studio", modelId: "qwen/qwen3.8-27b", thinkingLevel: "off" },
      emptyIsError: true,
    });
    expect(r.ok).toBe(false);
    expect(r.output).toBe("");
    expect(r.empty).toBe(true);
    expect(r.error).toBeDefined();
  });

  test("empty output + emptyIsError UNSET → ok:true, empty:true (backwards-compatible empty reply)", async () => {
    reset({ output: "" });
    const r = await runVisionInference({
      task: "describe",
      images: [{ type: "image", data: "x", mimeType: "image/png" }],
      llm: { provider: "lm-studio", modelId: "qwen/qwen3.8-27b", thinkingLevel: "off" },
    });
    expect(r.ok).toBe(true);
    expect(r.output).toBe("");
    expect(r.empty).toBe(true);
  });

  test("explicit llm → spawnSubagent receives the provider/id spec string", async () => {
    reset({ output: "a plot" });
    await runVisionInference({
      task: "describe",
      images: [{ type: "image", data: "x", mimeType: "image/png" }],
      llm: { provider: "lm-studio", modelId: "qwen/qwen3.8-27b", thinkingLevel: "off" },
    });
    expect(spawnCalls[0]?.model).toBe("lm-studio/qwen/qwen3.8-27b");
  });

  test("no llm → spawnSubagent resolves via the vision capability key", async () => {
    reset({ output: "a figure" });
    await runVisionInference({
      task: "describe",
      images: [{ type: "image", data: "x", mimeType: "image/png" }],
    });
    expect(spawnCalls[0]?.capability).toBe("vision");
  });

  test("child failure → ok:false, error forwarded (empty NOT marked)", async () => {
    reset({ failure: { message: "connection reset" } });
    const r = await runVisionInference({
      task: "describe",
      images: [{ type: "image", data: "x", mimeType: "image/png" }],
      llm: { provider: "lm-studio", modelId: "qwen/qwen3.8-27b", thinkingLevel: "off" },
      emptyIsError: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("connection reset");
    expect(r.empty).toBeUndefined();
  });
});
