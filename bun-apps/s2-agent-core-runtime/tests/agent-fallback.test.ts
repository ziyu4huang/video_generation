import { expect, test } from "bun:test";
import type { ModelTierConfig } from "@repo/s2-agent-core-runtime";
import { resolveFallbackModel } from "@repo/s2-agent-core-runtime";

/**
 * Fake async model resolver over a fixed available set. Mirrors
 * WorkflowAgent.resolveModel's truthiness contract (returns a value when the
 * spec is available, undefined otherwise) without needing a real registry.
 */
function fakeResolver(available: Set<string>) {
  return async (spec: string): Promise<unknown> =>
    available.has(spec) ? { provider: spec.split("/")[0], id: spec.split("/")[1] } : undefined;
}

const cfg: ModelTierConfig = {
  tiers: { small: "zai/glm-flash", medium: "zai/glm-5.2", big: "zai/glm-max" },
};

const REQUESTED = "anthropic/claude-opus-4-1";

test("fallback WITH tier (preset model available) → kind tier + the preset spec", async () => {
  // opus unavailable, but the medium tier maps to glm-5.2 which IS available.
  const decision = await resolveFallbackModel(
    REQUESTED,
    { tier: "medium" },
    cfg,
    fakeResolver(new Set(["zai/glm-5.2"])),
  );
  expect(decision.kind).toBe("tier");
  expect(decision.spec).toBe("zai/glm-5.2");
  // Warning names requested → tier → actual (the preset model).
  expect(decision.warning).toContain(REQUESTED);
  expect(decision.warning).toContain('"medium"');
  expect(decision.warning).toContain('"zai/glm-5.2"');
});

test("fallback WITHOUT tier → kind sessionDefault + warning names requested → session default", async () => {
  const decision = await resolveFallbackModel(REQUESTED, {}, cfg, fakeResolver(new Set()));
  expect(decision.kind).toBe("sessionDefault");
  expect(decision.spec).toBeUndefined();
  expect(decision.warning).toContain(REQUESTED);
  expect(decision.warning).toContain("no tier given");
  expect(decision.warning).toContain("using session default");
});

test("fallback with a tier whose preset model is ALSO unavailable → sessionDefault", async () => {
  // medium maps to glm-5.2 but it is NOT available → degrade further to session default.
  const decision = await resolveFallbackModel(REQUESTED, { tier: "medium" }, cfg, fakeResolver(new Set()));
  expect(decision.kind).toBe("sessionDefault");
  expect(decision.spec).toBeUndefined();
  expect(decision.warning).toContain(REQUESTED);
  expect(decision.warning).toContain('"medium"');
  expect(decision.warning).toContain("also unavailable");
  expect(decision.warning).toContain("using session default");
});

test("fallback with a tier set but absent from the preset → sessionDefault", async () => {
  const decision = await resolveFallbackModel(REQUESTED, { tier: "huge" }, cfg, fakeResolver(new Set(["zai/glm-5.2"])));
  expect(decision.kind).toBe("sessionDefault");
  expect(decision.warning).toContain('"huge"');
  expect(decision.warning).toContain("not configured in the active preset");
});

test("fallback with a tier set but no model-tiers config at all → sessionDefault", async () => {
  const decision = await resolveFallbackModel(
    REQUESTED,
    { tier: "medium" },
    null,
    fakeResolver(new Set(["zai/glm-5.2"])),
  );
  expect(decision.kind).toBe("sessionDefault");
  expect(decision.warning).toContain('"medium"');
  expect(decision.warning).toContain("no model-tiers config");
});

test("the tier-resolved preset model wins over a different session default (preset controls)", async () => {
  // The session default would be e.g. "openai/gpt-5", but the medium tier maps to
  // glm-5.2 — the decision must surface glm-5.2, NOT the session default. This
  // is the core fix: subagents follow the /models-preset, not an arbitrary default.
  const decision = await resolveFallbackModel(
    REQUESTED,
    { tier: "medium" },
    { tiers: { medium: "zai/glm-5.2" } },
    fakeResolver(new Set(["zai/glm-5.2", "openai/gpt-5"])),
  );
  expect(decision.kind).toBe("tier");
  expect(decision.spec).toBe("zai/glm-5.2");
  expect(decision.spec).not.toBe("openai/gpt-5");
});
