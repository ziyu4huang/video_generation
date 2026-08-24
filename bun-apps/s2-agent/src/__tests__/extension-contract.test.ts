/**
 * extension-contract — the SINGLE gate every extension must pass to be deployable.
 *
 * This is the extension protocol's enforcement layer. It loads every manifest
 * extension through a mock `pi` and asserts:
 *   (a) factory loads without throwing
 *   (b) registers >=1 tool or command (wired up)
 *   (c) no tool-name conflicts across extensions (same-path aliases excluded)
 *   (d) every registered tool has a non-empty name + label + description
 *   (e) every registered command has a handler function
 *
 * A new extension that fails any of these is NOT deployable — it crashes at
 * agent boot or silently no-ops. This test catches it at test time, not deploy
 * or runtime.
 *
 * Run: bun test src/__tests__/extension-contract.test.ts  (or just `bun test`)
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseManifestEntries } from "../../src/run-dir/manifest-types.ts";
import { makeMockPi } from "./test-utils.ts";

// Self-sufficient: import the patch so repo-root node_modules symlinks exist.
await import("../patches/ensure-extension-deps.ts");

const PI_AGENT_DIR = path.resolve(import.meta.dirname, "../..");
const REPO_ROOT = path.resolve(PI_AGENT_DIR, "../..");
const MANIFEST = JSON.parse(
	readFileSync(path.join(PI_AGENT_DIR, "src", "run-dir", "manifest.json"), "utf8"),
) as { extensions: (string | object)[]; lazyExtensions?: Record<string, string> };
const ENTRIES = parseManifestEntries(MANIFEST.extensions ?? []);

/** Load one extension factory, return its tools/commands/events. */
async function loadExtension(entryRel: string) {
	const abs = path.resolve(REPO_ROOT, "bun-apps", entryRel);
	const mod = await import(abs);
	const factory = mod.default;
	if (typeof factory !== "function") {
		return { error: `no default factory (got ${typeof factory})`, tools: [], commands: [], onCount: 0, abs };
	}
	const mock = makeMockPi();
	const maybe = factory(mock.pi);
	if (maybe && typeof (maybe as Promise<void>).then === "function") {
		await maybe;
	}
	return { error: undefined as string | undefined, tools: mock.tools, commands: mock.commands, onCount: mock.onCount, abs };
}

// Pre-load all extensions once (imports are cached by Bun, so re-importing in
// individual tests is fine, but loading once here gives us the cross-extension
// conflict view).
const allLoaded = await Promise.all(
	ENTRIES.map(async (entry) => {
		const r = await loadExtension(entry.entry);
		return { ...r, entry };
	}),
);

describe("extension-contract: every manifest extension", () => {
	test("(a) every factory loads without throwing", () => {
		const failed = allLoaded.filter((r) => r.error);
		if (failed.length) {
			throw new Error(
				`${failed.length} extension(s) failed to load:\n` +
					failed.map((r) => `  ${r.entry.name}: ${r.error}`).join("\n"),
			);
		}
	});

	test("(b) every extension wires up (>=1 tool, command, or event handler)", () => {
		const unwired = allLoaded.filter((r) => r.tools.length === 0 && r.commands.length === 0 && r.onCount === 0);
		if (unwired.length) {
			throw new Error(
				`${unwired.length} extension(s) wired nothing:\n` +
					unwired.map((r) => `  ${r.entry.name}`).join("\n"),
			);
		}
	});

	test("(c) no cross-extension tool-name conflicts (same-file aliases excluded)", () => {
		const toolOwners = new Map<string, Map<string, string[]>>();
		for (const r of allLoaded) {
			for (const tool of r.tools) {
				const name = String(tool.name ?? "?");
				if (!toolOwners.has(name)) toolOwners.set(name, new Map());
				const byPath = toolOwners.get(name)!;
				const exts = byPath.get(r.abs) ?? [];
				exts.push(r.entry.name);
				byPath.set(r.abs, exts);
			}
		}
		const conflicts: string[] = [];
		for (const [name, byPath] of toolOwners) {
			if (byPath.size > 1) {
				const owners = [...byPath.values()].flat();
				conflicts.push(`${name}: [${owners.join(", ")}]`);
			}
		}
		expect(conflicts).toEqual([]);
	});

	test("(d) every registered tool has a name, label, and description", () => {
		const broken: string[] = [];
		for (const r of allLoaded) {
			for (const tool of r.tools) {
				const name = String(tool.name ?? "");
				if (!name) broken.push(`${r.entry.name}: tool with empty name`);
				if (!tool.label) broken.push(`${r.entry.name}/${name}: missing label`);
				if (!tool.description) broken.push(`${r.entry.name}/${name}: missing description`);
			}
		}
		expect(broken).toEqual([]);
	});

	test("(e) every registered command has a handler function", () => {
		const broken: string[] = [];
		for (const r of allLoaded) {
			for (const cmd of r.commands) {
				if (typeof cmd.handler !== "function") {
					broken.push(`${r.entry.name}/${cmd.name}: handler is ${typeof cmd.handler}`);
				}
			}
		}
		expect(broken).toEqual([]);
	});
});
