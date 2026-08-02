import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { buildPromptAssembly, buildPromptContext } from "../src/prompt-context.js";
import type { MemoryStore } from "../src/store/memory-store.js";

type Signature = { mdId: string; signature: string };

/**
 * Minimal stub of MemoryStore implementing ONLY the two assembly-manifest methods
 * consumed by buildPromptAssembly (Task 1 additions). Typed loosely so the stub
 * satisfies the MemoryStore parameter without standing up a full tmp-dir store.
 * `signatures` defaults to [] so Task-2-agnostic call sites stay one-liners.
 */
function stubStore(
  main: { block: string; mdIds: string[]; signatures?: Signature[] },
  project?: { block: string; mdIds: string[]; signatures?: Signature[] },
): MemoryStore {
  return {
    getAssemblyManifest: () => ({ signatures: [], ...main }),
    getProjectAssemblyManifest: (_name: string) =>
      project ? { signatures: [], ...project } : { block: "", mdIds: [], signatures: [] },
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

  // ---- Task 2 (UPSP §9): per-entry signatures threaded through AssemblyReceipt ----

  test("populated store → unions both manifests' signatures (memory-before-project order)", () => {
    const sigM: Signature[] = [
      { mdId: "a", signature: "alpha fragment" },
      { mdId: "b", signature: "bravo fragment" },
    ];
    const sigP: Signature[] = [
      { mdId: "c", signature: "charlie fragment" },
    ];
    const store = stubStore({ block: "M", mdIds: ["a", "b"], signatures: sigM });
    const projectStore = stubStore({ block: "ignored" }, { block: "P", mdIds: ["c"], signatures: sigP });

    const got = buildPromptAssembly({ memoryMode: "default" } as any, store, projectStore, "p")!;

    expect(got.signatures).toEqual([...sigM, ...sigP]);
  });

  test("shared mdId across memory + project → deduped once, memory occurrence kept (first wins)", () => {
    // md_id "b" appears in BOTH manifests — a memory entry and a project entry could
    // share an md_id. Dedup keeps the first occurrence (memory-store order first).
    const sigM: Signature[] = [
      { mdId: "a", signature: "alpha fragment" },
      { mdId: "b", signature: "bravo fragment (from memory)" },
    ];
    const sigP: Signature[] = [
      { mdId: "b", signature: "bravo fragment (from project)" },
      { mdId: "c", signature: "charlie fragment" },
    ];
    const store = stubStore({ block: "M", mdIds: ["a", "b"], signatures: sigM });
    const projectStore = stubStore({ block: "ignored" }, { block: "P", mdIds: ["b", "c"], signatures: sigP });

    const got = buildPromptAssembly({ memoryMode: "default" } as any, store, projectStore, "p")!;

    const ids = got.signatures.map((s) => s.mdId);
    expect(ids).toEqual(["a", "b", "c"]); // "b" appears exactly once
    const b = got.signatures.find((s) => s.mdId === "b")!;
    expect(b.signature).toBe("bravo fragment (from memory)"); // first occurrence wins
  });

  test("null projectStore → signatures = main manifest's signatures", () => {
    const sigM: Signature[] = [{ mdId: "a", signature: "alpha fragment" }];
    const store = stubStore({ block: "M", mdIds: ["a"], signatures: sigM });

    const got = buildPromptAssembly({ memoryMode: "default" } as any, store, null, "p")!;

    expect(got.signatures).toEqual(sigM);
  });

  test("project manifest returns no signatures → union degrades to main manifest's signatures", () => {
    // A manifest may legitimately return an empty signatures array (e.g. project block
    // empty / all entries below the signature min-length). Union just takes what exists.
    const sigM: Signature[] = [{ mdId: "a", signature: "alpha fragment" }];
    const store = stubStore({ block: "M", mdIds: ["a"], signatures: sigM });
    const projectStore = stubStore(
      { block: "ignored" },
      { block: "P", mdIds: ["c"], signatures: [] },
    );

    const got = buildPromptAssembly({ memoryMode: "default" } as any, store, projectStore, "p")!;

    expect(got.signatures).toEqual(sigM);
  });

  test("signatures is always an array on a populated receipt (never undefined)", () => {
    const store = stubStore({ block: "M", mdIds: ["a"], signatures: [] });
    const got = buildPromptAssembly({ memoryMode: "default" } as any, store, null, "p")!;
    expect(Array.isArray(got.signatures)).toBe(true);
    expect(got.signatures).toEqual([]);
  });

  test("buildPromptContext is still exported unchanged", () => {
    // smoke: confirm the sibling export survived and is callable.
    expect(typeof buildPromptContext).toBe("function");
  });
});
