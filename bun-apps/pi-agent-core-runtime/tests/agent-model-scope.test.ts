/**
 * Session model scope must hold on EVERY dispatch path, not just `opts.model`.
 *
 * WHAT WENT WRONG WITHOUT THIS TEST
 *   Scope clamping originally lived in pi-agent-ext-workflow, applied to
 *   `opts.model` inside workflow-runtime. That is the only branch where THAT
 *   layer holds a concrete spec: `opts.tier` deliberately leaves the spec
 *   undefined there so the tier resolves downstream, and the untagged
 *   default-to-medium path never produces a spec at that layer at all. So the
 *   tier path — the one `modelRoutingGuideline` steers authors toward with
 *   "TAG EVERY agent with opts.tier" — dispatched out of scope, and the unit
 *   tests still passed because they exercised `clampModelToScope` in isolation.
 *
 * WHAT THIS PINS
 *   The composition CoreAgent.run actually performs
 *   ({@link resolveScopedAgentModelSpec}), enumerated over every branch of the
 *   precedence chain. Testing resolve and clamp separately proves each is right
 *   and proves nothing about whether the second is REACHED from every branch of
 *   the first — which was the entire defect.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { clampModelToScope, resolveScopedAgentModelSpec } from "@repo/pi-agent-core-runtime";

const SCOPE = ["prov/allowed-a", "prov/allowed-b"] as const;
const MAIN_IN_SCOPE = "prov/allowed-b";

/** A tier config whose every entry is OUTSIDE the scope above. */
const outOfScopeConfig = () =>
  ({
    tiers: { small: "prov/denied-small", medium: "prov/denied-medium", big: "prov/denied-big" },
  }) as never;

/**
 * Every way a model spec can be chosen. `agentType model` and `phase model` are
 * not separate branches here on purpose: the workflow layer folds both into
 * `options.model` before this function sees them, so `model` IS their path.
 */
const DISPATCH_PATHS: ReadonlyArray<{ name: string; options: { model?: string; tier?: string } }> = [
  { name: "explicit opts.model (also: agentType model, phase model)", options: { model: "prov/denied-explicit" } },
  { name: "opts.tier — small", options: { tier: "small" } },
  { name: "opts.tier — medium", options: { tier: "medium" } },
  { name: "opts.tier — big", options: { tier: "big" } },
  { name: "unknown tier (degrades to mainModel)", options: { tier: "no-such-tier" } },
  { name: "untagged (defaults to the medium tier)", options: {} },
];

describe("session model scope covers every dispatch path", () => {
  for (const path of DISPATCH_PATHS) {
    test(`${path.name}: resolves INTO scope`, () => {
      const { spec, clamped } = resolveScopedAgentModelSpec(
        path.options,
        // Deliberately out of scope, so an unknown tier cannot reach scope by
        // accident via the mainModel degradation.
        "prov/denied-main",
        SCOPE,
        outOfScopeConfig,
      );
      assert.ok(spec !== undefined, "every path in this table resolves to a concrete spec");
      assert.equal(clamped, true, "the fixture puts every path out of scope, so every one must clamp");
      assert.ok(SCOPE.includes(spec as (typeof SCOPE)[number]), `resolved outside the scope: ${spec}`);
    });
  }

  test("an in-scope main model is preferred over the first scoped spec", () => {
    // The old rule always took scopedSpecs[0], which silently downgraded a
    // `big` synthesis agent to whatever --models happened to list first.
    const { spec, clamped } = resolveScopedAgentModelSpec({ tier: "big" }, MAIN_IN_SCOPE, SCOPE, outOfScopeConfig);
    assert.equal(clamped, true);
    assert.equal(spec, MAIN_IN_SCOPE);
    assert.notEqual(spec, SCOPE[0], "must not fall back to the arbitrary first entry when main is usable");
  });

  test("an OUT-of-scope main model falls back to the first scoped spec (old behavior preserved)", () => {
    const { spec } = resolveScopedAgentModelSpec({ tier: "big" }, "prov/denied-main", SCOPE, outOfScopeConfig);
    assert.equal(spec, SCOPE[0]);
  });

  test("no scope configured = full catalog: nothing is clamped on any path", () => {
    for (const path of DISPATCH_PATHS) {
      for (const scope of [undefined, [] as readonly string[]]) {
        const { clamped } = resolveScopedAgentModelSpec(path.options, "prov/denied-main", scope, outOfScopeConfig);
        assert.equal(clamped, false, `${path.name} clamped with no scope configured`);
      }
    }
  });

  test("an already-in-scope spec is left alone on every path", () => {
    const inScopeConfig = () => ({ tiers: { small: SCOPE[0], medium: SCOPE[0], big: SCOPE[1] } }) as never;
    for (const path of DISPATCH_PATHS) {
      const options = path.options.model ? { model: SCOPE[0] } : path.options;
      const { spec, clamped } = resolveScopedAgentModelSpec(options, MAIN_IN_SCOPE, SCOPE, inScopeConfig);
      assert.equal(clamped, false, `${path.name} was clamped despite already being in scope`);
      assert.ok(SCOPE.includes(spec as (typeof SCOPE)[number]));
    }
  });

  test("resolving to nothing (session default) is not a clamp", () => {
    // No config and no tier → undefined, meaning "use the session default".
    // The session's own model is in its own scope by construction.
    const { spec, clamped } = resolveScopedAgentModelSpec({}, undefined, SCOPE, () => null);
    assert.equal(spec, undefined);
    assert.equal(clamped, false);
  });

  test("the clamped result reports the ORIGINAL spec, so the warning can name it", () => {
    const { requested, spec } = resolveScopedAgentModelSpec(
      { model: "prov/denied-explicit" },
      MAIN_IN_SCOPE,
      SCOPE,
      outOfScopeConfig,
    );
    assert.equal(requested, "prov/denied-explicit");
    assert.equal(spec, MAIN_IN_SCOPE);
  });
});

describe("clampModelToScope contract", () => {
  test("empty / undefined scope leaves the request unchanged", () => {
    assert.deepEqual(clampModelToScope("prov/any", []), { spec: "prov/any", clamped: false });
    assert.deepEqual(clampModelToScope("prov/any", undefined), { spec: "prov/any", clamped: false });
  });

  test("matching is an exact string compare — case and format matter", () => {
    assert.deepEqual(clampModelToScope("PROV/a", ["prov/a"]), { spec: "prov/a", clamped: true });
    assert.deepEqual(clampModelToScope("a", ["prov/a"]), { spec: "prov/a", clamped: true });
  });
});
