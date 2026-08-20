/**
 * 01a-contract-expand — first-class gate contract tests.
 *
 * Wayfinder ticket 01 (phase 01a of task_plan.md): tool-gate must accept the
 * NEW reference form `gating: { gate: "<id>" }` — resolving keywords/requires/
 * description from the shared `GATE_DEFS` registry in core-interface and
 * GROUPING every tool that references the same id into ONE co-firing family
 * gate — WITHOUT changing the legacy inline form's output (expand–contract:
 * nothing existing breaks, QA byte-identical).
 *
 * Coverage here:
 *   - `Gate` + `GATE_DEFS` are importable from core-interface (no ambient-global
 *     dependency for the reference form).
 *   - buildEffectiveGates reference form: resolution, grouping by id, order,
 *     description fallback, fail-open on unknown id, core-wins precedence.
 *   - the legacy inline form is byte-identical to pre-01a behavior.
 */
import { describe, expect, test } from "bun:test";
import { GATE_DEFS, type Gate } from "@repo/s2-agent-core-interface";
import {
  buildEffectiveGates,
  updateSticky,
  matchIntent,
  type ToolGate,
} from "./tool-gate.ts";

/** Registry fixture — declared per-test so the shared GATE_DEFS stays pristine. */
function reg(defs: Record<string, Gate>): Record<string, Gate> {
  return { ...defs };
}

const FLUX_SPEC: Gate = {
  id: "flux2",
  keywords: ["flux", "flux2", "stable diffusion"],
  description: "FLUX.2 image generation",
};
const MOVIE_SPEC: Gate = {
  id: "movie",
  keywords: ["montage", "movie director", "compose scene"],
  requires: { nouns: ["film"], verbs: ["make"] },
};

describe("01a — Gate + GATE_DEFS are importable from core-interface", () => {
  test("GATE_DEFS is a shared mutable registry keyed by id", () => {
    expect(typeof GATE_DEFS).toBe("object");
    expect(GATE_DEFS).not.toBeNull();
    GATE_DEFS["__test_gate"] = { id: "__test_gate", keywords: ["x"] };
    expect(GATE_DEFS["__test_gate"]!.keywords).toEqual(["x"]);
    delete GATE_DEFS["__test_gate"]; // cleanup — never leak into the shared registry
    expect(GATE_DEFS["__test_gate"]).toBeUndefined();
  });

  test("Gate type carries id/keywords/requires/description (type-level)", () => {
    // Compile-time shape check: a valid Gate object must typecheck; this is the
    // contract 14 extensions will migrate to in 01b.
    const g: Gate = { id: "demo", keywords: ["a"], requires: { nouns: ["n"], verbs: ["v"] }, description: "d" };
    expect(g.id).toBe("demo");
  });
});

