/**
 * s2-agent-ext-sv-analyzer — Verilog/SystemVerilog analyzer for s2-agent.
 *
 * Registers the SAME two model tools as the dsh-sv-analyzer DSH plugin
 * (dsh-plugin/sv-analyzer/), backed by the same self-contained tree-sitter
 * WASM (wasm32-wasip1):
 *
 *   sv_analyze — parse and summarize: modules/interfaces/programs/packages,
 *                ports, parameters, instances, signals, always blocks,
 *                continuous assigns, and syntax issues.
 *   sv_ast     — dump the raw tree-sitter parse tree as JSON.
 *
 * The Rust core in dsh-plugin/sv-analyzer/rust is the single source of truth;
 * dsh-plugin/sv-analyzer/build.sh mirrors the built wasm into this package's
 * wasm/ dir (gitignored — a regenerated artifact, same policy as the plugin's
 * own plugin/wasm/), so both hosts ship the same binary; a fresh clone runs
 * build.sh first to mirror it before deploy/test.
 *
 * Self-gate: BUN_PI_SV_ANALYZER=0 disables the entire extension — it registers
 * nothing. Mirrors the other base-set extensions' full-disable knob and is
 * enforced by tests/extension-isolation-contract.test.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAnalyzerService, renderJson, type SvAnalyzerToolContext } from "../src/analyzer.ts";

const DIALECT = Type.Union(
	[
		Type.Literal("auto"),
		Type.Literal("systemverilog"),
		Type.Literal("verilog"),
	],
	{
		description:
			'Grammar to use. "auto" (default) parses with SystemVerilog (IEEE 1800-2023); when that parse has errors it also tries the classic Verilog grammar and keeps the cleaner parse.',
	},
);

export default function (pi: ExtensionAPI): void {
	if (process.env.BUN_PI_SV_ANALYZER === "0") return;

	// Lazy by construction: the wasm is compiled on the FIRST tool call, so
	// registering the tools is IO-free (the isolation contract's STANDALONE
	// LOAD requirement).
	const service = createAnalyzerService();

	pi.registerTool({
		name: "sv_analyze",
		label: "Analyze Verilog/SystemVerilog (design summary)",
		promptSnippet:
			"Parse + summarize Verilog/SystemVerilog source: design units, ports, parameters, instances, always blocks, assigns, syntax issues",
		description:
			"Analyze Verilog/SystemVerilog source with a tree-sitter parser compiled to WASM. " +
			"Returns parsed design units (modules/interfaces/programs/packages) with ports, " +
			"parameters, module instances, signal declarations, always blocks and continuous " +
			"assigns, plus syntax issues with positions. Provide the source inline via `code` " +
			"or a file path via `file` (.v/.sv/.vh/.svh, resolved against the session cwd); " +
			"choose the grammar with `dialect`.",
		parameters: Type.Object({
			code: Type.Optional(
				Type.String({
					description:
						"Verilog/SystemVerilog source text to analyze. Required unless `file` is provided.",
				}),
			),
			file: Type.Optional(
				Type.String({
					description:
						"Path (relative to the session cwd, or absolute) of a .v/.sv/.vh/.svh file to read and analyze instead of inline `code`.",
				}),
			),
			dialect: Type.Optional(DIALECT),
			include_ast: Type.Optional(
				Type.Boolean({
					description:
						"Include the full tree-sitter parse tree in the result (can be large and may be truncated — see ast_truncated; prefer the sv_ast tool for trees).",
				}),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const data = await service.runAnalyzer(
				"analyze",
				params,
				ctx as SvAnalyzerToolContext | undefined,
				signal,
				{ include_ast: params.include_ast === true },
			);
			return {
				content: [{ type: "text", text: renderJson(data) }],
				details: data,
			};
		},
	});

	pi.registerTool({
		name: "sv_ast",
		label: "Dump the raw tree-sitter parse tree (JSON)",
		promptSnippet:
			"Dump the raw tree-sitter parse tree (node type, field, byte range, error/missing flags, children) for Verilog/SystemVerilog",
		description:
			"Dump the raw tree-sitter parse tree (JSON: node type, field, byte range, error/missing " +
			"flags, children) for Verilog/SystemVerilog source — large trees are truncated with an " +
			"ast_truncated flag. Provide source inline via `code` or a file via `file` (.v/.sv/.vh/.svh, " +
			"resolved against the session cwd); pick the grammar with `dialect`. Use sv_analyze for a " +
			"summarized design view.",
		parameters: Type.Object({
			code: Type.Optional(
				Type.String({
					description: "Verilog/SystemVerilog source text. Required unless `file` is provided.",
				}),
			),
			file: Type.Optional(
				Type.String({
					description: "Path (relative to the session cwd, or absolute) of a .v/.sv/.vh/.svh file to read and parse.",
				}),
			),
			dialect: Type.Optional(DIALECT),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const data = await service.runAnalyzer(
				"ast",
				params,
				ctx as SvAnalyzerToolContext | undefined,
				signal,
			);
			return {
				content: [{ type: "text", text: renderJson(data) }],
				details: data,
			};
		},
	});
}
