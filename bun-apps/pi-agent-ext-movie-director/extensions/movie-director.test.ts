import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./movie-director.ts";
import { scopeViolationForToolCall, configureBudget, recordDecision } from "../src/index.ts";

// Wiring test for the extension factory — registers one well-formed tool and
// dispatch() shapes results correctly. Deep behavior is covered in src/*.test.ts.

function captureRegisteredTools(): any[] {
  const tools: any[] = [];
  const fakePi = {
    registerTool(tool: any) {
      tools.push(tool);
    },
    on() {
      /* tool_call guard registration; exercised via scopeViolationForToolCall tests */
    },
  } as any;
  extension(fakePi);
  return tools;
}

/** Find a registered tool by name (movie / movie_help). */
function captureTool(name: string): any {
  return captureRegisteredTools().find((t) => t.name === name) ?? null;
}

/** The full command reference as movie_help returns it (no command arg). */
async function movieHelpReference(): Promise<string> {
  const help = captureTool("movie_help");
  const res = await help.execute("id", {}, undefined, undefined, undefined);
  return res.content[0].text;
}

describe("pi-movie-director extension", () => {
  test("registers the movie + movie_help tools with non-empty descriptions", () => {
    const tools = captureRegisteredTools();
    const movie = tools.find((t) => t.name === "movie");
    const help = tools.find((t) => t.name === "movie_help");
    expect(movie).toBeDefined();
    expect(help).toBeDefined();
    expect(typeof movie.description).toBe("string");
    expect(movie.description.length).toBeGreaterThan(100);
    // The movie tool's routing description is deliberately slim; the heavy
    // command reference lives in movie_help (dispatcher/help-tool split, same
    // pattern as flux2/ltx/krea2/workflow).
    expect(movie.description).toContain("movie_help");
  });

  test("the movie_help reference documents every command", async () => {
    const reference = await movieHelpReference();
    for (const cmd of [
      "preflight", "pipeline-list", "pipeline-show", "init-project", "list-projects", "next-stage",
      "write-checkpoint", "read-checkpoint", "validate-artifact", "generate",
      "compose", "final-review",
      "cost-estimate", "cost-reserve", "cost-reconcile", "cost-snapshot",
    ]) {
      expect(reference).toContain(cmd);
    }
  });

  test("the generate reference documents BOTH analysis subcommands (agent-discoverability)", async () => {
    // Regression: the `movie` tool's generate reference used to mention only
    // `analysis:transcribe` (audio). A hint-free "identify the VISUAL content"
    // prompt left the agent unable to discover the CLIP path, so it guessed
    // `transcribe` and omitted `capability` → a non-converging retry loop
    // (the "video_understand agent-path block"). The reference MUST surface
    // `video_understand` and its options so a hint-free agent routes correctly.
    // (Lives in movie_help's reference now; the main movie tool is routing-only.)
    const reference = await movieHelpReference();
    expect(reference).toContain("video_understand");
    expect(reference).toContain("transcribe");
    // The visual-analysis option keys (so the agent doesn't guess `video_path`).
    expect(reference).toMatch(/video_understand[^]*options:\{video,\s*prompt/);
    expect(reference).toContain("VISUAL");
  });

  test("preflight returns the provider-menu summary", async () => {
    const tool = captureTool("movie");
    const res = await tool.execute("id", { command: "preflight", options: {} }, undefined, undefined, undefined);
    const text = res.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.capabilities.length).toBeGreaterThan(0);
    expect(parsed.composition_runtimes).toBeDefined();
  });

  test("pipeline-list returns the bundled manifests", async () => {
    const tool = captureTool("movie");
    const res = await tool.execute("id", { command: "pipeline-list", options: {} }, undefined, undefined, undefined);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed).toContain("talking-head");
  });

  test("list-projects returns the {projects:[...]} discovery shape with no required options", async () => {
    const tool = captureTool("movie");
    const res = await tool.execute("id", { command: "list-projects", options: {} }, undefined, undefined, undefined);
    const parsed = JSON.parse(res.content[0].text);
    expect(Array.isArray(parsed.projects)).toBe(true);
  });

  test("write-checkpoint surfaces gate violation as a non-throwing error result", async () => {
    const tool = captureTool("movie");
    const res = await tool.execute(
      "id",
      {
        command: "write-checkpoint",
        options: {
          projectId: "p-gate", pipeline: "talking-head", stage: "idea", status: "completed",
          // humanApproved omitted → gate violation
        },
      },
      undefined, undefined, undefined,
    );
    expect(res.details.ok).toBe(false);
    expect(res.content[0].text).toContain("GATE VIOLATION");
  });

  test("write-checkpoint with status omitted defaults to in_progress (status is not a required field)", async () => {
    const tool = captureTool("movie");
    const res = await tool.execute(
      "id",
      {
        command: "write-checkpoint",
        options: { projectId: "p-default-status", pipeline: "talking-head", stage: "idea" },
      },
      undefined, undefined, undefined,
    );
    expect(res.details.ok).toBe(true);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.status).toBe("in_progress");
  });

  test("generate surfaces a no-configured-provider error as a structured failure (no spawn)", async () => {
    // Every REGISTRY capability now has at least one always-configured provider
    // (music_generation gained musicgen_music on 2026-07-26 — a caller-supplied
    // capability outside the closed Capability union is the only way left to
    // reach getByCapability() returning zero entries. That's also the more
    // realistic case here: a hallucinating agent typing a bogus capability
    // name. The selector throws NoConfiguredProviderError, which dispatch
    // converts to {ok:false, error}. No subprocess is ever spawned.
    const tool = captureTool("movie");
    const res = await tool.execute(
      "id",
      { command: "generate", options: { capability: "quantum_teleportation", command: "synthesize" } },
      undefined, undefined, undefined,
    );
    expect(res.details.ok).toBe(false);
    expect(res.details.error).toContain("no configured provider");
  });

  // Item 3 (output/next-goal-20260712_135012.md): BudgetExceededError/
  // ApprovalRequiredError used to be swallowed into "no cost tracked" inside
  // generate's cost lifecycle try/catch — invisible to the caller despite the
  // code's own comment already saying "in cap mode a budget breach SHOULD
  // block". Now the block happens BEFORE selectAndGenerate runs (no subprocess
  // spawned) and the error is surfaced directly.
  test("generate surfaces a cap-mode budget-exceeded error instead of silently skipping cost tracking (Item 3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-dispatch-budget-"));
    const prevMlxOut = process.env.MLX_OUTPUT_DIR;
    process.env.MLX_OUTPUT_DIR = dir;
    try {
      configureBudget("p-budget-block", { mode: "cap", totalUsd: 0, singleActionApprovalUsd: 100 });
      const tool = captureTool("movie");
      // subtitle_gen is pure-Bun (bun:builtin, no external binary/network) —
      // the only capability guaranteed configured on every CI runner, unlike
      // tts (macOS `say`/edge-tts network) which has zero configured
      // providers on Linux CI (see providers.test.ts's subtitleAdapter tests).
      const res = await tool.execute(
        "id",
        {
          command: "generate",
          options: { capability: "subtitle", command: "srt", projectId: "p-budget-block", estimatedUsd: 1.0, options: { wordsPath: "/nonexistent.json" } },
        },
        undefined, undefined, undefined,
      );
      expect(res.details.ok).toBe(false);
      expect(res.details.error).toContain("exceed usable budget");
    } finally {
      if (prevMlxOut === undefined) delete process.env.MLX_OUTPUT_DIR;
      else process.env.MLX_OUTPUT_DIR = prevMlxOut;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Item 2/P4 (output/next-goal-20260712_142905.md): decision log — an
  // append-only (category, subject) record of provider substitutions,
  // independent of cost tracking (which only ever sees the final
  // attribution). read-decision-log is the movie tool's read path for it.
  test("read-decision-log surfaces entries recorded via recordDecision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-dispatch-decision-log-"));
    const prevMlxOut = process.env.MLX_OUTPUT_DIR;
    process.env.MLX_OUTPUT_DIR = dir;
    try {
      recordDecision("p-decision", "provider", "tts", "say", "edge-tts", "generate:tts:speak");
      const tool = captureTool("movie");
      const res = await tool.execute(
        "id",
        { command: "read-decision-log", options: { projectId: "p-decision" } },
        undefined, undefined, undefined,
      );
      expect(res.details.ok).toBe(true);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.entries.length).toBe(1);
      expect(parsed.entries[0].resolved).toBe("say");
      expect(parsed.entries[0].used).toBe("edge-tts");
    } finally {
      if (prevMlxOut === undefined) delete process.env.MLX_OUTPUT_DIR;
      else process.env.MLX_OUTPUT_DIR = prevMlxOut;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read-decision-log requires {projectId}", async () => {
    const tool = captureTool("movie");
    const res = await tool.execute("id", { command: "read-decision-log", options: {} }, undefined, undefined, undefined);
    expect(res.details.ok).toBe(false);
    expect(res.details.error).toContain("projectId");
  });

  test("compose (ffmpeg foundation tier) also refuses to render when pre-compose would fail (tool-design audit, 2026-07-12 — this tier previously had NO gate at all)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-dispatch-gate-fail-compose-"));
    try {
      const tool = captureTool("movie");
      const res = await tool.execute(
        "id",
        {
          command: "compose",
          options: {
            editDecisions: { version: "1.0", cuts: [] }, // no cuts → cuts_present fails
            workDir: dir,
          },
        },
        undefined, undefined, undefined,
      );
      expect(res.details.ok).toBe(false);
      expect(res.details.error).toContain("GATE VIOLATION");
      expect(res.details.error).toContain("cuts_present");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("compose proceeds when overridePreCompose=true bypasses a pre-compose fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-dispatch-gate-override-compose-"));
    try {
      const tool = captureTool("movie");
      const res = await tool.execute(
        "id",
        {
          command: "compose",
          options: {
            editDecisions: { version: "1.0", cuts: [] },
            workDir: dir,
            overridePreCompose: true,
          },
        },
        undefined, undefined, undefined,
      );
      // Past the gate now — composeVideo itself reports a failure for zero cuts
      // (no GATE VIOLATION text), proving the override actually let it through.
      expect(res.content[0].text).not.toContain("GATE VIOLATION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("compose-motion refuses to render when pre-compose would fail (Bug 2, saturn-young-rings 2026-07-12)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-dispatch-gate-fail-"));
    try {
      const tool = captureTool("movie");
      const res = await tool.execute(
        "id",
        {
          command: "compose-motion",
          options: {
            editDecisions: { version: "1.0", cuts: [] }, // no cuts → cuts_present fails
            workDir: dir,
          },
        },
        undefined, undefined, undefined,
      );
      expect(res.details.ok).toBe(false);
      expect(res.details.error).toContain("GATE VIOLATION");
      expect(res.details.error).toContain("cuts_present");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("compose-motion proceeds when overridePreCompose=true bypasses a pre-compose fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-dispatch-gate-override-"));
    try {
      const tool = captureTool("movie");
      const res = await tool.execute(
        "id",
        {
          command: "compose-motion",
          options: {
            editDecisions: { version: "1.0", cuts: [] },
            workDir: dir,
            overridePreCompose: true,
          },
        },
        undefined, undefined, undefined,
      );
      // Past the gate now — composeMotion itself reports a failure for zero cuts
      // (no GATE VIOLATION text), proving the override actually let it through.
      expect(res.content[0].text).not.toContain("GATE VIOLATION");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("next-stage refuses to advance past a checkpoint_required stage with no completed checkpoint (checkpoint-enforcement gap, placebo-effect-explainer 2026-07-12)", async () => {
    const tool = captureTool("movie");
    const res = await tool.execute(
      "id",
      {
        command: "next-stage",
        options: { projectId: "p-stage-gate-missing", pipeline: "talking-head", stage: "idea" },
      },
      undefined, undefined, undefined,
    );
    expect(res.details.ok).toBe(false);
    expect(res.details.error).toContain("GATE VIOLATION");
    expect(res.details.error).toContain("idea");
  });

  test("next-stage proceeds once a completed checkpoint exists for the current checkpoint_required stage", async () => {
    const tool = captureTool("movie");
    const writeRes = await tool.execute(
      "id",
      {
        command: "write-checkpoint",
        options: {
          projectId: "p-stage-gate-ok", pipeline: "talking-head", stage: "idea",
          status: "completed", humanApproved: true,
          artifacts: {
            brief: {
              version: "1.0", title: "x", hook: "hook", key_points: ["a"],
              tone: "warm", style: "clean-professional", target_platform: "generic",
              target_duration_seconds: 30,
            },
          },
        },
      },
      undefined, undefined, undefined,
    );
    expect(writeRes.details.ok).toBe(true);
    const res = await tool.execute(
      "id",
      {
        command: "next-stage",
        options: { projectId: "p-stage-gate-ok", pipeline: "talking-head", stage: "idea" },
      },
      undefined, undefined, undefined,
    );
    expect(res.details.ok).toBe(true);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.current).toBe("idea");
    expect(parsed.next).toBe("script");
  });

  test("next-stage with overrideStageGate=true bypasses a missing checkpoint", async () => {
    const tool = captureTool("movie");
    const res = await tool.execute(
      "id",
      {
        command: "next-stage",
        options: { projectId: "p-stage-gate-override", pipeline: "talking-head", stage: "idea", overrideStageGate: true },
      },
      undefined, undefined, undefined,
    );
    expect(res.details.ok).toBe(true);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.next).toBe("script");
  });

  test("next-stage does not gate a stage with checkpoint_required=false (animated-explainer's research stage)", async () => {
    const tool = captureTool("movie");
    // No projectId at all, no checkpoint written — must still succeed since
    // "research" is not checkpoint_required in animated-explainer.
    const res = await tool.execute(
      "id",
      {
        command: "next-stage",
        options: { pipeline: "animated-explainer", stage: "research" },
      },
      undefined, undefined, undefined,
    );
    expect(res.details.ok).toBe(true);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.current).toBe("research");
    expect(parsed.next).toBe("proposal");
  });

  test("the factory registers the tool_call scope guard", () => {
    // The extension calls pi.on("tool_call", handler) with the scope-violation
    // predicate. Capture the handler and prove it blocks the #291 path.
    let registeredHandler: ((e: any) => any) | null = null;
    const fakePi = {
      registerTool() {},
      on(event: string, handler: (e: any) => any) {
        if (event === "tool_call") registeredHandler = handler;
      },
    } as any;
    extension(fakePi);
    expect(registeredHandler).not.toBeNull();
    const block = registeredHandler!({ toolName: "edit", input: { path: "python/mlx-movie-director/app/config.py", edits: [] } });
    expect(block?.block).toBe(true);
    expect(block?.reason).toContain("out of scope");
    // A safe path is allowed through.
    expect(registeredHandler!({ toolName: "write", input: { path: "/tmp/x.mp4", content: "x" } })).toBeUndefined();
    // And the handler delegates to the pure predicate (same verdict for the same input).
    expect(registeredHandler!({ toolName: "edit", input: { path: "swift/x.swift", edits: [] } })).toEqual(
      scopeViolationForToolCall({ toolName: "edit", input: { path: "swift/x.swift", edits: [] } }),
    );
  });

  test("movie and movie_help share ONE gating object (cannot drift apart)", () => {
    const movie = captureTool("movie");
    const help = captureTool("movie_help");
    // Same reference, not merely deep-equal: co-firing is decided by fingerprint
    // equality in tool-gate (gatesWithSameGating), and two separate literals can
    // be edited apart with no signal. One object makes that impossible.
    expect(movie.gating).toBe(help.gating);
  });
});
