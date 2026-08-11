// memory-to-vault-script.ts — generates the workflow-engine script that fans
// out one obsidian-distill agent per memory file. Pure: same opts → same string.
//
// Per the GATE-0 resolution (findings.md § GATE-0.8a): the workflow agents do NOT
// inherit the CLI's baked extensions, so they can't see `zk_extract` (removed
// anyway) or `obsidian`. The orchestrator (Phase 4) injects the obsidian tool into
// each agent via `WorkflowAgent({extensionTools})` (a capture harness over the
// obsidian factory). This script only emits the engine text that tells each agent
// to CALL the `obsidian` tool with action `distill` on its assigned file.
export interface WorkflowScriptOptions {
	files: string[];
	folder: string;
	/** Optional per-file note cap (cost control). Omit to leave unset. */
	maxNotes?: number;
}

export function generateWorkflowScript(opts: WorkflowScriptOptions): string {
	const FILES = opts.files;
	const FOLDER = opts.folder;
	const noteClause = opts.maxNotes !== undefined
		? `Limit to approximately ${opts.maxNotes} notes (pass max_notes if the schema has it). `
		: "";
	// FILES embedded once; each agent gets its own path via the .map().
	return `export const meta = {
  name: 'memory_to_vault',
  description: 'Distill pi memory files into Zettelkasten (1 obsidian-distill per file)',
  phases: [{ title: 'Distill' }, { title: 'Report' }],
}

const FILES = ${JSON.stringify(FILES)}
const FOLDER = ${JSON.stringify(FOLDER)}

phase('Distill')
const results = await parallel(FILES.map((f) =>
  () => agent(
    "You have an obsidian tool. Use it with action 'distill' to decompose the single file " +
      JSON.stringify(f) + " into atomic Zettelkasten notes in folder " + JSON.stringify(FOLDER) + ". " +
      "${noteClause}" +
      "Inspect the obsidian tool's input schema for the exact parameter names (e.g. files, folder), then call it exactly once. " +
      "CRITICAL: actually invoke the tool, do not merely describe it. " +
      "After it returns, report how many notes were created.",
    { tier: 'medium', retries: 2, label: f },
  ),
))

phase('Report')
return { files: FILES.length, results }
`;
}
