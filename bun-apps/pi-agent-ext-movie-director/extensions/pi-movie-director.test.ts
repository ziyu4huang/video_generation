import { describe, expect, test } from "bun:test";
import extension from "./pi-movie-director.ts";
import { scopeViolationForToolCall } from "../src/index.ts";

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
      "preflight", "pipeline-list", "pipeline-show", "init-project", "next-stage",
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
    // music_generation has NO registered provider at all (not even a GAP entry)
    // → the selector throws NoConfiguredProviderError, which dispatch converts
    // to {ok:false, error}. No subprocess is ever spawned. (tts no longer works
    // for this: the local macOS `say` fallback makes it always resolve.)
    const tool = captureTool("movie");
    const res = await tool.execute(
      "id",
      { command: "generate", options: { capability: "music_generation", command: "synthesize" } },
      undefined, undefined, undefined,
    );
    expect(res.details.ok).toBe(false);
    expect(res.details.error).toContain("no configured provider");
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
});
