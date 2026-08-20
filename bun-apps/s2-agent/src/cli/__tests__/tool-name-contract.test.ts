/**
 * Tool-name contract: every curated allowlist must name tools that the
 * extension set that command actually injects really registers.
 *
 * WHY THIS EXISTS
 * ---------------
 * `pipeline url-to-vault` and `pipeline youtube-to-vault` shipped completely
 * broken: their allowlist named `obsidian_distill` / `obsidian_create` /
 * `obsidian_search`, which stopped being registered tools when pi-obsidian
 * collapsed its 18 `obsidian_*` tools into one action-dispatched facade
 * (only `obsidian` and `obsidian_help` reach `pi.registerTool()`). They also
 * asked for `fetch_content` without injecting the web-access factory that
 * provides it. Every invocation died at session creation on
 * `validateToolNames`, and nothing noticed because neither pipeline had a test.
 *
 * `validateToolNames` is a RUN-time guard. This is the BUILD-time one: a
 * cross-package tool-registration change now fails here instead of in a user's
 * terminal.
 *
 * HOW IT WORKS
 * ------------
 * Extension factories are invoked against a mock `pi` (same shape `ext-doctor`
 * uses) purely to collect the names they register. No session, no model, no
 * network — this runs in the default `bun test` tier.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import obsidianExtension from "@repo/s2-agent-ext-obsidian/extensions/obsidian.ts";
import webAccessExtension from "@repo/s2-agent-ext-web-access";
import knowledgeCardExtension from "@repo/s2-agent-ext-knowledge-card/extensions/knowledge-card.ts";
import {
	ADD_TOOLS,
	CHECK_TOOLS,
	DISTILL_TOOLS,
	FIND_TOOLS,
	RAG_TOOLS,
	REMOVE_TOOLS,
	UPDATE_TOOLS,
} from "@repo/s2-agent-ext-knowledge-card/extensions/knowledge-card.ts";
import { EXTENSION_SPECS } from "../extensions/registry.ts";
import { AGENT_TOOLS } from "../commands/agent.ts";
import {
	URL_TO_VAULT_FACTORIES,
	URL_TO_VAULT_TOOLS,
} from "../commands/url-to-vault.ts";

/**
 * pi-core builtins. These are NOT registered by any extension — they come from
 * the agent session itself — so an allowlist may name them freely.
 *
 * Kept explicit rather than derived: building a real session would need a model
 * and drag this test out of the default tier. If pi-core renames one, the
 * failure lands here with a clear message, which is the point.
 */
const CORE_BUILTINS = new Set([
	"read",
	"write",
	"edit",
	"multi_edit",
	"bash",
	"glob",
	"grep",
	"ls",
	"todo_write",
	"web_fetch",
	"web_search",
	"task",
	"ask_user_question",
]);

type ToolLike = { name?: unknown };

/** Mirror of ext-doctor's mock pi — enough surface for a factory to register. */
function collectRegisteredToolNames(factories: unknown[]): Set<string> {
	const names = new Set<string>();
	const pi = {
		registerTool: (t: ToolLike) => {
			if (typeof t?.name === "string") names.add(t.name);
			return t;
		},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		registerShortcut: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => "medium",
		on: () => {},
		events: { on: () => () => {}, off: () => {}, emit: () => {}, once: () => () => {} },
		getAllTools: () => [],
		exec: async () => "",
		z: { undefined: () => ({}) },
	};
	for (const f of factories) {
		(f as (api: unknown) => void)(pi);
	}
	return names;
}

/**
 * The factory every CLI session gets for free.
 * Source of truth: `getSharedServices` in `sessions/shared.ts`, which seeds
 * `extensionFactories` with obsidian and nothing else.
 */
const ALWAYS_ON: unknown[] = [obsidianExtension];

interface Case {
	/** How the failure should read. */
	label: string;
	/** The curated allowlist under test. */
	tools: readonly string[];
	/** Factories this command passes as `extraExtensionFactories`. */
	factories: unknown[];
}

/**
 * Hand-written commands. Extension-backed sub-commands are covered separately
 * below, driven straight off `EXTENSION_SPECS` so a new one is covered the day
 * it is registered — no edit to this file required.
 */
const HAND_WRITTEN: Case[] = [
	// commands/url-to-vault.ts — the regression this file exists for.
	// Imported, never restated: a test that keeps its own copy of the allowlist
	// passes while the shipped one rots, which is how this broke in the first place.
	{
		label: "pipeline url-to-vault / youtube-to-vault",
		tools: URL_TO_VAULT_TOOLS,
		factories: URL_TO_VAULT_FACTORIES,
	},
	// commands/zk-extract.ts
	{ label: "zk-extract", tools: DISTILL_TOOLS, factories: [] },
	// commands/zk-card.ts — one allowlist per sub-action.
	{ label: "zk-card add", tools: ADD_TOOLS, factories: [] },
	{ label: "zk-card find", tools: FIND_TOOLS, factories: [] },
	{ label: "zk-card update", tools: UPDATE_TOOLS, factories: [] },
	{ label: "zk-card remove", tools: REMOVE_TOOLS, factories: [] },
	{ label: "zk-card check", tools: CHECK_TOOLS, factories: [] },
	// commands/zk-ask.ts
	{ label: "zk-ask", tools: RAG_TOOLS, factories: [] },
	// commands/agent.ts injects web-access + knowledge-card on top of obsidian.
	{
		label: "agent",
		tools: AGENT_TOOLS,
		factories: [webAccessExtension, knowledgeCardExtension],
	},
];

