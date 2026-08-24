/**
 * `zk-extract <inputs...>` — convert markdown/text files into Zettelkasten
 * atomic notes in an Obsidian vault.
 *
 * Workflow:
 *   1. Resolve input files (expand folders to *.md / *.txt, dedupe, validate).
 *   2. Resolve the target vault (OB_VAULT_PATH / --vault / --vault-dir / cwd/vault)
 *      and ensure it exists.
 *   3. Drive a parent agent session (pi-obsidian baked in) whose task instructs
 *      it to call `obsidian` with action:"distill" and the resolved inputs.
 *
 * The actual decomposition into atomic notes is performed by that action,
 * which spawns an isolated subagent — that subagent re-invokes THIS binary with
 * pi-compatible flags (handled by the passthrough runner).
 *
 * Flags (pi-aligned globals apply too):
 *   <inputs...>            files and/or folders (relative to cwd or absolute)
 *   --folder <name>        Zettelkasten target folder (default: Zettelkasten)
 *   --max-notes <n>        hint: cap notes produced
 *   --vault <path>         absolute vault path
 *   --vault-dir <name>     vault folder name under cwd (default: vault)
 *   --model / --provider / --thinking / --tools / -p / --mode ...
 */
import { existsSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type { ParsedArgs } from "../args.ts";
import { resolveVaultPath, applyResolvedVaultEnv } from "../vault-paths.ts";
import { walkFiles } from "../walk.ts";
import { runAgentSession } from "../sessions/run-agent-session.ts";
import {
	buildDistillTask,
	DISTILL_TOOLS,
} from "@repo/s2-agent-ext-knowledge-card/extensions/knowledge-card.ts";

const MD_TXT_RE = /\.(md|markdown|txt|text)$/i;

/** Recursively expand a path into individual .md/.txt files. */
function expandInput(p: string, cwd: string): string[] {
	const abs = isAbsolute(p) ? p : resolve(cwd, p);
	if (!existsSync(abs)) {
		throw new Error(`Input not found: ${p} (resolved: ${abs})`);
	}
	const st = statSync(abs);
	if (st.isFile()) return [abs];
	if (st.isDirectory()) {
		const out: string[] = [];
		walkFiles(abs, (full, entry) => {
			if (MD_TXT_RE.test(entry)) out.push(full);
		});
		return out;
	}
	return [];
}

/** Resolve + validate inputs, returning absolute, deduped file paths. */
export function resolveInputs(inputs: string[], cwd: string): string[] {
	if (inputs.length === 0) {
		throw new Error(
			"No input files given. Usage: zk-extract <files.../folders...>",
		);
	}
	const all: string[] = [];
	for (const inp of inputs) all.push(...expandInput(inp, cwd));
	const dedup = [...new Set(all)];
	if (dedup.length === 0) {
		throw new Error("No markdown/text files found in the given inputs.");
	}
	return dedup.sort();
}

/**
 * Resolve the vault directory and ensure it exists.
 * Order: --vault (OB_VAULT_PATH) > <cwd>/<--vault-dir|vault> > OB_VAULT_PATH env.
 * Shared implementation in vault-paths.ts (same body lived here, zk-ingest,
 * and zk-query until T1 of the 2026-08-22 simplification).
 */
export const resolveVault = resolveVaultPath;

export const zkExtractCommand = {
	name: "zk-extract",
	summary: "decompose markdown/text files into Zettelkasten atomic notes",
	details: `Usage:
  s2-agent cli zk-extract <files.../folders...> [options]

Inputs:
  One or more files or folders. Folders are scanned recursively for
  *.md / *.markdown / *.txt / *.text.

Options (pi-aligned globals also apply):
  --folder <name>        Zettelkasten target folder (default: Zettelkasten)
  --max-notes <n>        hint: cap the number of notes produced
  --vault <path>         absolute path to the vault (sets OB_VAULT_PATH)
  --vault-dir <name>     vault folder name under cwd (default: vault)
  --model <pattern>      provider/id[:thinking]  (e.g. sonnet, bonsai-27b)
  --provider <name>      provider name
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --mode json            NDJSON event stream (for programmatic consumers)
  -p, --print            non-interactive one-shot

Examples:
  s2-agent cli zk-extract notes.md
  s2-agent cli zk-extract ./inbox/ --folder Zettelkasten --max-notes 20
  s2-agent cli zk-extract a.md b.md --model anthropic/claude-sonnet-4:high
  s2-agent cli zk-extract ./docs --vault /path/to/my-vault`,
	async run(parsed: ParsedArgs): Promise<void> {
		const cwd = process.cwd();
		const inputs = parsed.positionals;
		const files = resolveInputs(inputs, cwd);

		const folder = parsed.folder ?? "Zettelkasten";
		const vaultPath = resolveVault(parsed, cwd);
		// Obsidian env, set once each. The vault-dir forwarding exists because
		// applyVaultEnv's RAW OB_VAULT_PATH write was immediately overwritten by
		// the resolved path — only its vault-dir half survives here.
		applyResolvedVaultEnv(parsed, vaultPath, { vaultDir: true });

		console.error(`vault:  ${vaultPath}`);
		console.error(`folder: ${folder}`);
		console.error(`inputs: ${files.length} file(s)`);
		for (const f of files.slice(0, 12))
			console.error(`  - ${relative(cwd, f) || f}`);
		if (files.length > 12) console.error(`  … (+${files.length - 12} more)`);
		console.error();

		const task = buildDistillTask(files, cwd, folder, parsed.maxNotes);

		// Parent agent needs the `obsidian` facade (for action:"distill") plus the
		// supporting read tools.
		// DISTILL_TOOLS is the single source of truth shared with the zk_extract
		// extension tool (see bun-apps/pi-knowledge-card).
		await runAgentSession(parsed, {
			tools: parsed.tools ?? DISTILL_TOOLS,
			task,
			labelName: "zk-extract",
		});
	},
};
