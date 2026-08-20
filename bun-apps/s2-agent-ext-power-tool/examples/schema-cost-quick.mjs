#!/usr/bin/env bun
/**
 * examples/quick.mjs — one-command runnable example.
 *
 *   bun run examples/quick.mjs
 *
 * Measures the schema-token cost of a small static tool set (no s2-agent
 * required) and prints the ranked report. This is the whole value prop in
 * ~15 lines: the #1 demand bucket, measurable anywhere.
 */
import { analyzeTools, formatReport, estimateToolCost } from "../src/schema-cost/index.ts";

// A tiny tool set — imagine these are your agent's registered tools.
const tools = [
	{
		name: "read",
		description: "Read the contents of a file. Supports text files and images.",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
	{
		name: "search_web",
		description:
			"Search the web. Returns an AI-synthesized answer with source citations. " +
			"Supports multiple providers and recency filters. Pass queries:[...] for research.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string" },
				queries: { type: "array", items: { type: "string" } },
				provider: { type: "string", enum: ["auto", "openai", "brave", "tavily"] },
			},
			required: ["query"],
		},
	},
	{
		name: "beep",
		description: "Beep.",
		parameters: { type: "object" },
	},
];

const report = analyzeTools(tools, "example");
console.log(formatReport(report).join("\n"));
console.log(`\nmost expensive tool: ${report.tools[0].name} = ${report.tools[0].approxTokens} tok`);

// Single-tool estimate + a custom ratio (reproduce the live inspect_context's 3.7)
const one = estimateToolCost(tools[1], "example", { charsPerToken: 3.7 });
const swAt4 = report.tools.find((t) => t.name === "search_web").approxTokens;
console.log(`search_web @3.7 ratio: ${one.approxTokens} tok (vs ${swAt4} @4.0)`);
