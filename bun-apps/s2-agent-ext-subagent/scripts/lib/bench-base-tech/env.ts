/**
 * Bench environment helpers — ZAI key materialization + scratch cwd seeding
 * (spec §2: every lane gets the identical scratch project + hard-problem
 * agentType bound to zai/glm-5.3).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Parse ZAI_API_KEY from ~/.zshrc when the shell did not export it. */
export function parseZaiKey(): string | null {
  try {
    const line = readFileSync(path.join(os.homedir(), ".zshrc"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("export ZAI_API_KEY="));
    if (!line) return null;
    return line.replace(/^export ZAI_API_KEY=/, "").replace(/^["']|["']$/g, "") || null;
  } catch {
    return null;
  }
}

export function zaiEnv(): Record<string, string> {
  const key = process.env.ZAI_API_KEY || parseZaiKey();
  return key ? { ZAI_API_KEY: key } : {};
}

/** Seed the scratch project every lane runs against (mirrors tui-drive.ts). */
export function seedScratch(scenarioFiles: boolean): string {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "s2-bench13-"));
  writeFileSync(path.join(cwd, "sample.ts"), "export const a = 1\nexport function b() { return a + 1 }\n");
  writeFileSync(path.join(cwd, "README.md"), "# bench13 scratch\n");
  if (scenarioFiles) {
    mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      path.join(cwd, ".pi", "agents", "hard-problem.md"),
      [
        "---",
        "name: hard-problem",
        "description: Deep analysis on hard problems — bound to the big model.",
        "model: zai/glm-5.3",
        "---",
        "You are the hard-problem analyst. Read the actual artifact before theorizing;",
        "deployed is not source; a version label is not the content.",
      ].join("\n"),
    );
  }
  return cwd;
}
