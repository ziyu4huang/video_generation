import { test, expect, describe } from "bun:test";
import { EXTENSION_COMMANDS, EXTENSION_SPECS, toCommand } from "../extensions/registry.ts";
import { findCommandToken } from "../dispatch.ts";
import type { ExtensionSubcommandSpec } from "../extensions/types.ts";

/**
 * Guards the extension → sub-command registration contract:
 *   - every spec produces a Command with matching name/summary/details
 *   - flux2 is registered and dispatched as a reserved command token
 *   - the curated tool allowlist is non-empty (an empty allowlist would start
 *     the agent with zero usable tools — validateToolNames can't catch absence)
 */
describe("extension sub-command registry", () => {
  test("flux2 is registered", () => {
    const names = EXTENSION_COMMANDS.map((c) => c.name);
    expect(names).toContain("flux2");
    expect(EXTENSION_SPECS.length).toBeGreaterThan(0);
  });

  test("every spec satisfies ExtensionSubcommandSpec structurally", () => {
    for (const spec of EXTENSION_SPECS) {
      expect(typeof spec.name).toBe("string");
      expect(spec.name.length).toBeGreaterThan(0);
      expect(spec.name[0]).not.toBe("-"); // not a flag
      expect(typeof spec.summary).toBe("string");
      expect(typeof spec.details).toBe("string");
      expect(typeof spec.factory).toBe("function"); // ExtensionFactory
      expect(Array.isArray(spec.tools)).toBe(true);
      expect(spec.tools.length).toBeGreaterThan(0); // empty = silent zero-tool session
      expect(typeof spec.task).toBe("function");
    }
  });

  test("toCommand() preserves name/summary/details and yields a runnable", () => {
    const spec: ExtensionSubcommandSpec = {
      name: "dummy",
      summary: "s",
      details: "d",
      factory: () => {},
      tools: ["flux2"],
      task: () => "do something",
    };
    const cmd = toCommand(spec);
    expect(cmd.name).toBe("dummy");
    expect(cmd.summary).toBe("s");
    expect(cmd.details).toBe("d");
    expect(typeof cmd.run).toBe("function");
  });

  test("spec names are unique", () => {
    const names = EXTENSION_SPECS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("flux2 task echoes the positional request", () => {
    const flux2 = EXTENSION_SPECS.find((s) => s.name === "flux2")!;
    const task = flux2.task({ positionals: ["generate", "a red cube"] });
    expect(task).toContain("a red cube");
    expect(task).toContain("flux2");
  });

  test("flux2 task falls back to a prompt when no positionals given", () => {
    const flux2 = EXTENSION_SPECS.find((s) => s.name === "flux2")!;
    const task = flux2.task({ positionals: [] });
    expect(task.length).toBeGreaterThan(0); // no-op guard
  });
});

describe("findCommandToken — extension sub-commands dispatch", () => {
  test("flux2 is a reserved token (command-first)", () => {
    expect(findCommandToken(["flux2", "generate", "a cube"])).toEqual({
      name: "flux2",
      index: 0,
    });
  });

  test("flux2 is detected after leading global flags", () => {
    expect(findCommandToken(["--model", "sonnet", "flux2", "t2i"])).toEqual({
      name: "flux2",
      index: 2,
    });
  });
});

describe("research-tool extension sub-commands", () => {
  test("collect-videos is registered", () => {
    const names = EXTENSION_COMMANDS.map((c) => c.name);
    expect(names).toContain("collect-videos");
    expect(names).toContain("organize-vault");
    expect(names).toContain("import-memory");
  });

  test("collect-videos task builder includes tool params from positionals", () => {
    const spec = EXTENSION_SPECS.find((s) => s.name === "collect-videos")!;
    const task = spec.task({ positionals: ["bilibili", "llm"] });
    expect(task).toContain("collect_videos");
    expect(task).toContain('platform="bilibili"');
    expect(task).toContain('preset="llm"');
  });

  test("collect-videos task defaults to bilibili/llm when no positionals", () => {
    const spec = EXTENSION_SPECS.find((s) => s.name === "collect-videos")!;
    const task = spec.task({ positionals: [] });
    expect(task).toContain("collect_videos");
    expect(task).toContain('platform="bilibili"');
    expect(task).toContain('preset="llm"');
  });

  test("collect-videos passes keywords comma-joined when multiple remain", () => {
    const spec = EXTENSION_SPECS.find((s) => s.name === "collect-videos")!;
    const task = spec.task({ positionals: ["bilibili", "custom", "RLHF", "PPO"] });
    expect(task).toContain('"RLHF,PPO"');
  });

  test("organize-vault task mentions the tool name", () => {
    const spec = EXTENSION_SPECS.find((s) => s.name === "organize-vault")!;
    const task = spec.task({ positionals: [] });
    expect(task).toContain("organize_vault_notes");
  });

  test("import-memory task mentions the tool name", () => {
    const spec = EXTENSION_SPECS.find((s) => s.name === "import-memory")!;
    const task = spec.task({ positionals: [] });
    expect(task).toContain("import_memory_to_vault");
  });

  test("collect-videos is reserved token in findCommandToken", () => {
    expect(findCommandToken(["collect-videos", "bilibili", "llm"])).toEqual({
      name: "collect-videos",
      index: 0,
    });
  });

  test("collect-videos is detected after leading global flags", () => {
    expect(findCommandToken(["--model", "sonnet", "collect-videos", "bilibili"])).toEqual({
      name: "collect-videos",
      index: 2,
    });
  });

  test("organize-vault is reserved token", () => {
    expect(findCommandToken(["organize-vault", "--dry-run"])).toEqual({
      name: "organize-vault",
      index: 0,
    });
  });

  test("import-memory is reserved token", () => {
    expect(findCommandToken(["import-memory", "--output-path", "./out.jsonl"])).toEqual({
      name: "import-memory",
      index: 0,
    });
  });
});
