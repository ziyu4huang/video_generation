/**
 * pi-agent-ext-distill — agent self-triggered knowledge distillation pipeline.
 *
 * Registers one tool (`distill`) with 3 actions: status / gate / converge.
 * The gate is deterministic (dedup/stale/malformed); enrichment happens
 * in the agent's LLM context between gate and converge; converge reuses
 * knowledge-card's ingestRecords for canonical-id dedup into the graph.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runGate } from "../src/gate.ts";
import { runConverge } from "../src/converge.ts";
import { readState } from "../src/state.ts";

export default function distillExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "distill",
		label: "Distill",
		description:
			"Distill raw hermes-memory entries into curated vault notes and the knowledge-card graph. " +
			"Agent self-triggered when memory bloat exceeds the adaptive threshold. " +
			"Actions: 'status' (report bloat + current threshold), 'gate' (rule-based filter — " +
			"dedup/stale/malformed; returns survivors for in-context enrichment), 'converge' " +
			"(write enriched notes to vault + graph; auto-adjusts threshold). " +
			"Workflow: status then gate then enrich survivors then converge.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("status"),
				Type.Literal("gate"),
				Type.Literal("converge"),
			]),
			vaultPath: Type.String({ description: "Absolute path to the Obsidian vault root" }),
			entries: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						target: Type.String(),
						content: Type.String(),
						created: Type.String(),
						last: Type.Optional(Type.String()),
					}),
					{ description: "Memory entries to gate (required for action='gate')" },
				),
			),
			notes: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						type: Type.String(),
						title: Type.String(),
						detail: Type.String(),
						tags: Type.Array(Type.String()),
						dimension: Type.Optional(Type.String()),
						confidence: Type.Optional(Type.Number()),
					}),
					{ description: "Enriched notes to converge (required for action='converge')" },
				),
			),
			metrics: Type.Optional(
				Type.Object(
					{
						candidates: Type.Number(),
						killed: Type.Number(),
						survivors: Type.Number(),
					},
					{ description: "Gate metrics (required for action='converge')" },
				),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const ok = (data: unknown) => ({
				content: [{ type: "text" as const, text: JSON.stringify(data) }],
				isError: false,
				details: null,
			});
			const err = (msg: string) => ({
				content: [{ type: "text" as const, text: msg }],
				isError: true,
				details: null,
			});

			const action = params.action as string;
			const vaultPath = params.vaultPath as string;

			if (action === "status") {
				const state = readState(vaultPath);
				return ok({
					threshold: state.threshold,
					lastRun: state.lastRun,
					historyEntries: state.history.length,
					recentRuns: state.history.slice(-3),
				});
			}

			if (action === "gate") {
				const entries = (params.entries ?? []) as any[];
				const result = runGate(entries, vaultPath);
				return ok({
					candidates: result.candidates,
					killed: result.killed.length,
					survivors: result.survivors.map((s) => ({
						id: s.entry.id,
						content: s.entry.content,
						target: s.entry.target,
						reason: s.reason,
					})),
					killReasons: result.killed.reduce(
						(acc: Record<string, number>, k) => {
							acc[k.reason] = (acc[k.reason] ?? 0) + 1;
							return acc;
						},
						{},
					),
				});
			}

			if (action === "converge") {
				const notes = (params.notes ?? []) as any[];
				const metrics = (params.metrics ?? { candidates: 0, killed: 0, survivors: 0 }) as any;
				return ok(await runConverge(notes, vaultPath, metrics));
			}

			return err(`Unknown action: ${action}`);
		},
	});

	// Lifecycle hook: nudge agent on session start. Lightweight signal only —
	// full bloat detection is deferred to the agent calling action='status'
	// (keeps this extension decoupled from hermes-memory's store).
	pi.events?.on?.("session:start", () => {
		// Intentionally empty: the agent reads state via action='status'.
	});
}