function assertResolvable(c: Case): void {
	const registered = collectRegisteredToolNames([...ALWAYS_ON, ...c.factories]);
	const unresolved = c.tools.filter(
		(t) => !registered.has(t) && !CORE_BUILTINS.has(t),
	);
	if (unresolved.length > 0) {
		throw new Error(
			`${c.label}: allowlist names ${unresolved.length} tool(s) that no injected ` +
				`extension registers:\n` +
				unresolved.map((u) => `  ${u}`).join("\n") +
				`\n\nEither the tool was renamed/removed upstream (check the extension's ` +
				`registerTool calls), or the factory that provides it is missing from this ` +
				`command's \`factories\`. Registered here: ${[...registered].sort().join(", ")}`,
		);
	}
	expect(unresolved).toEqual([]);
}

describe("tool-name contract — hand-written commands", () => {
	for (const c of HAND_WRITTEN) {
		test(`${c.label}: every allowlisted tool is registered`, () => {
			assertResolvable(c);
		});
	}
});

describe("tool-name contract — extension sub-commands", () => {
	test("registry is non-empty (a silently emptied registry must not pass)", () => {
		expect(EXTENSION_SPECS.length).toBeGreaterThan(0);
	});

	for (const spec of EXTENSION_SPECS) {
		test(`${spec.name}: every allowlisted tool is registered`, () => {
			assertResolvable({
				label: spec.name,
				tools: spec.tools,
				factories: [spec.factory],
			});
		});
	}
});

/**
 * Allowlists are not the only place a dead tool name does damage: a PROMPT that
 * names a tool the session does not have makes the model hallucinate a call
 * that can never succeed.
 *
 * `pdf-to-vault`'s "0 notes" recovery prompt — written specifically to fix
 * hallucinated tool calls — instructed the model to call `obsidian_distill`,
 * which the facade collapse had already un-registered. The recovery path failed
 * by construction, and the allowlist check above could not see it.
 */
describe("no CLI source names a tool the facade no longer registers", () => {
	const CLI_DIR = join(import.meta.dir, "..");
	// The only surviving `obsidian_`-prefixed registered tool.
	const LIVE = new Set(["obsidian_help"]);

	/**
	 * Blank out comments while preserving offsets, so line numbers in a failure
	 * still point at the source. String literals are deliberately KEPT — a prompt
	 * is a string, and a dead tool name inside one is the defect this hunts.
	 *
	 * A comment naming an old tool is stale documentation, not a live defect;
	 * blocking on those would make this unfixable without a doc sweep.
	 *
	 * Character-scanned rather than line-matched: the previous line-anchored
	 * `/^\s*(\/\/|\/\*|\*)/` treated any code line with a trailing `// …` as
	 * fully commented (a false negative), and any block-comment continuation
	 * line not starting with `*` as code (a false positive).
	 *
	 * Known limit: a `//` inside a regex literal, or inside a `${…}` expression
	 * nested in a template literal, is not modelled. Neither appears here, and
	 * the failure mode of both is a false positive — loud, not silent.
	 */
	function blankComments(src: string): string {
		let out = "";
		let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
		for (let i = 0; i < src.length; i++) {
			const c = src[i];
			const d = src[i + 1];
			if (state === "code") {
				if (c === "/" && d === "/") { state = "line"; out += "  "; i++; continue; }
				if (c === "/" && d === "*") { state = "block"; out += "  "; i++; continue; }
				if (c === "'" || c === '"' || c === "`") state = c;
				out += c;
				continue;
			}
			if (state === "line" || state === "block") {
				if (state === "line" && c === "\n") state = "code";
				else if (state === "block" && c === "*" && d === "/") { state = "code"; out += "  "; i++; continue; }
				out += c === "\n" ? "\n" : " ";
				continue;
			}
			// inside a string literal — passed through verbatim
			if (c === "\\") { out += c + (d ?? ""); i++; continue; }
			if (c === state) state = "code";
			out += c;
		}
		return out;
	}

	/** Every .ts under src/cli/ except this test tree. Scoped to the whole
	 *  namespace, not just commands/: prompts also live in extensions/ runners
	 *  and sessions/ factories. */
	function walk(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
			const p = join(dir, e.name);
			if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(p);
			return e.name.endsWith(".ts") ? [p] : [];
		});
	}

	const files = walk(CLI_DIR);

	test("the walk actually found the CLI sources", () => {
		// An empty file list would make every assertion below vacuously pass.
		expect(files.length).toBeGreaterThan(20);
		expect(files.some((f) => f.endsWith("pdf-to-vault.ts"))).toBe(true);
	});

	for (const file of files) {
		const rel = file.slice(CLI_DIR.length + 1);
		test(`${rel} has no dead obsidian_* in executable code`, () => {
			const src = blankComments(readFileSync(file, "utf8"));
			const offenders: string[] = [];
			src.split("\n").forEach((line, i) => {
				for (const m of line.matchAll(/\bobsidian_[a-z_]+/g)) {
					if (!LIVE.has(m[0])) offenders.push(`${rel}:${i + 1}  ${m[0]}`);
				}
			});
			expect(offenders).toEqual([]);
		});
	}
});

describe("obsidian facade shape", () => {
	test("the facade registers exactly the two tools every allowlist may name", () => {
		const registered = collectRegisteredToolNames(ALWAYS_ON);
		// Pins the collapse itself. If pi-obsidian ever unbundles back into
		// individual obsidian_* tools, this fails and the allowlists above can be
		// widened deliberately rather than by accident.
		expect([...registered].sort()).toEqual(["obsidian", "obsidian_help"]);
	});

	test("no allowlist still names a pre-facade obsidian_* tool", () => {
		const stale = [
			...HAND_WRITTEN.flatMap((c) => c.tools),
			...EXTENSION_SPECS.flatMap((s) => s.tools),
		].filter((t) => t.startsWith("obsidian_") && t !== "obsidian_help");
		expect(stale).toEqual([]);
	});
});
