/**
 * waypoint-runtime.ts — the REAL producer backing for the run-pipeline driver.
 *
 * Builds the WaypointDeps that the dispatch `run-pipeline` case uses in
 * production: completionFn / agentFn are bounded pi sub-sessions (a toolless
 * one for proposal/script/scene_plan/edit; one with {web_search, fetch_content}
 * for research). validateFn delegates to dispatch("validate-artifact").
 *
 * The session spawn + NDJSON capture here is environment-coupled (like the
 * existing MLX smoke tests) and is validated end-to-end in Phase 6, not by a
 * unit test — the dispatch case's WIRING is unit-tested via injected waypointDeps.
 *
 * Path resolution is inlined (not imported from commands.ts) to avoid a
 * dispatch → waypoint-runtime → commands → dispatch import cycle.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { WaypointDeps } from "./waypoints.ts";

/** Path to a bundled artifact schema (data/schemas/artifacts/<name>.schema.json). */
function schemaPath(artifact: string): string {
	return join(import.meta.dir, "..", "data", "schemas", "artifacts", `${artifact}.schema.json`);
}

const schemaSpecCache = new Map<string, string | undefined>();
const schemaObjectCache = new Map<string, Record<string, unknown> | undefined>();
/** The parsed bundled JSON schema for an artifact (for clean-to-schema). Cached. */
function readSchemaObject(artifact: string): Record<string, unknown> | undefined {
	if (schemaObjectCache.has(artifact)) return schemaObjectCache.get(artifact);
	const path = schemaPath(artifact);
	let obj: Record<string, unknown> | undefined;
	if (existsSync(path)) {
		try {
			obj = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		} catch {
			obj = undefined;
		}
	}
	schemaObjectCache.set(artifact, obj);
	return obj;
}
/** A minimal JSON-schema property shape, as read from the bundled artifact schemas. */
interface FieldSchema {
	type?: string;
	enum?: unknown[];
	const?: unknown;
	minItems?: number;
	properties?: Record<string, FieldSchema>;
	required?: string[];
	items?: FieldSchema;
}

/**
 * Order an object's properties for display: ALL required fields first (in their
 * original schema order), then optional fields capped at `optionalCap`. Required
 * fields are never dropped — a real run showed a naive `.slice(0, 12)` over raw
 * declaration order silently truncating proposal_packet's concept_options item
 * (15 properties) right before its required `why_this_works`, purely because of
 * where that field happened to sit in the schema, with no signal to the model
 * that it was ever asked for.
 */
function orderedEntries(properties: Record<string, FieldSchema>, required: Set<string>, optionalCap = 12): [string, FieldSchema][] {
	const entries = Object.entries(properties);
	const requiredEntries = entries.filter(([k]) => required.has(k));
	const optionalEntries = entries.filter(([k]) => !required.has(k)).slice(0, optionalCap);
	return [...requiredEntries, ...optionalEntries];
}

/**
 * Describe one field for the prompt spec: `name`, `name*` if required within its
 * parent object, `name=one of a|b|c` for an enum, `name=array of {sub, fields}`
 * for an array of objects (recursing into the item's OWN required sub-fields, up
 * to `depth` levels), `name=array of <primitive>` for an array of scalars, or
 * `name (object: sub, fields)` for a plain nested object. `name (type)` for a
 * bare scalar (so the model knows e.g. a budget field must be a number, not text).
 *
 * Recursion (not just one level) matters: research_brief's `landscape.existing_content`
 * is object → array → item, three levels deep. A real run showed the model
 * omitting `existing_content[].{source,angle,what_it_covers}` identically across
 * every retry, because only "existing_content" (the array's own name) was ever
 * visible in the spec — the item's required sub-fields were never surfaced.
 * A separate real run needed FOUR levels (proposal_packet's production_plan ->
 * stages -> tools -> {tool_name,role,available}) — one deeper than the default
 * budget reached, so `tools` surfaced as a bare "array of object" and the model
 * omitted its required sub-fields on every attempt. `depth` still caps runaway
 * prompt length on deeply/self-nested schemas elsewhere; bundled schemas measured
 * up to 6 levels, but only required chains need full depth, so the cap is set
 * generously (6) rather than tuned to one observed case.
 */
