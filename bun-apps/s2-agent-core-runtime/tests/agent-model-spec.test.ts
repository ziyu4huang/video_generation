import { expect, test } from "bun:test";
import type { ModelTierConfig } from "@repo/s2-agent-core-runtime";
import {
  resolveAgentModelSpec,
  resolveScopedAgentModelSpec,
  sessionModelInjectionWins,
  splitSpecThinkingSuffix,
} from "@repo/s2-agent-core-runtime";

/**
 * Pins the unknown-tier console.warn emitted by resolveAgentModelSpec (agent.ts):
 * beyond naming the bad tier and the session-default fallback (asserted in
 * s2-agent-ext-ultracode tests/agent.test.ts), the warning must also tell users
 * how to fix it — the /models-preset command that applies a full tier config.
 */
test("resolveAgentModelSpec: unknown-tier warning points users to /models-preset", () => {
  const cfg: ModelTierConfig = { tiers: { small: "vendor/small", medium: "vendor/medium", big: "vendor/big" } };
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: string) => warnings.push(msg);
  try {
    // Same invocation shape as the workflow-side unknown-tier test: a tier that
    // resolves in no config entry, so resolveAgentModelSpec warns and degrades.
    const resolved = resolveAgentModelSpec({ tier: "lage" }, "main/expensive", () => cfg);
    expect(resolved).toBe("main/expensive");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("/models-preset");
  } finally {
    console.warn = original;
  }
});

/**
 * sessionModelInjectionWins (cc-parity-2 ticket 01): a caller-injected
 * session model (`session: {model}` on the WorkflowAgent/openLiveAgent seam)
 * must bypass model-spec resolution — otherwise the untagged default-medium
 * branch resolves a tier model through the REAL registry on tier-configured
 * machines and silently overrides the injection. Found live by the ticket-01
 * memory harness: with only `modelRuntime` + `model` injected, children ran
 * the real LM Studio default instead of the faux transport.
 */
test("sessionModelInjectionWins: injection wins only when no per-call model/tier is given", () => {
  const injected = { model: { id: "faux" } };
  // The exact harness scenario: untagged spawn + injected model → bypass.
  expect(sessionModelInjectionWins({}, injected)).toBe(true);
  // Per-call explicit choices stay more specific than the injection.
  expect(sessionModelInjectionWins({ model: "vendor/big" }, injected)).toBe(false);
  expect(sessionModelInjectionWins({ tier: "medium" }, injected)).toBe(false);
  // No injection → normal resolution applies (today's behavior).
  expect(sessionModelInjectionWins({}, undefined)).toBe(false);
  expect(sessionModelInjectionWins({}, {})).toBe(false);
});

/**
 * `:thinking` spec-suffix handling (gemma no-think vision swap, 2026-08-24):
 * a suffixed spec (`provider/id:off`) used to reach WorkflowAgent.resolveModel
 * with the suffix intact, fail the registry lookup, and fall all the way back
 * to the session default ("requested model … unavailable"). The suffix must be
 * stripped for lookup AND surfaced as `thinkingLevel` so assembleSession can
 * pin the run's thinking level (the load-bearing no-think pin).
 */
test("splitSpecThinkingSuffix: splits a legal suffix, leaves everything else whole", () => {
  // Legal suffix after the last slash → split.
  expect(splitSpecThinkingSuffix("lm-studio/prism-ml/bonsai-27b:off")).toEqual({
    base: "lm-studio/prism-ml/bonsai-27b",
    thinkingLevel: "off",
  });
  expect(splitSpecThinkingSuffix("vendor/x:high")).toEqual({ base: "vendor/x", thinkingLevel: "high" });
  // Not a ThinkingLevel → whole spec is the base (colons are not assumed).
  expect(splitSpecThinkingSuffix("vendor/x:sometimes")).toEqual({ base: "vendor/x:sometimes" });
  // Colon inside the provider segment (before the last slash) → whole.
  expect(splitSpecThinkingSuffix("http://host/model")).toEqual({ base: "http://host/model" });
  // No colon at all.
  expect(splitSpecThinkingSuffix("vendor/x")).toEqual({ base: "vendor/x" });
});

test("resolveScopedAgentModelSpec: strips the suffix for resolution and returns thinkingLevel", async () => {
  const noTierConfig = () => null;
  // Explicit suffixed model: base id resolves the precedence chain, level is carried.
  const explicit = resolveScopedAgentModelSpec(
    { model: "lm-studio/prism-ml/bonsai-27b:off" },
    undefined,
    undefined,
    noTierConfig,
  );
  expect(explicit.spec).toBe("lm-studio/prism-ml/bonsai-27b");
  expect(explicit.thinkingLevel).toBe("off");
  expect(explicit.clamped).toBe(false);
  // Tier/capability specs from the config may carry a suffix too.
  const cfg: ModelTierConfig = {
    tiers: { small: "vendor/s:off", medium: "vendor/m:low", big: "vendor/b" },
    capabilities: { vision: "lm-studio/prism-ml/bonsai-27b:off" },
  };
  const viaTier = resolveScopedAgentModelSpec({ tier: "medium" }, undefined, undefined, () => cfg);
  expect(viaTier.spec).toBe("vendor/m");
  expect(viaTier.thinkingLevel).toBe("low");
  // Unsuffixed specs stay unsuffixed (no level emitted).
  const plain = resolveScopedAgentModelSpec({ tier: "big" }, undefined, undefined, () => cfg);
  expect(plain.spec).toBe("vendor/b");
  expect(plain.thinkingLevel).toBeUndefined();
});
