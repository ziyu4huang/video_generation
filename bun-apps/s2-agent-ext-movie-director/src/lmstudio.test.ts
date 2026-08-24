import { describe, expect, it } from "bun:test";
import { lmStudioJsonCall, resolveDefaultModel } from "./lmstudio.ts";

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("resolveDefaultModel", () => {
  it("prefers an already-loaded Gemma-4 variant", async () => {
    const fetchImpl = (async () =>
      respond({ models: [{ key: "prism-ml/bonsai-27b", loaded_instances: [{}] }] })) as unknown as typeof fetch;
    expect(await resolveDefaultModel("http://localhost:1234/v1", fetchImpl, null)).toBe("prism-ml/bonsai-27b");
  });

  it("falls back to any already-loaded model when no preferred model is loaded", async () => {
    const fetchImpl = (async () => respond({ models: [{ key: "some/other-model", loaded_instances: [{}] }] })) as unknown as typeof fetch;
    expect(await resolveDefaultModel("http://localhost:1234/v1", fetchImpl, null)).toBe("some/other-model");
  });

  it("falls back to the default model id when the server is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await resolveDefaultModel("http://localhost:1234/v1", fetchImpl, null)).toBe("prism-ml/bonsai-27b");
  });
});

describe("lmStudioJsonCall — fast-path + safety retry (mirrors story.py's _gemma_json_call)", () => {
  it("returns the fast-path result when parseFn succeeds on the first attempt", async () => {
    let chatCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        chatCalls++;
        return respond({ choices: [{ message: { content: '["ok"]' } }] });
      }
      return respond({ models: [] });
    }) as unknown as typeof fetch;

    const result = await lmStudioJsonCall("prompt", (raw) => JSON.parse(raw), { _fetchImpl: fetchImpl });
    expect(result).toEqual(["ok"]);
    expect(chatCalls).toBe(1);
  });

  it("retries at the safety-net budget when the fast path yields no parseable content", async () => {
    let chatCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        chatCalls++;
        if (chatCalls === 1) return respond({ choices: [{ message: { content: "not json at all" } }] });
        return respond({ choices: [{ message: { content: '["retried"]' } }] });
      }
      return respond({ models: [] });
    }) as unknown as typeof fetch;

    const result = await lmStudioJsonCall("prompt", (raw) => JSON.parse(raw), { _fetchImpl: fetchImpl });
    expect(result).toEqual(["retried"]);
    expect(chatCalls).toBe(2);
  });

  it("tries the reasoning_content field before giving up on an attempt", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        return respond({ choices: [{ message: { content: "no json", reasoning_content: '["from-reasoning"]' } }] });
      }
      return respond({ models: [] });
    }) as unknown as typeof fetch;

    const result = await lmStudioJsonCall("prompt", (raw) => JSON.parse(raw), { _fetchImpl: fetchImpl });
    expect(result).toEqual(["from-reasoning"]);
  });

  it("throws after both attempts fail to parse", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/chat/completions")) return respond({ choices: [{ message: { content: "garbage" } }] });
      return respond({ models: [] });
    }) as unknown as typeof fetch;

    await expect(lmStudioJsonCall("prompt", (raw) => JSON.parse(raw), { _fetchImpl: fetchImpl })).rejects.toThrow();
  });
});

// --- central vision slot (capabilities.vision from model-tiers.json) ---

describe("resolveDefaultModel — central vision slot", () => {
  const CFG = (vision: string) => ({
    tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
    capabilities: { vision },
  });

  it("prefers the central capabilities.vision model over the hardcoded preferred list", async () => {
    const fetchImpl = (async () =>
      respond({
        models: [
          { key: "prism-ml/bonsai-27b", loaded_instances: [{}] },
          { key: "foo/bar-model", loaded_instances: [{}] },
        ],
      })) as unknown as typeof fetch;
    expect(await resolveDefaultModel("http://localhost:1234/v1", fetchImpl, CFG("lm-studio/foo/bar-model"))).toBe(
      "foo/bar-model",
    );
  });

  it("strips only the provider prefix from the central spec (inner slash survives)", async () => {
    const fetchImpl = (async () =>
      respond({ models: [{ key: "prism-ml/bonsai-27b", loaded_instances: [{}] }] })) as unknown as typeof fetch;
    expect(
      await resolveDefaultModel("http://localhost:1234/v1", fetchImpl, CFG("lm-studio/prism-ml/bonsai-27b")),
    ).toBe("prism-ml/bonsai-27b");
  });

  it("terminal fallback returns the central model when nothing is loaded and the server is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await resolveDefaultModel("http://localhost:1234/v1", fetchImpl, CFG("lm-studio/foo/bar-model"))).toBe(
      "foo/bar-model",
    );
  });

  it("null config keeps the legacy probe-only behavior", async () => {
    const fetchImpl = (async () =>
      respond({ models: [{ key: "prism-ml/bonsai-27b", loaded_instances: [{}] }] })) as unknown as typeof fetch;
    expect(await resolveDefaultModel("http://localhost:1234/v1", fetchImpl, null)).toBe("prism-ml/bonsai-27b");
  });
});
