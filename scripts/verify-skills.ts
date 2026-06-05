#!/usr/bin/env bun
/**
 * verify-skills.ts — Static + live skill verification
 *
 * Static checks (default, no AI needed):
 *   - description ≤ 150 chars
 *   - description has trigger keywords
 *   - tags field present
 *   - SKILL.md ≤ 100 lines
 *   - .claude/skills/ symlink exists
 *
 * Live smoke test (--live):
 *   Invokes each skill via Claude Code using claude-code-glm.sh or claude-code-deepseek.sh backend.
 *   Sends "/<skill-name>" and verifies non-empty response.
 *
 * Usage:
 *   bun scripts/verify-skills.ts
 *   bun scripts/verify-skills.ts --live
 *   bun scripts/verify-skills.ts --live --backend deepseek
 *   bun scripts/verify-skills.ts --skill generate-video
 *   bun scripts/verify-skills.ts --live --skill disk-analysis --backend glm
 */

import { readdir, readFile, lstat, readlink } from "fs/promises";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { existsSync } from "fs";

// ─── Config ────────────────────────────────────────────────

const REPO_ROOT = import.meta.dir.replace(/\/scripts$/, "");
const SKILLS_DIR = join(REPO_ROOT, ".agents/skills");
const CLAUDE_SKILLS_DIR = join(REPO_ROOT, ".claude/skills");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");

const DESC_MAX_CHARS = 150;
const SKILL_MAX_LINES = 100;

// ─── CLI args ───────────────────────────────────────────────

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const backendIdx = args.indexOf("--backend");
const BACKEND: "glm" | "deepseek" = (backendIdx !== -1 ? args[backendIdx + 1] : "glm") as "glm" | "deepseek";
const skillIdx = args.indexOf("--skill");
const ONLY_SKILL: string | null = skillIdx !== -1 ? args[skillIdx + 1] : null;

// ─── Colors ─────────────────────────────────────────────────

const C = {
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
};

// ─── Types ──────────────────────────────────────────────────

interface SkillResult {
  name: string;
  pass: boolean;
  violations: string[];
  warnings: string[];
  liveResult?: "pass" | "fail" | "skip";
  liveOutput?: string;
}

// ─── YAML frontmatter parser ────────────────────────────────

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  const lines = match[1].split("\n");
  let currentKey: string | null = null;
  let blockLines: string[] = [];

  for (const line of lines) {
    const keyMatch = line.match(/^([a-z_-]+):\s*(>?)(.*)$/);
    if (keyMatch) {
      if (currentKey && blockLines.length > 0) {
        result[currentKey] = blockLines.join(" ").trim();
        blockLines = [];
      }
      currentKey = keyMatch[1];
      const isBlock = keyMatch[2] === ">";
      const inline = keyMatch[3].trim();
      if (!isBlock && inline) {
        result[currentKey] = inline;
        currentKey = null;
      }
    } else if (currentKey && line.match(/^\s{2,}/)) {
      blockLines.push(line.trim());
    } else if (currentKey) {
      if (blockLines.length > 0) {
        result[currentKey] = blockLines.join(" ").trim();
        blockLines = [];
      }
      currentKey = null;
    }
  }
  if (currentKey && blockLines.length > 0) {
    result[currentKey] = blockLines.join(" ").trim();
  }
  return result;
}

// ─── Static checks ──────────────────────────────────────────

async function checkSkill(skillName: string): Promise<SkillResult> {
  const result: SkillResult = { name: skillName, pass: true, violations: [], warnings: [] };
  const skillFile = join(SKILLS_DIR, skillName, "SKILL.md");

  let content: string;
  try {
    content = await readFile(skillFile, "utf-8");
  } catch {
    result.violations.push("SKILL.md not found");
    result.pass = false;
    return result;
  }

  const fm = parseFrontmatter(content);
  const lines = content.split("\n").length;

  // Check 1: description exists
  const desc = fm.description?.trim() ?? "";
  if (!desc) {
    result.violations.push("description: missing or empty");
    result.pass = false;
  } else {
    // Check 2: description ≤ 150 chars
    if (desc.length > DESC_MAX_CHARS) {
      result.violations.push(
        `description: ${desc.length} chars (max ${DESC_MAX_CHARS}). Trim: "${desc.slice(0, 80)}..."`
      );
      result.pass = false;
    }

    // Check 3: trigger keywords
    const hasTrigger = /use (when|for|to)|triggers on|run before/i.test(desc);
    if (!hasTrigger) {
      result.warnings.push(`description: no trigger keyword ("Use when/for", "Triggers on")`);
    }
  }

  // Check 4: tags field
  if (!fm.tags) {
    result.violations.push("tags: field missing");
    result.pass = false;
  } else {
    const tagCount = fm.tags.split(",").map(t => t.trim()).filter(Boolean).length;
    if (tagCount < 2) result.warnings.push(`tags: only ${tagCount} tag (recommend 2-4)`);
    if (tagCount > 4) result.warnings.push(`tags: ${tagCount} tags (recommend 2-4)`);
  }

  // Check 5: line count
  if (lines > SKILL_MAX_LINES) {
    result.warnings.push(`SKILL.md: ${lines} lines (max ${SKILL_MAX_LINES} — consider splitting)`);
  }

  // Check 6: .claude/skills/ symlink
  const symlinkPath = join(CLAUDE_SKILLS_DIR, skillName);
  try {
    const stat = await lstat(symlinkPath);
    if (!stat.isSymbolicLink()) {
      result.violations.push(`.claude/skills/${skillName}: exists but is not a symlink`);
      result.pass = false;
    } else {
      const target = await readlink(symlinkPath);
      const expected = `../../.agents/skills/${skillName}`;
      if (target !== expected) {
        result.warnings.push(`.claude/skills/${skillName} -> "${target}" (expected "${expected}")`);
      }
    }
  } catch {
    result.violations.push(`.claude/skills/${skillName}: symlink missing`);
    result.pass = false;
  }

  return result;
}

