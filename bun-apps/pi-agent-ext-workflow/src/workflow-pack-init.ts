/**
 * workflow-pack-init.ts — `workflow pack init <name>` scaffolder (decision 07).
 *
 * Copies the shipped template's static files (manifest.json, entry.js, README.md,
 * .gitignore) + the `agents/` dir, and creates empty ephemeral state dirs
 * (`inputs/ outputs/ intermediate/ runs/`) each with a `.gitkeep`. Targets
 * `<cwd>/.pi/workflows/<name>` by default; refuses a package dir (checked-in packs
 * are authored manually). Pure over node:fs.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATIC = ["manifest.json", "entry.js", "README.md", ".gitignore"];
const EPHEMERAL = ["inputs", "outputs", "intermediate", "runs"];

export function scaffoldPack(args: { name: string; targetDir: string; templateRoot: string }): { dir: string } {
  mkdirSync(args.targetDir, { recursive: true });
  for (const f of STATIC) {
    const src = join(args.templateRoot, f);
    if (existsSync(src)) copyFileSync(src, join(args.targetDir, f));
  }
  // agents/ dir copied wholesale (so bundled roles ship with the pack).
  const agentsSrc = join(args.templateRoot, "agents");
  const agentsDst = join(args.targetDir, "agents");
  mkdirSync(agentsDst, { recursive: true });
  if (existsSync(agentsSrc)) {
    for (const f of readdirSync(agentsSrc)) copyFileSync(join(agentsSrc, f), join(agentsDst, f));
  }
  for (const d of EPHEMERAL) {
    mkdirSync(join(args.targetDir, d), { recursive: true });
    writeFileSync(join(args.targetDir, d, ".gitkeep"), "");
  }
  return { dir: args.targetDir };
}
