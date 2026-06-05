#!/usr/bin/env bun
/**
 * audit-skill-descriptions.ts — Standalone skill health audit
 *
 * Walks all SKILL.md files under .agents/skills/ (excluding _archived/),
 * validates each using the same validateSkillMd() from the PostToolUse hook,
 * and reports per-file pass/fail with a summary line.
 *
 * Usage: bun scripts/audit-skill-descriptions.ts
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { validateSkillMd } from "../.claude/hooks/validate-skill-md";

const REPO_ROOT = import.meta.dir.replace(/\/scripts$/, "");
const SKILLS_DIR = join(REPO_ROOT, ".agents/skills");

interface FileResult {
  name: string;
  ok: boolean;
  errors: string[];
}

async function main() {
  let entries: string[];
  try {
    const dirs = await readdir(SKILLS_DIR, { withFileTypes: true });
    entries = dirs
      .filter(e => e.isDirectory() && e.name !== "_archived")
      .map(e => e.name)
      .sort();
  } catch {
    console.error(`Cannot read skills dir: ${SKILLS_DIR}`);
    process.exit(1);
  }

  const results: FileResult[] = [];
  let overLimit = 0;
  let yamlErrors = 0;

  for (const name of entries) {
    const filePath = join(SKILLS_DIR, name, "SKILL.md");
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      results.push({ name, ok: false, errors: ["SKILL.md not found"] });
      continue;
    }

    const result = validateSkillMd(content);
    if (result.ok) {
      results.push({ name, ok: true, errors: [] });
    } else {
      results.push({ name, ok: false, errors: result.errors });
      for (const err of result.errors) {
        if (err.includes("YAML parse")) yamlErrors++;
        if (err.includes("chars (max")) overLimit++;
      }
    }
  }

  // Per-file report
  for (const r of results) {
    const icon = r.ok ? "PASS" : "FAIL";
    const label = r.ok ? `\x1b[32m${icon}\x1b[0m` : `\x1b[31m${icon}\x1b[0m`;
    console.log(`  ${label}  ${r.name}`);
    for (const err of r.errors) {
      console.log(`         \x1b[31m• ${err}\x1b[0m`);
    }
  }

  // Summary
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length} skills scanned, ${overLimit} over-limit, ${yamlErrors} YAML errors`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
