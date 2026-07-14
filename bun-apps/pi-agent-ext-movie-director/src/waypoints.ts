/**
 * waypoints.ts — the scoped LLM producers for the driver's creative stages.
 *
 * Two executors share one bounded retry loop (`produceAndValidate`):
 *   • runCompletionWaypoint — a single in-process completion (proposal / script
 *     / scene_plan / edit): JSON-out vs the artifact schema, ajv errors fed back.
 *   • runAgentWaypoint — a bounded pi sub-session with a scoped toolset (research
 *     gets {web_search, fetch_content} so its brief is grounded in real URLs).
 *
 * Both are pure of pi/provider coupling: `completionFn` / `agentFn` / `validateFn`
 * are injected, so this module is unit-testable with fakes. Phase 3 wires the
 * real provider call, the bounded-agent runner (reusing commands.ts), and the
 * existing `dispatch("validate-artifact")`.
 */
import { cleanToSchema } from "./clean-to-schema.ts";

/** The artifact-schema name each creative stage produces. */
const SCHEMA_FOR: Record<string, string> = {
	research: "research_brief",
	proposal: "proposal_packet",
	script: "script",
	scene_plan: "scene_plan",
	edit: "edit_decisions",
};

/** Toolset granted to the research agent (the only tool-bearing waypoint). */
export const RESEARCH_TOOLSET = ["web_search", "fetch_content"];

export interface WaypointDeps {
	completionFn: (system: string, user: string, model?: string) => Promise<string>;
	agentFn: (system: string, user: string, opts: { model?: string; toolset: string[] }) => Promise<string>;
	validateFn?: (artifact: string, data: unknown) => Promise<{ valid: boolean; errors?: string }>;
	/** Concise required-structure spec for an artifact (loaded from the bundled schema). */
	schemaSpec?: (artifact: string) => string | undefined;
	/** Parsed bundled schema for an artifact → drives the clean-to-schema safety net
	 * (strip unknowns + light coercion) before validation. Omit to skip cleaning. */
	schemaFor?: (artifact: string) => Record<string, unknown> | undefined;
}

/** Thrown when a waypoint cannot produce a schema-valid artifact within its bound. */
export class WaypointExhaustedError extends Error {}

/** Map a pipeline stage to its producer kind. */
export function pickProducer(stage: string): "agent" | "completion" | "mechanical" {
	if (stage === "research") return "agent";
	if (stage === "proposal" || stage === "script" || stage === "scene_plan" || stage === "edit") return "completion";
	return "mechanical"; // assets / compose / publish — driven by dispatch(), not a waypoint
}

function schemaNameFor(stage: string): string {
	return SCHEMA_FOR[stage] ?? stage;
}

/** Build the {system, user} prompt for a stage; `feedback` carries prior errors on retries. */
function buildPrompt(
	stage: string,
	inputs: Record<string, unknown>,
	opts: { feedback?: string; schemaSpec?: string } = {},
): { system: string; user: string } {
	const schema = schemaNameFor(stage);
	const system =
		`You are the ${stage} director (skill: pipelines/explainer/${stage}-director). ` +
		`Produce a schema-valid "${schema}" artifact as RAW JSON only — no prose, no markdown fences.` +
		(opts.schemaSpec ? `
The "${schema}" artifact must include at least: ${opts.schemaSpec}` : "");
	const user =
		`Stage: ${stage}\nTarget artifact: ${schema}\n` +
		`Inputs:\n${JSON.stringify(inputs, null, 2)}\n` +
		(opts.feedback ? `\n${opts.feedback}\n` : "") +
		`Return the ${schema} JSON object now.`;
	return { system, user };
}

/**
 * Core bounded-retry loop shared by both waypoint types: call `produceFn`,
 * parse JSON, validate, and on failure feed the errors back and retry up to
 * `maxRetries` times. Throws WaypointExhaustedError if the bound is hit.
 */
async function produceAndValidate(
	produceFn: (system: string, user: string) => Promise<string>,
	deps: WaypointDeps,
	stage: string,
	inputs: Record<string, unknown>,
	maxRetries: number,
): Promise<Record<string, unknown>> {
	const validate = deps.validateFn ?? (async () => ({ valid: true }));
	let feedback: string | undefined;
	const name = schemaNameFor(stage);
	const spec = deps.schemaSpec?.(name);
	const schemaObj = deps.schemaFor?.(name);
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		const { system, user } = buildPrompt(stage, inputs, { feedback, schemaSpec: spec });
		const raw = await produceFn(system, user);
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			feedback = "Previous output was not valid JSON. Return ONLY a JSON object.";
			continue;
		}
		// Safety net: deterministically shape the parsed output to the schema
		// (strip unknowns where additionalProperties:false + light coercion)
		// BEFORE validation, so stray fields the model can't see don't waste a
		// retry. No-op when schemaFor is absent (the parsed object is untouched).
		if (schemaObj) parsed = cleanToSchema(schemaObj, parsed);
		const res = await validate(name, parsed);
		if (res.valid) return parsed as Record<string, unknown>;
		feedback = `Previous attempt failed validation: ${res.errors ?? "invalid"}. Fix these errors and return valid JSON.`;	}
	throw new WaypointExhaustedError(`${stage} waypoint exhausted ${maxRetries} retries`);
}

/** Single in-process completion → one schema-valid artifact (proposal/script/scene_plan/edit). */
export async function runCompletionWaypoint(
	stage: string,
	inputs: Record<string, unknown>,
	deps: WaypointDeps,
	maxRetries = 3,
): Promise<Record<string, unknown>> {
	return produceAndValidate((system, user) => deps.completionFn(system, user), deps, stage, inputs, maxRetries);
}

/** Bounded pi sub-session with a scoped toolset → one schema-valid artifact (research). */
export async function runAgentWaypoint(
	stage: string,
	inputs: Record<string, unknown>,
	deps: WaypointDeps,
	maxRetries = 2,
): Promise<Record<string, unknown>> {
	const toolset = stage === "research" ? RESEARCH_TOOLSET : [];
	return produceAndValidate(
		(system, user) => deps.agentFn(system, user, { toolset }),
		deps,
		stage,
		inputs,
		maxRetries,
	);
}
