/**
 * One-shot sweep: insert the canonical `publishKnowledge` helper (default-on)
 * + its Persist call into every learning workflow that has `extractKnowledge`
 * but not yet `publishKnowledge`. Idempotent — safe to re-run.
 *
 * This is a mechanical port of the _shared-patterns.md canonical helper. After
 * running, verify with `node scripts/check-workflow-patterns.mjs` (must stay
 * green) and `grep -l publishKnowledge .claude/workflows/*.js`.
 */
import { readFileSync, writeFileSync } from "node:fs";

const HELPER = `
// ── publishKnowledge — identical in every workflow; update _shared-patterns.md first ──
// Converges kbFile's records into the shared knowledge-graph vault via zk-ingest.
// Default-on (PI_PUBLISH_KNOWLEDGE=0 kills it); best-effort (never throws, never fails the run).
async function publishKnowledge(kbFile, workflowName) {
  if (process.env.PI_PUBLISH_KNOWLEDGE === "0") return { published: false, reason: "off" }
  const vault = process.env.PI_VAULT_PATH || \`\${PROJECT_ROOT}/vaults_root/pi-agent-vault\`
  const sourceLabel = \`workflow-jsonl:\${workflowName}\`
  const cli = await agent(
    \`Run the knowledge-graph ingest CLI. Capture stdout+stderr and report exit code.
1. Bash("test -f '\${PROJECT_ROOT}/dist/pi-agent-cli/cli.js' && echo DIST || echo SRC")
2. If DIST: Bash("OB_VAULT_PATH='\${vault}' node '\${PROJECT_ROOT}/dist/pi-agent-cli/cli.js' zk-ingest '\${kbFile}' --source-label '\${sourceLabel}' 2>&1 | tail -20")
   If SRC : Bash("OB_VAULT_PATH='\${vault}' bun --cwd '\${PROJECT_ROOT}/bun-apps/pi-agent-cli' src/cli.ts zk-ingest '\${kbFile}' --source-label '\${sourceLabel}' 2>&1 | tail -20")
3. Report { published: <true iff output contains "created" or "unchanged" or "updated" with no "Error">, summary: <the tail output> }.\`,
    { label: "publish-knowledge", phase: "Persist", model: "sonnet",
      schema: { type: "object", properties: {
        published: { type: "boolean" },
        summary: { type: "string" },
      }, required: ["published"] } },
  )
  if (cli?.published) log(\`Knowledge: published → \${vault} (zk-ingest)\`)
  else log(\`WARNING: knowledge publish skipped/failed — run continues. \${(cli?.summary || "").slice(0, 160)}\`)
  return cli
}
`;

const ANCHOR = "  return extract\n}";
const CALL = "await publishKnowledge(KB_FILE, meta.name)";

const files = [
  ".claude/workflows/gui-movie-director-review-optimize.js",
  ".claude/workflows/gui-movie-director-self-improve.js",
  ".claude/workflows/mlx-movie-director-review-optimize.js",
  ".claude/workflows/mlx-movie-director-run-self-improve-image.js",
  ".claude/workflows/mlx-movie-director-run-self-improve-ltx.js",
  ".claude/workflows/mlx-movie-director-self-improve.js",
];

let insertedHelper = 0;
let insertedCall = 0;

for (const f of files) {
  let src = readFileSync(f, "utf8");
  const hadHelper = /async function publishKnowledge\(/.test(src);

  // 1. Insert helper after the extractKnowledge helper's `return extract\n}`.
  if (!hadHelper) {
    const idx = src.indexOf(ANCHOR);
    if (idx === -1) {
      console.error(`✗ ${f}: anchor "${ANCHOR.trim()}" not found — SKIP`);
      continue;
    }
    // Insert once (indexOf finds the first/only occurrence).
    src = src.slice(0, idx + ANCHOR.length) + HELPER + src.slice(idx + ANCHOR.length);
    insertedHelper++;
  }

  // 2. Insert the call after each `await extractKnowledge(...)` statement.
  //    The call may span lines; find "await extractKnowledge(" then walk to the
  //    matching closing ")" + optional ";" + end-of-line, insert after.
  if (!src.includes(CALL)) {
    let from = 0;
    for (;;) {
      const start = src.indexOf("await extractKnowledge(", from);
      if (start === -1) break;
      // Walk to end of statement: balance parens, then consume trailing ";" + "\n".
      let i = start;
      let depth = 0;
      while (i < src.length) {
        const ch = src[i];
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) { i++; break; }
        }
        i++;
      }
      // consume optional ";" and the newline
      while (i < src.length && (src[i] === ";" || src[i] === " ")) i++;
      const eol = src.indexOf("\n", i);
      const insertAt = eol === -1 ? i : eol + 1;
      const indent = "  ";
      src =
        src.slice(0, insertAt) +
        `${indent}${CALL}\n` +
        src.slice(insertAt);
      insertedCall++;
      from = insertAt + CALL.length;
    }
  }

  writeFileSync(f, src, "utf8");
  console.log(`✓ ${f} (helper:${hadHelper ? "present" : "added"}, call:${hadHelper ? "present" : "added"})`);
}

console.log(`\nDone: ${insertedHelper} helper(s) inserted, ${insertedCall} call(s) inserted.`);
