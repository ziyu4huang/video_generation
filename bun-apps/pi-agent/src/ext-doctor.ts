/**
 * ext-doctor — per-extension health report (the extension equivalent of `doctor`).
 *
 * `bun src/cli.ts ext doctor [--json]` — loads every manifest extension through
 * a mock pi, verifies the factory loads + wires up (tools/commands/events),
 * checks for cross-extension tool-name conflicts, and reports:
 *   - name + bundleMode (thin/full) + version + testGate (from manifest v2)
 *   - tools/commands registered synchronously
 *   - OK / FAIL / DYNAMIC status
 *
 * Exits 0 (all green) or 1 (any fail). Offline, fast (~1s), no agent boot.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifestEntries } from "../run-dir/manifest-types.ts";
import { isBunBinary } from "./mode.ts";
// NOTE: static-extensions.ts is imported DYNAMICALLY inside runExtDoctor(),
// below the ensure-extension-deps await — see the comment there. A top-level
// import is hoisted, and `ext doctor` is one of cli.ts's PRE-patch intercepts,
// so a static import here would evaluate all 14 extension entry graphs before
// the symlinks they resolve through exist.

/** Resolve pi-agent's package root from this module's URL. Uses fileURLToPath
 *  (not a naive `.replace("file://", "")`) so percent-encoded characters —
 *  e.g. a space in the checkout path — are decoded correctly. Exported for
 *  direct unit testing without needing a real special-character checkout. */
export function resolvePiAgentDir(moduleUrl: string): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

const PI_AGENT_DIR = resolvePiAgentDir(import.meta.url);
const REPO_ROOT = resolve(PI_AGENT_DIR, "../..");
const MANIFEST_PATH = join(PI_AGENT_DIR, "run-dir", "manifest.json");

interface ExtDoctorEntry {
	name: string;
	entry: string;
	bundleMode: string;
	version?: string;
	testGate?: string;
	status: "OK" | "FAIL" | "DYNAMIC";
	tools: string[];
	commands: string[];
	error?: string;
}

interface ToolLike {
	name?: string;
	[key: string]: unknown;
}

function makeMockPi() {
	const tools: ToolLike[] = [];
	const commands: string[] = [];
	const pi = {
		onCount: 0,
		registerTool: (t: ToolLike) => { tools.push(t); return t; },
		registerCommand: (name: string) => { commands.push(name); },
		registerMessageRenderer: () => {},
		registerShortcut: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		getThinkingLevel: () => "medium",
		on: () => { pi.onCount++; },
		// Minimal event bus: some extensions (workflow, btw) wire lifecycle
		// handlers via `pi.events.on(...)` at factory time. Provide a no-op bus
		// so their factories load instead of false-failing on `undefined.events`.
		events: { on: () => () => {}, off: () => {}, emit: () => {}, once: () => () => {} },
		getAllTools: () => tools,
		exec: async () => "",
		z: { undefined: () => ({}) },
		sendUserMessage: () => {},
	};
	return { pi, tools, commands, get onCount() { return pi.onCount; } };
}

