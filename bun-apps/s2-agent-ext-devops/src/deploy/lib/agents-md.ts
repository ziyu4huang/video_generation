/**
 * agents-md.ts — the dist's agent-facing usage guide (ext-standalone-import t03).
 *
 * <outRoot>/AGENTS.md is the entry point for any AGENT (or human script
 * author) that discovers a deploy without our repo: it documents the
 * standalone-import mechanism — driving the shipped ext tools via
 * ext/ext-standalone.mjs — with a quickstart whose code is EXACTLY what the
 * deploy-e2e `standalone-import` probe executes. Doc and proof share one
 * source string here (STANDALONE_QUICKSTART), so they cannot diverge.
 *
 * Version-agnostic by contract: the doc references the `current` symlink and
 * never pins a version. Written at the OUTROOT (beside the platform dirs), so
 * one copy serves every platform target and survives version rotation;
 * refresh is idempotent — rewritten only when the content actually changed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The canonical standalone consumer. AGENTS.md embeds this verbatim; the
 * deploy-e2e `standalone-import` probe writes this verbatim to a scratch dir
 * and runs it — one source of truth (ticket t03 acceptance).
 *
 * Runs under bun (the deploy ships one at <platform>/<version>/bin/bun):
 *   cd <a-git-repo> && bun standalone-quickstart.js <shim.mjs>
 */
export const STANDALONE_QUICKSTART = `// standalone-quickstart.js — reuse a deployed s2-agent-sh extension's tools.
// Usage (from inside a git repo): bun standalone-quickstart.js <path-to-ext-standalone.mjs>
const shimPath = process.argv[2];
if (!shimPath) throw new Error("pass the shim path: bun standalone-quickstart.js <dist>/ext/ext-standalone.mjs");
const { loadExt, listExts } = require(shimPath);

const exts = listExts().map((e) => e.name).join(", ");
const devops = loadExt("devops");
const tools = devops.tools().map((t) => t.name).join(", ");

// A read-only real tool call: the devops sync plan for THIS repo, dry-run.
const r = await devops.tool("sync_default_branch").execute("standalone", { mode: "full", dryRun: true });
const details = r.details ?? {};
console.log(JSON.stringify({
	exts,
	devopsTools: tools,
	sync: { ok: !details.aborted, mode: details.mode, commands: (details.commands ?? []).length },
}, null, 2));
`;

/** The full AGENTS.md content. `<PLATFORM>` is a placeholder the reader resolves. */
export const AGENTS_MD = `# AGENTS.md — s2-agent-sh deploy: reuse the shipped extension tools

This directory is a versioned **s2-agent-sh** deploy. Two things live here:

- **The agent itself** — \`<platform>/current/s2-agent.sh\` boots s2-agent with
  every extension under \`<platform>/current/ext/\` loaded (\`<platform>\` is a
  directory next to this file, e.g. \`darwin-arm64\`; \`current\` is a symlink to
  the newest version).
- **A standalone tool shim** — \`<platform>/current/ext/ext-standalone.mjs\`.
  Any bun script can import it and drive the SAME deployed extension tools
  the agent uses — no repo checkout, no \`bun install\`, no rebuild, no network.

## Quickstart (verified by every deploy's E2E probe)

\`\`\`bash
# 1. Save this as standalone-quickstart.js (it is exactly what the deploy's
#    standalone-import E2E probe executes):
${STANDALONE_QUICKSTART}
# 2. Run it from any git repo, with any bun (the deploy ships one at
#    <platform>/current/bin/bun if the host has none):
bun standalone-quickstart.js <platform>/current/ext/ext-standalone.mjs
\`\`\`

Expected shape: \`{ exts: "archify, btw, …", devopsTools: "deploy, …",
sync: { ok: true, mode: "full", commands: N } }\`.

## The API (ext-standalone.mjs)

\`\`\`js
const { loadExt, listExts } = require("<platform>/current/ext/ext-standalone.mjs");

listExts();                       // [{ name, manifest }] — every shipped extension
const ext = loadExt("devops");    // evaluates ext/devops/ext.cjs, registers tools
ext.tools();                      // [{ name, execute }] — registered tools
ext.manifest;                     // the ext.json (hostModules, skills, …)
const result = await ext.tool("sync_default_branch")
    .execute("my-script-id", { mode: "full", dryRun: true });
result.details;                   // structured outcome (JSON-shaped)
result.content;                   // human-readable text render
\`\`\`

- Tool parameters match the tool's schema (the same one the agent's LLM sees);
  \`execute(sessionId, params)\` returns the tool's real outcome.
- Errors throw with the extension/tool name and reason — scripts fail loud.
- \`loadExt(name, { distRoot })\` targets a specific version dir instead of
  \`current\`.

## Which tools work standalone

- **Standalone-safe**: git/spawn/file tools — the devops family
  (\`sync_default_branch\`, \`sweep_merged_branches\`, \`run_devops_retrospect\`,
  …), file2md's OCR path. They act on the CONSUMING process's cwd.
- **Environment-dependent**: model-backed tools need the usual provider env
  (LM Studio / API keys); tools that need a live agent session or UI are not
  available at this layer — the shim executes ONE tool headlessly, it is not
  an agent runtime.

## Notes

- Offline by construction: the shim inlines its dependencies; the deploy's
  gates guarantee no build-machine paths and no unresolved imports.
- Provenance: \`<platform>/<version>/deploy.json\` records version, sourceSha,
  gates, and the shim's bytes + cache provenance.
- Do not hand-edit anything inside a version dir — deploys are frozen
  (\`dr-xr-xr-x\`); a new deploy rotates \`current\`.
`;

export interface WriteAgentsMdResult {
	/** True when the file was (re)written; false when identical content existed. */
	written: boolean;
	bytes: number;
}

/** Idempotently place AGENTS.md at the outRoot. */
export function writeAgentsMd(outRoot: string): WriteAgentsMdResult {
	const path = join(outRoot, "AGENTS.md");
	const content = `${AGENTS_MD}`;
	if (existsSync(path) && readFileSync(path, "utf8") === content) {
		return { written: false, bytes: content.length };
	}
	writeFileSync(path, content);
	return { written: true, bytes: content.length };
}