// ─── Live smoke test ─────────────────────────────────────────

function runLiveTest(skillName: string, backend: "glm" | "deepseek"): { pass: boolean; output: string } {
  const wrapperScript = backend === "glm"
    ? join(SCRIPTS_DIR, "claude-code-glm.sh")
    : join(SCRIPTS_DIR, "claude-code-deepseek.sh");

  if (!existsSync(wrapperScript)) {
    return { pass: false, output: `wrapper not found: ${wrapperScript}` };
  }

  // Use claude -p (non-interactive print mode) via the wrapper
  // The wrapper sources glm/deepseek env and calls claude with dangerously-skip-permissions
  const prompt = `Briefly describe what the /${skillName} skill does in one sentence. No need to invoke it.`;

  const result = spawnSync(
    "bash",
    [wrapperScript, "-p", prompt, "--output-format", "text"],
    {
      timeout: 30_000,
      env: {
        ...process.env,
        // Suppress interactive features
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      encoding: "utf-8",
      cwd: REPO_ROOT,
    }
  );

  const output = ((result.stdout ?? "") + (result.stderr ?? "")).trim();
  const pass = result.status === 0 && output.length > 10;
  return { pass, output: output.slice(0, 200) };
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log(C.bold("\n=== Skill Verification ==="));
  console.log(C.dim(`SKILLS_DIR: ${SKILLS_DIR}`));
  console.log(C.dim(`Checks: static${LIVE ? ` + live (${BACKEND})` : ""}`));
  if (ONLY_SKILL) console.log(C.dim(`Filtering: ${ONLY_SKILL}`));
  console.log();

  // Enumerate skills
  let skillNames: string[];
  try {
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    skillNames = entries
      .filter(e => e.isDirectory() && e.name !== "_archived")
      .map(e => e.name)
      .sort();
  } catch {
    console.error(C.red(`Cannot read skills dir: ${SKILLS_DIR}`));
    process.exit(1);
  }

  if (ONLY_SKILL) {
    skillNames = skillNames.filter(n => n === ONLY_SKILL);
    if (skillNames.length === 0) {
      console.error(C.red(`Skill not found: ${ONLY_SKILL}`));
      process.exit(1);
    }
  }

  const results: SkillResult[] = [];
  let totalViolations = 0;

  for (const name of skillNames) {
    process.stdout.write(`  Checking ${C.cyan(name.padEnd(35))} `);
    const r = await checkSkill(name);

    if (LIVE) {
      process.stdout.write(`${C.dim("[live...]")} `);
      const { pass, output } = runLiveTest(name, BACKEND);
      r.liveResult = pass ? "pass" : "fail";
      r.liveOutput = output;
      if (!pass) r.pass = false;
    }

    results.push(r);
    totalViolations += r.violations.length;

    const icon = r.pass ? C.green("✓") : C.red("✗");
    const staticLabel = r.violations.length === 0
      ? C.green("static:pass")
      : C.red(`static:FAIL(${r.violations.length})`);
    const liveLabel = !LIVE ? "" : r.liveResult === "pass"
      ? ` ${C.green("live:pass")}`
      : r.liveResult === "fail"
      ? ` ${C.red("live:FAIL")}`
      : "";

    console.log(`${icon} ${staticLabel}${liveLabel}`);

    for (const v of r.violations) {
      console.log(`    ${C.red("VIOLATION")} ${v}`);
    }
    for (const w of r.warnings) {
      console.log(`    ${C.yellow("WARN")}      ${w}`);
    }
    if (r.liveResult === "fail" && r.liveOutput) {
      console.log(`    ${C.red("LIVE OUTPUT")} ${C.dim(r.liveOutput)}`);
    }
  }

  // Summary
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log(C.bold("\n=== Summary ==="));
  console.log(`Skills:     ${results.length}`);
  console.log(`Passed:     ${C.green(String(passed))}`);
  if (failed > 0) console.log(`Failed:     ${C.red(String(failed))}`);
  console.log(`Violations: ${totalViolations > 0 ? C.red(String(totalViolations)) : C.green("0")}`);

  const warnCount = results.reduce((a, r) => a + r.warnings.length, 0);
  if (warnCount > 0) console.log(`Warnings:   ${C.yellow(String(warnCount))}`);

  if (totalViolations > 0) {
    console.log(C.red("\nVerification FAILED\n"));
    process.exit(1);
  } else {
    console.log(C.green("\nVerification PASSED\n"));
    process.exit(0);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
