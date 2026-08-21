import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Manifest, readManifest, validateManifest } from "../src/workflow-pack-manifest.js";

/**
 * `workflow-pack-manifest.ts` — the workflow-pack manifest model (Decision 2:
 * minimal load-bearing). Required: name/description/entry. Optional: args/model/
 * thinking/howToRun. Pure: no network.
 *
 * Phase 1 contract: every later phase (resolver, runner, list, examples) reads a
 * pack through readManifest/validateManifest, so these are the load-bearing tests
 * for the whole feature.
 */

const VALID = {
  name: "echo",
  description: "smoke pack",
  entry: "index.js",
};

// ── validateManifest (pure, no fs) ─────────────────────────────────────────

describe("validateManifest", () => {
  test("a minimal valid manifest returns a typed Manifest", () => {
    const m = validateManifest(VALID);
    expect(m.name).toBe("echo");
    expect(m.description).toBe("smoke pack");
    expect(m.entry).toBe("index.js");
  });

  test("optional fields are ABSENT when not supplied (not defaulted to a value)", () => {
    const m = validateManifest(VALID);
    expect("args" in m).toBe(false);
    expect("model" in m).toBe(false);
    expect("thinking" in m).toBe(false);
    expect("howToRun" in m).toBe(false);
    expect("kind" in m).toBe(false);
    expect("engine" in m).toBe(false);
  });

  test("optional fields are present when supplied (args may be any JSON value)", () => {
    const m = validateManifest({ ...VALID, args: { x: 1 }, model: "lm-studio/x", thinking: "low", howToRun: "run it" });
    expect(m.args).toEqual({ x: 1 });
    expect(m.model).toBe("lm-studio/x");
    expect(m.thinking).toBe("low");
    expect(m.howToRun).toBe("run it");
  });

  test("args accepts any JSON value (no schema validation in v1)", () => {
    expect(validateManifest({ ...VALID, args: [1, 2, 3] }).args).toEqual([1, 2, 3]);
    expect(validateManifest({ ...VALID, args: "just a string" }).args).toBe("just a string");
    expect(validateManifest({ ...VALID, args: null }).args).toBeNull();
  });

  test.each([
    "name",
    "description",
    "entry",
  ] as const)('missing required field "%s" throws naming the field', (field) => {
    const partial = { ...VALID } as Record<string, unknown>;
    delete partial[field];
    expect(() => validateManifest(partial)).toThrow(new RegExp(`"${field}"`));
  });

  test("empty/whitespace required field throws naming the field", () => {
    expect(() => validateManifest({ ...VALID, name: "" })).toThrow(/"name"/);
    expect(() => validateManifest({ ...VALID, name: "   " })).toThrow(/"name"/);
    expect(() => validateManifest({ ...VALID, entry: "" })).toThrow(/"entry"/);
  });

  test("a non-object manifest (array / null / primitive) throws a clear error", () => {
    expect(() => validateManifest([])).toThrow(/must be a JSON object/);
    expect(() => validateManifest(null)).toThrow(/must be a JSON object/);
    expect(() => validateManifest("echo")).toThrow(/must be a JSON object/);
  });

  test("optional model/thinking/howToRun must be strings when present", () => {
    expect(() => validateManifest({ ...VALID, model: 42 })).toThrow(/"model"/);
    expect(() => validateManifest({ ...VALID, thinking: 1 })).toThrow(/"thinking"/);
    expect(() => validateManifest({ ...VALID, howToRun: false })).toThrow(/"howToRun"/);
  });

  test("optional kind/engine are present when supplied (self-identification)", () => {
    const m = validateManifest({ ...VALID, kind: "workflow-pack", engine: "s2-agent-ext-ultracode" });
    expect(m.kind).toBe("workflow-pack");
    expect(m.engine).toBe("s2-agent-ext-ultracode");
  });

  test("optional kind/engine must be strings when present", () => {
    expect(() => validateManifest({ ...VALID, kind: 42 })).toThrow(/"kind"/);
    expect(() => validateManifest({ ...VALID, engine: false })).toThrow(/"engine"/);
  });

  test("empty/whitespace optional string fields are rejected (D2-1)", () => {
    expect(() => validateManifest({ ...VALID, model: "" })).toThrow(/non-empty string/);
    expect(() => validateManifest({ ...VALID, model: "   " })).toThrow(/non-empty string/);
    expect(() => validateManifest({ ...VALID, thinking: "  " })).toThrow(/non-empty string/);
    expect(() => validateManifest({ ...VALID, howToRun: "" })).toThrow(/non-empty string/);
    expect(() => validateManifest({ ...VALID, kind: " " })).toThrow(/non-empty string/);
    expect(() => validateManifest({ ...VALID, engine: "" })).toThrow(/non-empty string/);
  });

  test("a non-empty optional model still passes (D2-1 regression guard)", () => {
    const m = validateManifest({ ...VALID, model: "lm-studio/x" });
    expect(m.model).toBe("lm-studio/x");
  });
});

