import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { buildPromptAssembly, buildPromptContext } from "../src/prompt-context.js";
import type { MemoryStore } from "../src/store/memory-store.js";

/**
 * Minimal stub of MemoryStore implementing ONLY the two assembly-manifest methods
 * consumed by buildPromptAssembly (Task 1 additions). Typed loosely so the stub
 * satisfies the MemoryStore parameter without standing up a full tmp-dir store.
 */
function stubStore(
  main: { block: string; mdIds: string[] },
  project?: { block: string; mdIds: string[] },
): MemoryStore {
  return {
    getAssemblyManifest: () => main,
    getProjectAssemblyManifest: (_name: string) => project ?? { block: "", mdIds: [] },
  } as unknown as MemoryStore;
}

describe("buildPromptAssembly", () => {
  test("populated store → unions ids + sha256 of joined memoryBlock+projectBlock", () => {
    const store = stubStore({ block: "M", mdIds: ["a", "b"] });
    const projectStore = stubStore({ block: "ignored" }, { block: "P", mdIds: ["b", "c"] });
    const config = { memoryMode: "default" } as any;

    const got = buildPromptAssembly(config, store, projectStore, "p")!;

    expect(got.mdIds.sort()).toEqual(["a", "b", "c"]); // unioned + deduped
    const expectedHash = createHash("sha256").update("M\n\nP", "utf8").digest("hex");
    expect(got.hash).toBe(expectedHash);
  });

  test("policy-only mode → null", () => {
    const store = stubStore({ block: "M", mdIds: ["a"] });
    const got = buildPromptAssembly(
      { memoryMode: "policy-only" } as any,
      store,
      null,
      "p",
    );
    expect(got).toBeNull();
  });

  test("empty store (no block) → null", () => {
    const store = stubStore({ block: "", mdIds: [] });
    expect(
      buildPromptAssembly({ memoryMode: "default" } as any, store, null, "p"),
    ).toBeNull();
  });

  test("null projectStore → still hashes main block", () => {
    const store = stubStore({ block: "M", mdIds: ["a"] });
    const got = buildPromptAssembly({ memoryMode: "default" } as any, store, null, "p")!;
    expect(got.mdIds).toEqual(["a"]);
    expect(got.hash).toBe(createHash("sha256").update("M", "utf8").digest("hex"));
  });

  test("buildPromptContext is still exported unchanged", () => {
    // smoke: confirm the sibling export survived and is callable.
    expect(typeof buildPromptContext).toBe("function");
  });
});
