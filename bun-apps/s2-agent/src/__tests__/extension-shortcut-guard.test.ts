/**
 * extension-shortcut-guard — no registered extension shortcut may collide
 * with pi's BUILT-IN DEFAULT keybindings, and no two extensions may claim
 * the same key.
 *
 * Motivation: pi's conflict semantics hard-skip only a small RESERVED set
 * (submit/confirm/cancel/copy/followUp/deleteToLineEnd + a few app.*
 * actions). A collision with any NON-reserved built-in — e.g.
 * `tui.editor.cursorLeft`, whose default key is ctrl+b — lets the extension
 * CLAIM the key while pi emits a startup warning:
 *   "Extension shortcut conflict: 'ctrl+b' is built-in shortcut for
 *    tui.editor.cursorLeft and <inline:s2-agent-ext-subagent>."
 * s2-agent-ext-subagent's global detach did exactly that until it was
 * rebound to alt+s (see ADR-subagent-0004). This test makes that whole
 * failure class impossible to reintroduce: it fails the suite BEFORE any
 * runtime warning can appear.
 *
 * Coverage: EVERY registered extension, both registration surfaces —
 *   - the static set (STATIC_EXTENSION_FACTORIES in src/static-extensions.ts)
 *   - the dynamic set (src/run-dir/manifest.json extensions[], same loading
 *     pattern as extension-contract.test.ts)
 * Each factory is loaded through a recording mock pi whose registerShortcut
 * captures the key string.
 *
 * Built-in default key set = union of:
 *   - tui.* defaults, read at RUNTIME from @earendil-works/pi-tui's
 *     TUI_KEYBINDINGS (each id has a .defaultKeys array) — so a pi upgrade
 *     that changes defaults updates the guard automatically;
 *   - app.* defaults, hardcoded below from pi's docs/keybindings.md macOS
 *     table, because @earendil-works/pi-coding-agent's exports map blocks
 *     deep imports of its keybinding tables. If pi ever exports them,
 *     switch to the runtime import and delete the table.
 *
 * Key comparison is NORMALIZED (lowercase; split modifiers on "+", trim,
 * sort, rejoin) so representation drift is not a false negative:
 * "ctrl+alt+w" (Key.ctrlAlt) vs a hypothetical "alt+ctrl+w" both compare
 * equal, as do "shift+ctrl+p" vs "ctrl+shift+p".
 *
 * Run: bun test src/__tests__/extension-shortcut-guard.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { parseManifestEntries } from "../../src/run-dir/manifest-types.ts";
import { STATIC_EXTENSION_FACTORIES } from "../static-extensions.ts";
import { makeMockPi } from "./test-utils.ts";

// Self-sufficient: import the patch so repo-root node_modules symlinks exist
// (same reason as extension-contract.test.ts).
await import("../patches/ensure-extension-deps.ts");

const PI_AGENT_DIR = path.resolve(import.meta.dirname, "../..");
const REPO_ROOT = path.resolve(PI_AGENT_DIR, "../..");
const MANIFEST = JSON.parse(
	readFileSync(path.join(PI_AGENT_DIR, "src", "run-dir", "manifest.json"), "utf8"),
) as { extensions: (string | object)[] };
const DYNAMIC_ENTRIES = parseManifestEntries(MANIFEST.extensions ?? []);

/**
 * app.* built-in default keys (pi docs/keybindings.md, macOS table), as
 * registered by pi itself. NOT runtime-derived: the pi-coding-agent exports
 * map blocks deep imports of the app keybinding tables. Keep in sync with
 * pi's docs when upgrading @earendil-works/*.
 */
const APP_DEFAULT_KEYS = [
	"escape",
	"ctrl+c",
	"ctrl+d",
	"ctrl+z",
	"ctrl+g",
	"ctrl+v",
	"ctrl+p",
	"ctrl+s",
	"ctrl+n",
	"ctrl+r",
	"ctrl+backspace",
	"ctrl+l",
	"shift+ctrl+p",
	"shift+tab",
	"ctrl+t",
	"ctrl+o",
	"ctrl+x",
	"alt+enter",
	"alt+up",
	"ctrl+left",
	"alt+left",
	"ctrl+right",
	"alt+right",
	"shift+l",
	"shift+t",
	"ctrl+u",
	"ctrl+a",
	"shift+ctrl+o",
	"ctrl+shift+up",
	"ctrl+shift+down",
	"ctrl+shift+f",
] as const;