// ── readManifest (real fs via mkdtemp) ─────────────────────────────────────

describe("readManifest", () => {
  test("reads + validates a manifest.json from a pack dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(VALID));
    const m = readManifest(dir);
    expect(m.name).toBe("echo");
    expect(m.entry).toBe("index.js");
  });

  test("a dir without manifest.json throws (not a workflow pack)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    expect(() => readManifest(dir)).toThrow(/no manifest\.json/);
  });

  test("malformed JSON throws a clear, prefixed error (not an opaque SyntaxError)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writeFileSync(join(dir, "manifest.json"), "{not json}");
    expect(() => readManifest(dir)).toThrow(/not valid JSON/);
  });

  test("valid JSON but missing a required field throws naming it", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "x", description: "d" }));
    expect(() => readManifest(dir)).toThrow(/"entry"/);
  });

  test("accepts injectable read/exists (no real-fs dependency for the contract)", () => {
    const files = new Map<string, string>([["/fake/manifest.json", JSON.stringify(VALID)]]);
    const m = readManifest("/fake", {
      exists: (p) => files.has(p),
      read: (p) => files.get(p)!,
    });
    expect(m.name).toBe("echo");
  });

  test("a read failure is reported as 'could not read' not 'not valid JSON' (D2-4)", () => {
    expect(() =>
      readManifest("/fake", {
        exists: () => true,
        read: () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    ).toThrow(/could not read manifest\.json/);
  });
});

// ── type-level sanity (compile-time only) ──────────────────────────────────

test("Manifest type compiles with required + optional fields", () => {
  const m: Manifest = { name: "x", description: "d", entry: "i.js" };
  expect(m.entry).toBe("i.js");
});

// ── io / version / agents (ticket 14, T1 — decision 05) ─────────────────────

test("validateManifest accepts version, agents, and io block", () => {
  const m = validateManifest({
    name: "demo",
    description: "d",
    entry: "entry.js",
    version: "0.1.0",
    agents: "agents/*.md",
    io: {
      inputs: "inputs/",
      outputs: { naming: "timestamped", retention: "last-N" },
      intermediate: { persist: true, retention: "purge-after-run" },
      runs: { retention: "all" },
    },
  });
  expect(m.version).toBe("0.1.0");
  expect(m.agents).toBe("agents/*.md");
  expect(m.io?.outputs?.naming).toBe("timestamped");
  expect(m.io?.intermediate?.persist).toBe(true);
});

test("validateManifest rejects a non-string version", () => {
  expect(() => validateManifest({ name: "d", description: "d", entry: "e.js", version: 1 })).toThrow(/version/);
});

test("validateManifest omits io/version/agents when not supplied", () => {
  const m = validateManifest({ name: "d", description: "d", entry: "e.js" });
  expect("io" in m).toBe(false);
  expect("version" in m).toBe(false);
  expect("agents" in m).toBe(false);
});

test("validateManifest rejects a non-object io (must be an object)", () => {
  const valid = { name: "d", description: "d", entry: "e.js" };
  expect(() => validateManifest({ ...valid, io: "not-an-object" })).toThrow(/"io".*object/);
  expect(() => validateManifest({ ...valid, io: [1, 2] })).toThrow(/"io".*object/);
  expect(() => validateManifest({ ...valid, io: null })).toThrow(/"io".*object/);
});