export async function runExtDoctor(opts: { json?: boolean } = {}): Promise<{ ok: boolean; entries: ExtDoctorEntry[] }> {
	// Ensure repo-root node_modules symlinks exist. (No-op in compiled-binary mode —
	// the patch's import resolves but there's no node_modules to symlink; harmless.)
	await import("./patches/ensure-extension-deps.ts");

	// Static extension factories, loaded HERE rather than at the top of the file,
	// for the same reason cli.ts loads them below applyPatches(): a top-level
	// import is hoisted, and `ext doctor` is intercepted BEFORE applyPatches().
	// static-extensions.ts pulls each extension's entry module, and
	// pi-agent-ext-webui's graph imports `@earendil-works/pi-coding-agent`
	// without declaring it — resolvable only through the repo-root symlinks the
	// await above creates. Hoisting evaluated that graph first and broke the
	// snapshot deploy. Keep this import below the ensure-extension-deps await.
	const { STATIC_EXTENSION_FACTORIES } = await import("./static-extensions.ts");

	// Compiled-binary mode (`bun build --compile`): manifest.json is NOT embedded
	// in the $bunfs virtual FS, so readFileSync(MANIFEST_PATH) throws ENOENT. The
	// manifest's relative .ts paths don't exist in a binary either (a user's own
	// `-e` .ts paths DO load — upstream 0.80.10+ jiti binary path — but those
	// aren't this doctor's concern). Fall back to checking ONLY the statically-bundled factories
	// (STATIC_EXTENSION_FACTORIES below) — which is exactly the set that matters
	// for verifying a compiled binary ships its tools. binaryMode is detected from
	// the module URL (mode.ts's isBunBinary), NOT inferred from the manifest read
	// failing below — a read failure (ENOENT, EACCES, bad JSON) is a genuine
	// problem and must not silently masquerade as "compiled binary".
	const binaryMode = isBunBinary(import.meta.url);
	let manifest: { extensions: (string | object)[]; lazyExtensions?: Record<string, string> };
	try {
		manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
	} catch {
		manifest = { extensions: [], lazyExtensions: {} };
	}
	const entries = parseManifestEntries(manifest.extensions ?? []);
	const results: ExtDoctorEntry[] = [];

	for (const entry of entries) {
		const abs = join(REPO_ROOT, "bun-apps", entry.entry);
		try {
			const mod = await import(abs);
			const factory = mod.default;
			if (typeof factory !== "function") {
				results.push({ ...entry, bundleMode: entry.bundleMode ?? "thin", status: "FAIL", tools: [], commands: [], error: `no default factory (${typeof factory})` });
				continue;
			}
			const mock = makeMockPi();
			const maybe = factory(mock.pi);
			if (maybe && typeof (maybe as Promise<void>).then === "function") await maybe;
			const toolNames = mock.tools.map((t) => String(t.name ?? "?"));
			const wired = toolNames.length > 0 || mock.commands.length > 0 || mock.onCount > 0;
			results.push({
				...entry,
				bundleMode: entry.bundleMode ?? "thin",
				status: wired ? "OK" : "DYNAMIC",
				tools: toolNames,
				commands: mock.commands,
			});
		} catch (e) {
			results.push({
				...entry,
				bundleMode: entry.bundleMode ?? "thin",
				status: "FAIL",
				tools: [],
				commands: [],
				error: (e as Error).message?.split("\n")[0] ?? String(e),
			});
		}
	}

	// Also check the statically-bundled "general productivity" extension set
	// (src/static-extensions.ts) — these are deliberately ABSENT from
	// manifest.extensions (loaded via MainOptions.extensionFactories, not `-e
	// <path>.ts`, so they survive `bun build --compile`), but ext doctor must
	// still cover them or this report silently loses 5 extensions' worth of
	// health/conflict checking.
	for (const { name, factory } of STATIC_EXTENSION_FACTORIES) {
		try {
			const mock = makeMockPi();
			// mock.pi is a deliberately minimal duck-typed stand-in (see
			// makeMockPi() above) — it satisfies every extension factory at
			// runtime (they only call the handful of methods it implements) but
			// not the full ExtensionAPI shape, so a cast is required here. The
			// dynamically-`import()`ed factories above don't need this because
			// `mod.default` is untyped (any); these factories are strongly typed
			// via the static import in static-extensions.ts.
			const maybe = factory(mock.pi as unknown as Parameters<typeof factory>[0]);
			if (maybe && typeof (maybe as Promise<void>).then === "function") await maybe;
			const toolNames = mock.tools.map((t) => String(t.name ?? "?"));
			const wired = toolNames.length > 0 || mock.commands.length > 0 || mock.onCount > 0;
			results.push({
				name,
				entry: `static-extensions.ts (${name})`,
				bundleMode: "static",
				status: wired ? "OK" : "DYNAMIC",
				tools: toolNames,
				commands: mock.commands,
			});
		} catch (e) {
			results.push({
				name,
				entry: `static-extensions.ts (${name})`,
				bundleMode: "static",
				status: "FAIL",
				tools: [],
				commands: [],
				error: (e as Error).message?.split("\n")[0] ?? String(e),
			});
		}
	}

	// Also check lazy extensions
	if (manifest.lazyExtensions) {
		for (const [alias, rel] of Object.entries(manifest.lazyExtensions)) {
			const abs = join(REPO_ROOT, "bun-apps", rel);
			try {
				const mod = await import(abs);
				const factory = mod.default;
				if (typeof factory === "function") {
					const mock = makeMockPi();
					const maybe = factory(mock.pi);
					if (maybe && typeof (maybe as Promise<void>).then === "function") await maybe;
					const toolNames = mock.tools.map((t) => String(t.name ?? "?"));
					results.push({
						name: `${alias} (lazy)`,
						entry: rel,
						bundleMode: "thin",
						status: toolNames.length > 0 || mock.commands.length > 0 ? "OK" : "DYNAMIC",
						tools: toolNames,
						commands: mock.commands,
					});
				}
			} catch (e) {
				results.push({
					name: `${alias} (lazy)`,
					entry: rel,
					bundleMode: "thin",
					status: "FAIL",
					tools: [],
					commands: [],
					error: (e as Error).message?.split("\n")[0] ?? String(e),
				});
			}
		}
	}

	// Cross-extension tool-conflict check (same-file lazy aliases excluded)
	const toolOwners = new Map<string, Map<string, string[]>>(); // toolName → entryPath → [name, ...]
	for (const r of results) {
		for (const toolName of r.tools) {
			if (!toolOwners.has(toolName)) toolOwners.set(toolName, new Map());
			const byPath = toolOwners.get(toolName)!;
			const names = byPath.get(r.entry) ?? [];
			names.push(r.name);
			byPath.set(r.entry, names);
		}
	}
	const conflicts: string[] = [];
	for (const [, byPath] of toolOwners) {
		if (byPath.size > 1) {
			const owners = [...byPath.values()].flat();
			conflicts.push(`${[...byPath.keys()].join(" | ")}: [${owners.join(", ")}]`);
		}
	}

	const fail = results.filter((r) => r.status === "FAIL").length;
	const ok = fail === 0 && conflicts.length === 0;

	if (opts.json) {
		process.stdout.write(JSON.stringify({ ok, entries: results, conflicts }) + "\n");
	} else {
		const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", B = "\x1b[1m", RST = "\x1b[0m";
		process.stdout.write(`\n${B}pi-agent ext doctor${RST}  (${results.length} extensions)${binaryMode ? `${D}  [compiled binary — static factories only, manifest.json not in \$bunfs]${RST}` : ""}\n\n`);
		for (const r of results) {
			const badge = r.status === "OK" ? `${G}OK   ${RST}` : r.status === "DYNAMIC" ? `${Y}DYN  ${RST}` : `${R}FAIL ${RST}`;
			const meta = [r.bundleMode, r.version, r.testGate].filter(Boolean).join(" · ");
			process.stdout.write(`${badge} ${r.name.padEnd(34)} ${D}${meta}${RST}\n`);
			if (r.tools.length) process.stdout.write(`${D}        tools: [${r.tools.join(", ")}]${RST}\n`);
			if (r.commands.length) process.stdout.write(`${D}        cmds:  [${r.commands.join(", ")}]${RST}\n`);
			if (r.error) process.stdout.write(`${R}        error: ${r.error}${RST}\n`);
		}
		if (conflicts.length) {
			process.stdout.write(`\n${R}✗ tool-name conflicts:${RST}\n`);
			for (const c of conflicts) process.stdout.write(`  ${c}\n`);
		} else {
			process.stdout.write(`\n${G}✓ no cross-extension tool-name conflicts${RST}\n`);
		}
		process.stdout.write(`\n${ok ? G + "✓" : R + "✗"} ${results.filter((r) => r.status !== "FAIL").length}/${results.length} extensions healthy${RST}\n`);
	}

	return { ok, entries: results };
}
