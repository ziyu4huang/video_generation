import { describe, expect, test } from "bun:test";
import extension from "./pi-movie-director.ts";

// Wiring test for the extension factory — registers one well-formed tool and
// dispatch() shapes results correctly. Deep behavior is covered in src/*.test.ts.

function captureRegisteredTool() {
  let registered: any = null;
  const fakePi = {
    registerTool(tool: any) {
      registered = tool;
    },
  } as any;
  extension(fakePi);
  return registered;
}

describe("pi-movie-director extension", () => {
  test("registers exactly one tool named 'movie' with a non-empty description", () => {
    const tool = captureRegisteredTool();
    expect(tool).not.toBeNull();
    expect(tool.name).toBe("movie");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(100);
  });

  test("the description documents every command", () => {
    const tool = captureRegisteredTool();
    for (const cmd of [
      "preflight", "pipeline-list", "pipeline-show", "init-project", "next-stage",
      "write-checkpoint", "read-checkpoint", "validate-artifact", "generate",
      "compose", "final-review",
      "cost-estimate", "cost-reserve", "cost-reconcile", "cost-snapshot",
    ]) {
      expect(tool.description).toContain(cmd);
    }
  });

  test("preflight returns the provider-menu summary", async () => {
    const tool = captureRegisteredTool();
    const res = await tool.execute("id", { command: "preflight", options: {} }, undefined, undefined, undefined);
    const text = res.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.capabilities.length).toBeGreaterThan(0);
    expect(parsed.composition_runtimes).toBeDefined();
  });

  test("pipeline-list returns the bundled manifests", async () => {
    const tool = captureRegisteredTool();
    const res = await tool.execute("id", { command: "pipeline-list", options: {} }, undefined, undefined, undefined);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed).toContain("talking-head");
  });

  test("write-checkpoint surfaces gate violation as a non-throwing error result", async () => {
    const tool = captureRegisteredTool();
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

  test("generate surfaces a no-configured-provider error as a structured failure (no spawn)", async () => {
    // tts has NO configured provider → the selector throws NoConfiguredProviderError,
    // which dispatch converts to {ok:false, error}. No subprocess is ever spawned.
    const tool = captureRegisteredTool();
    const res = await tool.execute(
      "id",
      { command: "generate", options: { capability: "tts", command: "synthesize" } },
      undefined, undefined, undefined,
    );
    expect(res.details.ok).toBe(false);
    expect(res.details.error).toContain("no configured provider");
  });
});