describe("01a — buildEffectiveGates reference form (gating:{gate:id})", () => {
  test("resolves keywords/requires/description from the registry (not the def)", () => {
    const eff = buildEffectiveGates(
      [{ name: "flux2", description: "tool desc", gating: { gate: "flux2" } }],
      reg({ flux2: FLUX_SPEC }),
    );
    expect(eff.gates).toHaveLength(1);
    const g = eff.gates[0]!;
    expect(g.names).toEqual(["flux2"]);
    expect(g.keywords).toEqual(FLUX_SPEC.keywords!);
    expect(g.requires).toEqual(FLUX_SPEC.requires);
    // registry description wins over the tool's description
    expect(g.description).toBe(FLUX_SPEC.description!);
    expect(g.gateId).toBe("flux2");
    expect(eff.tracked.has("flux2")).toBe(true);
    expect(eff.core.has("flux2")).toBe(false);
  });

  test("groups sibling tools referencing the SAME id into ONE multi-name gate", () => {
    const eff = buildEffectiveGates(
      [
        { name: "movie", gating: { gate: "movie" } },
        { name: "movie_help", gating: { gate: "movie" } },
      ],
      reg({ movie: MOVIE_SPEC }),
    );
    expect(eff.gates).toHaveLength(1); // ONE family gate, not two
    const g = eff.gates[0]!;
    expect(g.names).toEqual(["movie", "movie_help"]); // declaration order preserved
    expect(g.gateId).toBe("movie");
    expect(eff.tracked.has("movie")).toBe(true);
    expect(eff.tracked.has("movie_help")).toBe(true);
  });

  test("a multi-name family co-fires as ONE unit under updateSticky", () => {
    const eff = buildEffectiveGates(
      [
        { name: "movie", gating: { gate: "movie" } },
        { name: "movie_help", gating: { gate: "movie" } },
      ],
      reg({ movie: MOVIE_SPEC }),
    );
    const sticky = new Set<string>();
    updateSticky("make a film montage", sticky, eff.gates);
    expect(sticky.has("movie")).toBe(true);
    expect(sticky.has("movie_help")).toBe(true); // sibling activated together
  });

  test("description falls back to the tool's description when the registry has none", () => {
    const eff = buildEffectiveGates(
      [{ name: "flux2", description: "tool desc", gating: { gate: "flux2" } }],
      reg({ flux2: { id: "flux2", keywords: ["flux"] } }), // no description in spec
    );
    expect(eff.gates[0]!.description).toBe("tool desc");
  });

  test("unknown gate id FAILS OPEN — tool is untracked (always active), no throw", () => {
    // Standing fail-open posture: a misdeclared reference must never hide a
    // tool at runtime. The drift-guard test (validateGating) is the LOUD guard.
    const eff = buildEffectiveGates(
      [{ name: "ghost", gating: { gate: "no-such-gate" } }],
      reg({}), // empty registry
    );
    expect(eff.gates).toHaveLength(0);
    expect(eff.tracked.has("ghost")).toBe(false);
    expect(eff.core.has("ghost")).toBe(false);
  });

  test("core:true wins over a gate reference", () => {
    const eff = buildEffectiveGates(
      [{ name: "enable_tool", gating: { core: true, gate: "movie" } }],
      reg({ movie: MOVIE_SPEC }),
    );
    expect(eff.core.has("enable_tool")).toBe(true);
    expect(eff.gates).toHaveLength(0);
  });

  test("01c: a def with core:true AND a stray gate reference is still core (core wins)", () => {
    const eff = buildEffectiveGates(
      [{ name: "enable_tool", gating: { core: true, gate: "movie" } }],
      reg({ movie: MOVIE_SPEC }),
    );
    expect(eff.core.has("enable_tool")).toBe(true);
    expect(eff.gates).toHaveLength(0);
  });

  test("mixed: core + two reference families coexist in one defs set", () => {
    const eff = buildEffectiveGates(
      [
        { name: "enable_tool", gating: { core: true } },
        { name: "legacy_gate", gating: { gate: "legacy" } },
        { name: "flux2", gating: { gate: "flux2" } },
        { name: "flux2_help", gating: { gate: "flux2" } },
      ],
      reg({ flux2: FLUX_SPEC, legacy: { id: "legacy", keywords: ["legacy"] } }),
    );
    expect(eff.core.has("enable_tool")).toBe(true);
    const legacy = eff.gates.find((g) => g.names.includes("legacy_gate"));
    expect(legacy?.gateId).toBe("legacy"); // every non-core gate carries an id (01c)
    expect(legacy?.keywords).toEqual(["legacy"]);
    const family = eff.gates.find((g) => g.gateId === "flux2");
    expect(family?.names).toEqual(["flux2", "flux2_help"]);
    expect(eff.tracked.size).toBe(4); // enable_tool + legacy_gate + flux2 + flux2_help
  });

  test("01c: the inline keywords/requires form is DELETED — such a def is invalid (fail-open, untracked)", () => {
    // Phase 01c deleted the inline branch: non-core gating must be a gate
    // reference. A def carrying inline keywords carries NO valid gating now —
    // it is simply untracked (fail-open); the drift-guard flags it at CI time.
    const eff = buildEffectiveGates(
      [{ name: "legacy", description: "l", gating: { keywords: ["kw1", "kw2"] } }] as never, // deleted inline shape (cast: no longer type-valid)
      reg({}),
    );
    expect(eff.gates).toHaveLength(0);
    expect(eff.tracked.has("legacy")).toBe(false);
  });
});

describe("01c — contract closed: only the reference form remains (expand–contract complete)", () => {
  test("reference-form families produce exactly the expected grouped gates", () => {
    const defs = [
      { name: "inspect_hooks", description: "d", gating: { gate: "inspect" } },
      { name: "enable_tool", description: "e", gating: { core: true } },
    ];
    const eff = buildEffectiveGates(defs, reg({ inspect: { id: "inspect", keywords: ["schema cost"], requires: { nouns: ["agent"], verbs: ["inspect"] } } }));
    expect(eff.gates.map((g) => ({ names: g.names, keywords: g.keywords, requires: g.requires, description: g.description, gateId: g.gateId }))).toEqual([
      { names: ["inspect_hooks"], keywords: ["schema cost"], requires: { nouns: ["agent"], verbs: ["inspect"] }, description: "d", gateId: "inspect" },
    ]);
    expect(eff.core.has("enable_tool")).toBe(true);
  });

  test("matchIntent treats an id-grouped family like its pre-01a siblings (fires whole family)", () => {
    const eff = buildEffectiveGates(
      [
        { name: "movie", gating: { gate: "movie" } },
        { name: "movie_help", gating: { gate: "movie" } },
      ],
      reg({ movie: MOVIE_SPEC }),
    );
    const sticky = new Set<string>();
    const matched = matchIntent("make a film", eff.gates, sticky);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.names).toEqual(["movie", "movie_help"]); // whole family, dormant
  });
});
