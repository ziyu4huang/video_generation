import { expect, test } from "bun:test";
import type { ModelTierConfig } from "@repo/s2-agent-core-runtime";
import { resolveAgentModelSpec, sessionModelInjectionWins } from "@repo/s2-agent-core-runtime";

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