function describeField(name: string, field: FieldSchema | undefined, required: boolean, depth = 6): string {
	const mark = required ? "*" : "";
	if (!field) return `${name}${mark}`;
	if (field.const !== undefined) return `${name}${mark}=must be exactly ${JSON.stringify(field.const)}`;
	if (Array.isArray(field.enum)) return `${name}${mark}=one of ${(field.enum as string[]).slice(0, 6).join("|")}`;
	if (field.type === "object" && field.properties && depth > 0) {
		const objRequired = new Set(field.required ?? []);
		const fields = orderedEntries(field.properties, objRequired).map(([fk, fv]) => describeField(fk, fv, objRequired.has(fk), depth - 1));
		return `${name}${mark} (object: ${fields.join(", ")})`;
	}
	if (field.type === "array") {
		const min = field.minItems !== undefined ? `, minItems ${field.minItems}` : "";
		const itemType = field.items?.type ?? "any";
		const itemProps = field.items?.properties;
		if (itemType === "object" && itemProps && depth > 0) {
			const itemRequired = new Set(field.items?.required ?? []);
			const fields = orderedEntries(itemProps, itemRequired).map(([fk, fv]) => describeField(fk, fv, itemRequired.has(fk), depth - 1));
			return `${name}${mark}=array${min} of {${fields.join(", ")}}`;
		}
		return `${name}${mark}=array${min} of ${itemType}`;
	}
	if (field.type && field.type !== "object" && field.type !== "array") return `${name}${mark} (${field.type})`;
	return `${name}${mark}`;
}

/** Concise required-structure spec for an artifact, read from its bundled JSON schema. */
function readSchemaSpec(artifact: string): string | undefined {
	if (schemaSpecCache.has(artifact)) return schemaSpecCache.get(artifact);
	const path = schemaPath(artifact);
	if (!existsSync(path)) {
		schemaSpecCache.set(artifact, undefined);
		return undefined;
	}
	try {
		const schema = JSON.parse(readFileSync(path, "utf8")) as {
			required?: string[];
			properties?: Record<string, FieldSchema>;
		};
		const req = schema.required ?? [];
		const props = schema.properties ?? {};
		// Top-level required fields are never asterisk-marked (every entry here already
		// IS required, by construction of `req`) — only their nested sub-fields are.
		const parts = req.map((k) => {
			const p = props[k];
			if (!p) return k;
			if (p.const !== undefined) return `${k} (must be exactly ${JSON.stringify(p.const)})`;
			if (Array.isArray(p.enum)) return `${k} (one of: ${(p.enum as string[]).slice(0, 6).join("|")})`;
			if (p.type === "object" && p.properties) return describeField(k, p, false);
			if (p.type === "array") return describeField(k, p, false);
			return `${k} (${p.type ?? "any"})`;
		});
		const spec = parts.join(", ");
		schemaSpecCache.set(artifact, spec);
		return spec;
	} catch {
		schemaSpecCache.set(artifact, undefined);
		return undefined;
	}
}

/** Resolve the pi CLI entry (PI_BIN env → the in-repo s2-agent CLI). */
function resolvePiBin(): string {
	const envBin = process.env.PI_BIN;
	if (envBin && existsSync(envBin)) return envBin;
	const repoRoot = join(import.meta.dir, "..", "..", "..");
	const inRepo = join(repoRoot, "bun-apps", "s2-agent", "src", "cli.ts");
	if (existsSync(inRepo)) return inRepo;
	throw new Error(
		`run-pipeline: could not resolve the pi binary for a waypoint session.\n` +
			`  Looked for: PI_BIN env (${envBin ?? "unset"}) and ${inRepo}.\n` +
			`  Set PI_BIN to your pi CLI entry, or run from within the repo.`,
	);
}

interface BoundedSession {
	system: string;
	user: string;
	model?: string;
	toolset: string[];
}

/**
 * Spawn a bounded, non-interactive pi sub-session and return its final assistant
 * text (the artifact JSON the waypoint then parses + validates). NDJSON event
 * stream via --mode json; the last assistant message text is the result.
 */
