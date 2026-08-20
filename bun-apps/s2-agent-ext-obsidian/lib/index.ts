/**
 * lib/index.ts — public library barrel for pi-obsidian.
 *
 * External scripts (bun) import from here to access the vault index, graph
 * export formats, and report generation without starting the pi runtime.
 *
 *   import { getIndex, toMermaid, summarizeVault, renderReportMD } from "@repo/s2-agent-ext-obsidian/lib";
 */
export { toGraphJSON, toDOT, toMermaid } from "./graphExport.ts";
export type { GraphNode, GraphEdge, GraphJSON } from "./graphExport.ts";

export { summarizeVault, renderReportMD } from "./vaultReport.ts";
export type { VaultStats, TagCluster, TopicCluster, VaultReport } from "./vaultReport.ts";

// Index + graph queries (re-exported from the extension module).
export {
	getIndex,
	buildIndex,
	dropIndex,
	resolveWikiLink,
	backlinkPaths,
	tagPaths,
	graphOutgoing,
	graphOrphans,
	graphDeadLinks,
	graphNeighbors,
	detectTitleStyleOutliers,
} from "../extensions/obsidian.ts";
export type { VaultIndex, NoteMeta, GraphResult } from "../extensions/obsidian.ts";
