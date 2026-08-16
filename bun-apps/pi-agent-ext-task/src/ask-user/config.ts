/**
 * Config I/O for ask_user_question.
 *
 * Ported from rpiv-ask-user-question config.ts, with rpiv-config utilities
 * inlined (previously imported from @juicesharp/rpiv-config).
 *
 * Key changes vs upstream:
 * - `configPath` simplified: reads from `~/.config/rpiv-ask-user-question/config.json`
 * - `loadJsonConfig` inlined from rpiv-config
 * - `validateGuidanceFields` inlined from rpiv-config
 * - `GuidanceFields` type defined locally
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config path
// ---------------------------------------------------------------------------

function configPath(name: string, file: string = "config.json"): string {
	return join(homedir(), ".config", name, file);
}

const CONFIG_PATH = configPath("rpiv-ask-user-question");

// --- test seam (deterministic config-path injection) --------------------------
// CONFIG_PATH is resolved at module load via os.homedir(), and Bun's homedir()
// ignores process.env.HOME at runtime (Node respects it) — so a test cannot
// redirect the path by setting HOME, and a divergence between the module's
// read path and a test's write path causes intermittent failures. Worse, the
// real path is ~/.config (real host state). This seam lets tests point both the
// read and the write at a tmpdir. Null = use the real resolved path.
let __configPathOverride: string | null = null;
/** @internal test-only override of the config path (pass null to restore). */
export function __setConfigPathForTest(p: string | null): void {
	__configPathOverride = p;
}
function activeConfigPath(): string {
	return __configPathOverride ?? CONFIG_PATH;
}

// ---------------------------------------------------------------------------
// Guidance fields (inlined from rpiv-config)
// ---------------------------------------------------------------------------

export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object") return {};
	const g = fields as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof g.promptSnippet === "string" && g.promptSnippet.length > 0) {
		result.promptSnippet = g.promptSnippet;
	}
	if (
		Array.isArray(g.promptGuidelines) &&
		g.promptGuidelines.length > 0 &&
		g.promptGuidelines.every((s) => typeof s === "string" && s.length > 0)
	) {
		result.promptGuidelines = g.promptGuidelines;
	}
	return result;
}

// ---------------------------------------------------------------------------
// JSON config load (inlined from rpiv-config)
// ---------------------------------------------------------------------------

function loadJsonConfig<T>(path: string): T {
	if (!existsSync(path)) return {} as T;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {} as T;
		return parsed as T;
	} catch (err) {
		console.warn(`ask-user-config: invalid JSON at ${path}, using default ({}) — ${(err as Error).message}`);
		return {} as T;
	}
}

// ---------------------------------------------------------------------------
// Collapse key
// ---------------------------------------------------------------------------

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+]";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";

export interface AskUserQuestionConfig {
	guidance?: GuidanceFields;
	collapseKey?: CollapseKeySpec;
}

// Named keys accepted by pi-tui's `matchesKey`.
const SPECIAL_KEYS = new Set([
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete",
	"insert", "clear", "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isValidCollapseKeySpec(spec: string): boolean {
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1
		? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base)
		: SPECIAL_KEYS.has(base);
}

export function resolveCollapseKey(config: Pick<AskUserQuestionConfig, "collapseKey">): CollapseKeySpec {
	const raw = config.collapseKey?.trim().toLowerCase();
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

/**
 * Display spelling for the parts of a key spec. Specs are normalized to lower
 * case by `resolveCollapseKey`; humans read `Ctrl+]`, not `ctrl+]`.
 */
const KEY_DISPLAY: Record<string, string> = {
	ctrl: "Ctrl", shift: "Shift", alt: "Alt", super: "Super",
	esc: "Esc", escape: "Esc", enter: "Enter", return: "Return", tab: "Tab",
	space: "Space", backspace: "Backspace", delete: "Delete", insert: "Insert",
	clear: "Clear", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
	up: "↑", down: "↓", left: "←", right: "→",
};

/**
 * Render a resolved key spec for display, or `undefined` when the shortcut is
 * off.
 *
 * This is the ONLY place a key is spelled for a human. The footer hint used to
 * hard-code "Ctrl+]" while `ctx.ui.notify` printed the resolved spec, so
 * configuring `alt+o` produced a dialog that named two different keys — one of
 * them wrong. Both now read from here, which reads from the same spec
 * `key-router` matches against.
 *
 * `formatKeySpec(DEFAULT_COLLAPSE_KEY)` is exactly `"Ctrl+]"`, so the default
 * rendering is unchanged.
 */
export function formatKeySpec(spec: CollapseKeySpec): string | undefined {
	if (spec === COLLAPSE_KEY_OFF) return undefined;
	return spec
		.split("+")
		.map((part) => {
			const known = KEY_DISPLAY[part];
			if (known !== undefined) return known;
			// Function keys read as F5; a single character (letter or punctuation)
			// is upper-cased — `o` → `O`, `]` → `]`.
			if (/^f\d+$/.test(part)) return part.toUpperCase();
			return part.length === 1 ? part.toUpperCase() : part;
		})
		.join("+");
}

export function loadConfig(): AskUserQuestionConfig {
	return loadJsonConfig<AskUserQuestionConfig>(activeConfigPath());
}
