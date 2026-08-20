/**
 * First-class gate contract (wayfinder ticket 01) — the exported `Gate` type
 * and shared `GATE_DEFS` registry must be importable from the package entry
 * (no ambient-global dependency) and behave as the shared, mutable registry
 * the 14 owning extensions populate in phase 01b.
 */
import { describe, expect, test } from "bun:test";
import { GATE_DEFS, type Gate } from "../src/index.ts";

describe("gate contract — GATE_DEFS shared registry", () => {
  test("exported from the package entry (importable, not ambient)", () => {
    expect(typeof GATE_DEFS).toBe("object");
    expect(GATE_DEFS).not.toBeNull();
  });

  test("accepts a declared gate family by id", () => {
    const gate: Gate = {
      id: "flux2",
      keywords: ["flux", "flux2"],
      requires: { nouns: ["image"], verbs: ["generate"] },
      description: "FLUX.2 image generation",
    };
    GATE_DEFS["flux2"] = gate;
    expect(GATE_DEFS["flux2"]).toBe(gate);
    expect(GATE_DEFS["flux2"]!.keywords).toEqual(["flux", "flux2"]);
    delete GATE_DEFS["flux2"]; // never leak test gates into the shared registry
    expect(GATE_DEFS["flux2"]).toBeUndefined();
  });
});
