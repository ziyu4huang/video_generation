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
import { parseManifestEntries } from "../run-dir/manifest-types.ts";

const PI_AGENT_DIR = resolve(dirname(import.meta.url.replace("file://", "")), "..");
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
		on: () => { pi.onCount++; },
		getAllTools: () => tools,
		exec: async () => "",
		z: { undefined: () => ({}) },
		sendUserMessage: () => {},
	};
	return { pi, tools, commands, get onCount() { return pi.onCount; } };
}

export async function runExtDoctor(opts: { json?: boolean } = {}): Promise<{ ok: boolean; entries: ExtDoctorEntry[] }> {
	// Ensure repo-root node_modules symlinks exist.
	await import("./patches/ensure-extension-deps.ts");

	const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
		extensions: (string | object)[];
		lazyExtensions?: Record<string, string>;
	};
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
		process.stdout.write(`\n${B}pi-agent ext doctor${RST}  (${results.length} extensions)\n\n`);
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
