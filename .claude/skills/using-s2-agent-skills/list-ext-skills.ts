#!/usr/bin/env bun
// List every reusable skill / CLI / script shipped in bun-apps/s2-agent-ext-*.
// Bun twin of the retired list-ext-skills.sh. Run from the repo root:
//   bun .claude/skills/using-s2-agent-skills/list-ext-skills.ts <mode>
// Paths printed are repo-root-relative. Exit: 0 ok, 1 not found, 2 usage.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BUN_APPS = join(REPO_ROOT, "bun-apps");

function extPackages(): string[] {
  return readdirSync(BUN_APPS)
    .filter((d) => d.startsWith("s2-agent-ext-"))
    .sort();
}

function skillFiles(): { pkg: string; skill: string; file: string }[] {
  const out: { pkg: string; skill: string; file: string }[] = [];
  for (const pkg of extPackages()) {
    const skillsRoot = join(BUN_APPS, pkg, "skills");
    if (!existsSync(skillsRoot)) continue;
    for (const skill of readdirSync(skillsRoot).sort()) {
      const file = join(skillsRoot, skill, "SKILL.md");
      if (existsSync(file)) out.push({ pkg, skill, file });
    }
  }
  return out;
}

// Frontmatter `description:` — plain, quoted, or YAML block (">"/"|") scalars.
function readDescription(file: string): string {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  if (!(lines[0] ?? "").startsWith("---")) return "";
  let value: string | null = null;
  let blockMode: ">" | "|" | null = null;
  const blockLines: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---") break;
    if (blockMode && (line.startsWith(" ") || line === "")) {
      blockLines.push(line.replace(/^[ \t]+/, "").replace(/^[>|]/, ""));
      continue;
    }
    if (blockMode) break;
    const m = line.match(/^description:\s*(.*)$/);
    if (!m) continue;
    const raw = m[1] ?? "";
    if (raw === ">" || raw === "|") {
      blockMode = raw as ">" | "|";
      continue;
    }
    value = raw;
    break;
  }
  if (blockMode) value = blockLines.join(" ");
  if (value == null) return "";
  value = value.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1).replace(/\\"/g, '"');
  } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

function modeSkills(): number {
  const entries = skillFiles()
    .map(({ pkg, skill, file }) => ({
      skill,
      pkg,
      desc: readDescription(file) || "<no description>",
    }))
    .sort((a, b) => a.skill.localeCompare(b.skill) || a.pkg.localeCompare(b.pkg));
  const wSkill = Math.max(10, ...entries.map((e) => e.skill.length)) + 2;
  const wPkg =
    Math.max(10, ...entries.map((e) => e.pkg.length)) + 2;
  for (const e of entries) {
    console.log(`${e.skill.padEnd(wSkill)}${e.pkg.padEnd(wPkg)}${e.desc}`);
  }
  return 0;
}

function modeCli(): number {
  const paths: string[] = [];
  for (const p of ["bun-apps/s2-agent/src/cli.ts"]) {
    if (existsSync(join(REPO_ROOT, p))) paths.push(p);
  }
  for (const pkg of extPackages()) {
    const src = join(BUN_APPS, pkg, "src");
    if (!existsSync(src)) continue;
    for (const f of readdirSync(src).sort()) {
      if (f.endsWith("-cli.ts")) paths.push(`bun-apps/${pkg}/src/${f}`);
    }
  }
  if (!paths.length) console.log("(none)");
  for (const p of paths) console.log(p);
  return 0;
}

function modeScripts(): number {
  let any = false;
  for (const pkg of extPackages()) {
    const dir = join(BUN_APPS, pkg, "scripts");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    any = true;
    console.log(`== bun-apps/${pkg}/scripts`);
    for (const f of readdirSync(dir).sort()) {
      if (f === "lib" || f.includes(".test.")) continue;
      console.log(`   ${f}`);
    }
  }
  if (!any) console.log("(none)");
  return 0;
}

function modeResolve(name: string): number {
  if (!name) return usage2();
  const hits = skillFiles().filter((s) => s.skill === name);
  if (!hits.length) {
    console.error(`(no ext skill named '${name}')`);
    return 1;
  }
  for (const h of hits) console.log(h.file);
  return 0;
}

function usage2(): number {
  console.error(
    "usage: list-ext-skills.ts [skills|cli|scripts|resolve <name>]",
  );
  return 2;
}

const mode = process.argv[2] ?? "skills";
switch (mode) {
  case "skills":
    process.exit(modeSkills());
  case "cli":
    process.exit(modeCli());
  case "scripts":
    process.exit(modeScripts());
  case "resolve":
    process.exit(modeResolve(process.argv[3] ?? ""));
  default:
    process.exit(usage2());
}
