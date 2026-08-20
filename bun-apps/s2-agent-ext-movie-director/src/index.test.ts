import { describe, expect, it } from "bun:test";
import * as index from "./index.ts";

// The public surface is a wall of `export * from "./*.ts"`. TypeScript already
// catches AMBIGUOUS re-exports (two modules exporting the same name with
// different bindings) at compile time, but nothing previously asserted that
// importing the barrel actually succeeds at runtime, or that the load-bearing
// entry points every consumer package (extensions/, other bun-apps/*) reaches
// through it stay present as the module list grows.
describe("index.ts public surface", () => {
  it("loads without throwing and re-exports a non-trivial symbol set", () => {
    expect(Object.keys(index).length).toBeGreaterThan(10);
  });

  it("re-exports the core selector/registry/schema entry points", () => {
    expect(typeof index.selectProvider).toBe("function");
    expect(typeof index.probeConfigured).toBe("function");
    expect(typeof index.getByCapability).toBe("function");
    expect(typeof index.providerMenuSummary).toBe("function");
    expect(Array.isArray(index.REGISTRY)).toBe(true);
    expect(typeof index.validateArtifact).toBe("function");
  });

  it("re-exports the shared spawn primitives introduced by the runSpawn dedup", () => {
    expect(typeof index.runSpawn).toBe("function");
  });

  it("re-exports the compose tiers and their shared ffprobe helper", () => {
    expect(typeof index.composeVideo).toBe("function");
    expect(typeof index.probeMedia).toBe("function");
    expect(typeof index.probeDuration).toBe("function");
  });

  it("re-exports pipeline/checkpoint/cost primitives", () => {
    expect(typeof index.loadPipeline).toBe("function");
    expect(typeof index.writeCheckpoint).toBe("function");
  });
});
