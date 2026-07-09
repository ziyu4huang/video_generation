import { test, expect, describe } from "bun:test";
import { buildSubagentArgs } from "../obsidian.ts";

const BASE = ["--mode", "json", "-p", "--no-session", "--approve"];

describe("buildSubagentArgs — subagent argv construction", () => {
  test("no opts → base flags + tools + system prompt only", () => {
    const args = buildSubagentArgs("read,bash", "/tmp/sys.md", "/pkg");
    expect(args).toEqual([...BASE, "-e", "/pkg", "--tools", "read,bash", "--append-system-prompt", "/tmp/sys.md"]);
  });

  test("model opt → appends --model", () => {
    const args = buildSubagentArgs("read", "/s", "/p", { model: "lm-studio/google/gemma-4-26b" });
    const i = args.indexOf("--model");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("lm-studio/google/gemma-4-26b");
  });

  test("excludeTools → joined as CSV under --exclude-tools", () => {
    const args = buildSubagentArgs("read,bash", "/s", "/p", { excludeTools: ["obsidian_create", "edit"] });
    const i = args.indexOf("--exclude-tools");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("obsidian_create,edit");
  });

  test("empty excludeTools array → NO --exclude-tools flag (omitted, not empty)", () => {
    const args = buildSubagentArgs("read", "/s", "/p", { excludeTools: [] });
    expect(args).not.toContain("--exclude-tools");
  });

  test("all opts together → flags emitted in a stable order, tools/prompt preserved", () => {
    const args = buildSubagentArgs("a,b", "/sys", "/pkg", {
      model: "zai/glm-5.2",
      excludeTools: ["x"],
    });
    // core flags still present and in order
    const core = ["--tools", "a,b", "--append-system-prompt", "/sys"];
    const coreIdx = core.map((c) => args.indexOf(c));
    expect(coreIdx).toEqual([...coreIdx].sort((a, b) => a - b));
    // every override present
    for (const f of ["--model", "--exclude-tools"]) {
      expect(args).toContain(f);
    }
  });

  test("pure + excludes the task (caller appends task separately)", () => {
    // The contract: buildSubagentArgs returns everything EXCEPT the task; the
    // caller pushes task last. Same input → same output (pure), and the result
    // equals the known flag set (no stray positional).
    const a1 = buildSubagentArgs("read", "/s", "/p");
    const a2 = buildSubagentArgs("read", "/s", "/p");
    expect(a1).toEqual(a2);
    expect(a1).toEqual([...BASE, "-e", "/p", "--tools", "read", "--append-system-prompt", "/s"]);
  });
});
