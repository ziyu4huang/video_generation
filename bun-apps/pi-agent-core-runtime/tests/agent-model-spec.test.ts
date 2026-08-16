import { expect, test } from "bun:test";
import type { ModelTierConfig } from "@repo/pi-agent-core-runtime";
import { resolveAgentModelSpec } from "@repo/pi-agent-core-runtime";

/**
 * Pins the unknown-tier console.warn emitted by resolveAgentModelSpec (agent.ts):
 * beyond naming the bad tier and the session-default fallback (asserted in
 * pi-agent-ext-workflow tests/agent.test.ts), the warning must also tell users
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
