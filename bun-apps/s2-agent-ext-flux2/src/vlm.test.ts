import { expect, test } from "bun:test";
import { publishSeam, type ResolvedLLM, type VisionLLMSeam } from "@repo/s2-agent-core-interface";
import { resolveVlmLLM } from "./vlm.ts";

/**
 * vlm.test.ts tests THIS package's adapter contract only: override threading
 * through the __piVisionLLM seam, pass-through of the resolver's result, and
 * the actionable throw when the seam is unpublished. The resolver's actual
 * resolution order (explicit > capabilities.vision > PI_MODEL env > throw) is
 * file2md's domain — covered by its __tests__/resolve-vision-llm.test.ts.
 */
const SEAM_KEY = "__piVisionLLM";

function withStubSeam(resolver: VisionLLMSeam["resolveVisionLLM"], fn: () => void): void {
  const calls: { model?: string; provider?: string; thinking?: string; tier?: string }[] = [];
  const seam: VisionLLMSeam = {
    resolveVisionLLM: (opts) => {
      calls.push(opts ?? {});
      return resolver(opts);
    },
    askImage: async () => ({ reply: "", ok: false }),
  };
  publishSeam(SEAM_KEY, seam);
  try {
    fn();
    expect(calls.length).toBe(1);
  } finally {
    (globalThis as Record<string, unknown>)[SEAM_KEY] = undefined;
  }
}

function llm(provider: string, modelId: string): ResolvedLLM {
  return { provider, modelId, thinkingLevel: "off" };
}

test("resolveVlmLLM threads the explicit override through the seam", () => {
  withStubSeam(
    (opts) => {
      expect(opts?.model).toBe("openai/gpt-4.1-mini");
      return llm("openai", "gpt-4.1-mini");
    },
    () => {
      expect(resolveVlmLLM("openai/gpt-4.1-mini")).toEqual(llm("openai", "gpt-4.1-mini"));
    },
  );
});

test("resolveVlmLLM calls the seam resolver with no opts when unoverridden", () => {
  withStubSeam(
    (opts) => {
      expect(opts).toEqual({});
      return llm("lm-studio", "prism-ml/bonsai-27b");
    },
    () => {
      expect(resolveVlmLLM()).toEqual(llm("lm-studio", "prism-ml/bonsai-27b"));
    },
  );
});

test("resolveVlmLLM throws the actionable message when the seam is unpublished", () => {
  // Guard the precondition: no leftover seam from another test in this file.
  (globalThis as Record<string, unknown>)[SEAM_KEY] = undefined;
  expect(() => resolveVlmLLM()).toThrow(/__piVisionLLM is not published/);
});