/** Normalize a key string for comparison: lowercase, sorted modifiers. */
function normalizeKey(key: string): string {
	return key
		.toLowerCase()
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean)
		.sort()
		.join("+");
}

/** normalized key → human-readable list of built-in ids owning that key. */
function buildBuiltinDefaultOwners(): Map<string, string[]> {
	const owners = new Map<string, string[]>();
	const add = (norm: string, label: string) => {
		const list = owners.get(norm) ?? [];
		list.push(label);
		owners.set(norm, list);
	};
	// NB: TUI_KEYBINDINGS[*].defaultKeys is an ARRAY for multi-key ids and a
	// plain STRING for single-key ids ("up", "enter", …) — normalize both.
	for (const [id, def] of Object.entries(TUI_KEYBINDINGS)) {
		const raw = def.defaultKeys;
		const keys = typeof raw === "string" ? [raw] : (raw ?? []);
		for (const key of keys) {
			add(normalizeKey(key), `${id} [${keys.join(", ")}]`);
		}
	}
	for (const key of APP_DEFAULT_KEYS) {
		add(normalizeKey(key), `app.* default [${key}] (docs/keybindings.md)`);
	}
	return owners;
}

interface ShortcutCapture {
	extension: string;
	key: string;
}

/** Load one factory (static entry or dynamic manifest entry) with the shared mock. */
async function captureShortcuts(
	extension: string,
	factory: unknown,
	sink: ShortcutCapture[],
): Promise<string | undefined> {
	if (typeof factory !== "function") {
		return `no default factory (got ${typeof factory})`;
	}
	try {
		const mock = makeMockPi();
		const maybe = (factory as (pi: unknown) => unknown)(mock.pi);
		if (maybe && typeof (maybe as Promise<void>).then === "function") {
			await maybe;
		}
		for (const s of mock.shortcuts) sink.push({ extension, key: s.key });
	} catch (err) {
		return `factory threw: ${err instanceof Error ? err.message : String(err)}`;
	}
	return undefined;
}

// Load every registered extension once and record all registerShortcut calls.
const captured: ShortcutCapture[] = [];
const loadErrors: string[] = [];

for (const { name, factory } of STATIC_EXTENSION_FACTORIES) {
	const err = await captureShortcuts(name, factory, captured);
	if (err) loadErrors.push(`${name}: ${err}`);
}
for (const entry of DYNAMIC_ENTRIES) {
	const abs = path.resolve(REPO_ROOT, "bun-apps", entry.entry);
	try {
		const mod = await import(abs);
		const err = await captureShortcuts(entry.name, mod.default, captured);
		if (err) loadErrors.push(`${entry.name}: ${err}`);
	} catch (err) {
		loadErrors.push(`${entry.name}: import failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

describe("extension-shortcut-guard: registered shortcuts vs pi built-in defaults", () => {
	test("(precondition) every registered extension loads under the recording mock", () => {
		expect(loadErrors).toEqual([]);
	});

	test("(precondition) the recording mock observed at least one shortcut", () => {
		// If this fails, factories stopped registering shortcuts at load time
		// (e.g. moved behind a lifecycle event) and this guard went blind —
		// extend the mock to fire the relevant event.
		expect(captured.length).toBeGreaterThan(0);
	});

	test("no extension shortcut collides with a pi built-in default key", () => {
		const owners = buildBuiltinDefaultOwners();
		const collisions: string[] = [];
		for (const { extension, key } of captured) {
			const norm = normalizeKey(key);
			const hits = owners.get(norm);
			if (hits) {
				collisions.push(
					`${extension}: registered shortcut '${key}' collides with pi built-in: ${hits.join("; ")}`,
				);
			}
		}
		expect(collisions).toEqual([]);
	});

	test("no two registered extensions claim the same shortcut", () => {
		const byKey = new Map<string, string[]>();
		for (const { extension, key } of captured) {
			const norm = normalizeKey(key);
			const list = byKey.get(norm) ?? [];
			list.push(`${extension} ('${key}')`);
			byKey.set(norm, list);
		}
		const duplicates: string[] = [];
		for (const [norm, claimers] of byKey) {
			if (claimers.length > 1) {
				duplicates.push(`'${norm}' claimed by: ${claimers.join(", ")}`);
			}
		}
		expect(duplicates).toEqual([]);
	});
});
