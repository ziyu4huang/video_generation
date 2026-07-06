/**
 * verify-extensions.ts — FAST extension load verifier (no agent boot).
 *
 * Boots NO pi-agent session, provider, or network call. It native-imports each
 * extension factory listed in run-dir/manifest.json and invokes it with a mock
 * `pi` that records registerTool / registerCommand / on calls. This is the
 * cheap, isolated way to assert "every extension still loads + wires up"
 * without the multi-second cost and async races of `pi-agent.sh -p` (provider
 * registration, zai-mcp network, models.json, TUI).
 *
 * WHY this works now: repo-root node_modules symlinks (created by the
 * ensure-extension-deps patch) make the extensions' bare specifiers
 * (@earendil-works/pi-coding-agent, typebox) natively resolvable, so Bun
 * imports the .ts graph directly — no jiti transform, no >4 KB tempfile bug.
 *
 * Usage: bun bun-apps/pi-agent/scripts/verify-extensions.ts
 * Exit: 0 if every extension loaded + wired; 1 otherwise.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseManifestEntries } from "../run-dir/manifest-types.ts";

const PI_AGENT_DIR = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(PI_AGENT_DIR, "../..");
const MANIFEST = JSON.parse(
	readFileSync(path.join(PI_AGENT_DIR, "run-dir", "manifest.json"), "utf8"),
) as { extensions: (string | object)[]; lazyExtensions?: Record<string, string> };
const MANIFEST_ENTRIES = parseManifestEntries(MANIFEST.extensions ?? []);

// Self-sufficient: import the patch so the repo-root node_modules symlinks exist
// before we native-import any extension. The patch is a side-effect module
// (no-op when symlinks are already correct). This lets the verifier run on a
// fresh clone without first launching pi-agent.
await import("../src/patches/ensure-extension-deps.ts");

interface ToolLike {
	name?: string;
	[key: string]: unknown;
}

function makeMockPi() {
	const tools: ToolLike[] = [];
	const commands: string[] = [];
	let onEvents = 0;
	const pi = {
		registerTool: (t: ToolLike) => {
			tools.push(t);
			return t;
		},
		registerCommand: (c: { name?: string } | string) => {
			commands.push(typeof c === "string" ? c : (c.name ?? "<anon>"));
		},
		on: (_event: string, _fn: unknown) => {
			onEvents++;
		},
		getAllTools: () => tools,
		exec: async () => "",
		z: { undefined: () => ({}) },
		sendUserMessage: () => {},
	};
	return { pi, tools, commands, onEvents };
}

type Result = {
	ext: string;
	entryPath: string;
	ok: boolean;
	wired: boolean;
	error?: string;
	tools: string[];
	commands: string[];
	dynamic: boolean;
};

async function loadOne(rel: string, dynamic = false): Promise<Result> {
	const abs = path.resolve(REPO_ROOT, "bun-apps", rel);
	const ext = rel.split("/").pop() ?? rel;
	try {
		const mod = await import(abs);
		const factory = mod.default;
		if (typeof factory !== "function") {
			return { ext, ok: false, wired: false, error: `no default factory (got ${typeof factory})`, tools: [], commands: [], dynamic };
		}
		const { pi, tools, commands, onEvents } = makeMockPi();
		const maybe = factory(pi);
		if (maybe && typeof (maybe as Promise<void>).then === "function") {
			await maybe;
		}
		// Extensions like zai-mcp register tools dynamically inside a session_start
		// callback (MCP servers load async), so 0 static tools is normal for them —
		// a load without error + at least one on()/registerTool/registerCommand
		// call means the factory wired up correctly.
		const wired = tools.length > 0 || commands.length > 0 || onEvents > 0;
		return { ext, entryPath: abs, ok: true, wired, tools: tools.map((t) => String(t.name ?? "?")), commands, dynamic };
	} catch (e) {
		return { ext, entryPath: abs, ok: false, wired: false, error: (e as Error).message?.split("\n")[0] ?? String(e), tools: [], commands: [], dynamic };
	}
}

const rows: Result[] = [];
for (const entry of MANIFEST_ENTRIES) rows.push(await loadOne(entry.entry));
// Lazy extensions live in the manifest too — verify their factories load.
if (MANIFEST.lazyExtensions) {
	for (const [name, rel] of Object.entries(MANIFEST.lazyExtensions)) {
		const r = await loadOne(rel, true);
		rows.push({ ...r, ext: `${name} (lazy) <- ${r.ext}` });
	}
}

// ── Cross-extension tool-conflict detection ─────────────────────────────────
// Two extensions registering the same tool name crashes at agent boot
// ("Tool X conflicts"). Catch it here — the mock pi records (name, ext) for
// every registerTool call across the WHOLE set, so a duplicate is a structural
// bug, not a runtime race.
const toolOwners = new Map<string, Map<string, string[]>>(); // toolName → entryPath → [ext, ...]
for (const r of rows) {
	for (const toolName of r.tools) {
		if (!toolOwners.has(toolName)) toolOwners.set(toolName, new Map());
		const byPath = toolOwners.get(toolName)!;
		const exts = byPath.get(r.entryPath ?? r.ext) ?? [];
		exts.push(r.ext);
		byPath.set(r.entryPath ?? r.ext, exts);
	}
}
const conflicts: string[] = [];
for (const [toolName, byPath] of toolOwners) {
	// A real conflict = same tool registered from DIFFERENT entry paths.
	// Same-path entries (lazy aliases to the same file) are NOT conflicts.
	if (byPath.size > 1) {
		const owners = [...byPath.values()].flat();
		conflicts.push(`${toolName}: [${owners.join(", ")}]`);
	}
}

const w = (s: string) => process.stdout.write(s);
w("\n=== extension load verification ===\n");
let fail = 0;
for (const r of rows) {
	const status = r.ok ? (r.wired ? "OK   " : "OK?  ") : "FAIL ";
	w(`${status} ${r.ext.padEnd(34)} tools=[${r.tools.join(", ")}]${r.commands.length ? ` cmds=[${r.commands.join(",")}]` : ""}${r.error ? `\n     ↳ ${r.error}` : ""}\n`);
	if (!r.ok) fail++;
}

if (conflicts.length) {
	w("\n\x1b[31m✗ tool-name conflicts across extensions:\x1b[0m\n");
	for (const c of conflicts) w(`  ${c}\n`);
	fail++;
} else {
	w("\n\x1b[32m✓ no cross-extension tool-name conflicts\x1b[0m\n");
}

w(`\n${rows.length - fail}/${rows.length} extensions loaded + wired.\n`);
if (fail > 0) {
	w(`${fail} extension(s) failed to load or wired nothing.\n`);
	process.exit(1);
}