export function runBoundedSession(sess: BoundedSession, opts: { spawnImpl?: typeof spawn; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
	const piBin = resolvePiBin();
	const doSpawn = opts.spawnImpl ?? spawn;
	// Tool scoping is what keeps each waypoint deterministic + fast:
	//   • completion waypoints (proposal/script/scene_plan/edit) → NO tools (pure JSON).
	//   • research → an allowlist of just the web tools (web_search/fetch/get_search_content).
	// The s2-agent wrapper still loads the run-dir set; the system prompt (embedded in
	// -p) directs behavior. Excluding movie tools is belt-and-braces against recursion.
	const argv = ["bun", piBin, "--mode", "json"];
	if (sess.toolset.length > 0) {
		argv.push("--tools", [...sess.toolset, "read", "write"].join(","));
	} else {
		argv.push("--no-tools");
	}
	argv.push("--exclude-tools", "movie,movie_help");
	if (sess.model) argv.push("--model", sess.model);
	// Embed the system prompt as a preamble (robust regardless of CLI flags);
	// the user instruction follows a separator.
	argv.push("-p", `${sess.system}\n\n---\n\n${sess.user}`);

	return new Promise((resolve, reject) => {
		const child = doSpawn(argv[0]!, argv.slice(1), {
			stdio: ["ignore", "pipe", "pipe"],
			env: opts.env ?? process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => (stdout += d.toString()));
		child.stderr?.on("data", (d) => (stderr += d.toString()));
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0 && !stdout.trim()) {
				return reject(new Error(`bounded pi session exited ${code}: ${stderr.slice(0, 500)}`));
			}
			resolve(extractFinalAssistantText(stdout));
		});
	});
}

/** Pull the text out of a message whose content may be a string or an array of blocks. */
function messageText(m: { content?: unknown; text?: string }): string {
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return m.content
			.filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
			.map((b) => b.text ?? "")
			.join("");
	}
	return typeof m.text === "string" ? m.text : "";
}

/** Pull the final assistant message text out of a pi --mode json NDJSON stream. */
function extractFinalAssistantText(ndjson: string): string {
	let lastAssistant = "";
	for (const line of ndjson.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let evt: {
			type?: string;
			role?: string;
			content?: unknown;
			text?: string;
			message?: { role?: string; content?: unknown };
			messages?: Array<{ role?: string; content?: unknown }>;
		};
		try {
			evt = JSON.parse(trimmed);
		} catch {
			continue;
		}
		// Gather candidate assistant messages from this event.
		const candidates: Array<{ role?: string; content?: unknown; text?: string }> = [];
		if (evt.type === "turn_end" && evt.message) candidates.push(evt.message);
		if (Array.isArray(evt.messages)) for (const m of evt.messages) if (m?.role === "assistant") candidates.push(m);
		if (evt.role === "assistant" || evt.type === "assistant") candidates.push(evt);
		for (const m of candidates) {
			if (m.role && m.role !== "assistant") continue;
			const text = messageText(m as { content?: unknown; text?: string });
			if (text.trim()) lastAssistant = text;
		}
	}
	// Fallback: tail of the stream (better than empty — the caller validates + retries on parse failure).
	return lastAssistant || ndjson.trim().slice(-2000);
}

export interface RealWaypointOptions {
	model?: string;
	validateFn?: WaypointDeps["validateFn"];
	/** Inject the session runner in tests (otherwise the real spawn). */
	runSession?: (sess: BoundedSession) => Promise<string>;
}

/** Build the production WaypointDeps: bounded pi sessions + dispatch validation. */
export function makeRealWaypointDeps(opts: RealWaypointOptions = {}): WaypointDeps {
	const runSession = opts.runSession ?? ((sess: BoundedSession) => runBoundedSession(sess));
	return {
		completionFn: (system, user, model) => runSession({ system, user, model: model ?? opts.model, toolset: [] }),
		agentFn: (system, user, aOpts) => runSession({ system, user, model: aOpts.model ?? opts.model, toolset: aOpts.toolset }),
		validateFn: opts.validateFn,
		schemaSpec: readSchemaSpec,
		schemaFor: readSchemaObject,
	};
}
