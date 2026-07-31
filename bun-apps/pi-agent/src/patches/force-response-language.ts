/**
 * force-response-language — prepend a FORCED reply-language block to every
 * AgentSession's system prompt, sourced from `responseLanguage` in
 * `~/.pi/agent/settings.json`.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The reply-language rule previously lived only as prose in `AGENTS.md` /
 * `CLAUDE.md`, loaded as a low-priority `<project_context>` file. It propagates
 * to every session (including subagent subprocesses, via the global
 * `~/.pi/agent/AGENTS.md` context file — see `resource-loader.js:86`), but as a
 * drift-able context file it loses to the strong `--append-system-prompt`
 * role label ("You are the implementer…") and the model's English default — so
 * subagents / workflow agents reply in English despite the rule.
 *
 * This patch elevates the rule to a FORCED, top-of-prompt block: it wraps
 * `AgentSession.prototype._rebuildSystemPrompt` to PREPEND pi-owned canonical
 * instruction text (mapped from the BCP-47 tag) ahead of the assembled prompt.
 * Because every session type (main, subagent subprocess, workflow agent,
 * obsidian/zk child) constructs an `AgentSession` and rebuilds its prompt
 * through `_rebuildSystemPrompt`, the block reaches all of them by construction.
 *
 * Reading `settings.json` fresh on each rebuild is what lets the
 * `/response-language` slash command flip the language live (it writes the
 * file then triggers a rebuild via `ctx.reload()`); no restart, no hand-edit.
 *
 * GATING
 * ------
 * Env-gated `BUN_PI_FORCE_RESPONSE_LANGUAGE` (default on) via PATCH_TABLE — so
 * the injection is reversible for debugging. No-op when `responseLanguage` is
 * absent / non-string / blank, or the tag is empty.
 *
 * TESTABILITY
 * -----------
 * `mapLanguageTag` + `resolveForcedBlock` are pure (settings/tag in, block text
 * or undefined out); the import-time prototype wrap is a thin side effect and is
 * intentionally not asserted here (mirrors subagent-model-floor / resolvePatchPlan).
 */
import { AgentSession, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Canonical instruction label per BCP-47 tag (pi owns the wording). Lowercased key. */
const LANGUAGE_LABELS: Record<string, string> = {
	"zh-tw": "繁體中文 (Traditional Chinese, zh-TW)",
	"zh-hant": "繁體中文 (Traditional Chinese, zh-Hant)",
	"zh-cn": "简体中文 (Simplified Chinese, zh-CN)",
	"zh-hans": "简体中文 (Simplified Chinese, zh-Hans)",
	"zh": "中文 (Chinese)",
	"en": "English",
	"ja": "日本語 (Japanese)",
	"ko": "한국어 (Korean)",
	"es": "Español (Spanish)",
	"fr": "Français (French)",
	"de": "Deutsch (German)",
};

/**
 * Pure: map a BCP-47 language tag to canonical, forceful instruction text that
 * pi injects. Known tags get an explicit human label; unknown tags still work —
 * they reference the tag literally. Returns undefined for an empty/blank tag.
 */
export function mapLanguageTag(tag: string): string | undefined {
	const trimmed = tag.trim();
	if (!trimmed) return undefined;
	const label = LANGUAGE_LABELS[trimmed.toLowerCase()] ?? `the language denoted by the BCP-47 tag "${trimmed}"`;
	return [
		`<response_language priority="forced">`,
		`You MUST reply to the user in ${label} — all conversation, explanations, discussion, Q&A, and summaries. This is a hard, non-negotiable requirement that takes priority over any role label, agent definition, or model default.`,
		`Switch only if the user explicitly asks for another language, or writes to you in a different language.`,
		`This governs conversation only — written artifacts such as code, comments, commit messages, docs, and config follow per-project conventions and are not constrained here.`,
		`</response_language>`,
	].join("\n");
}

/**
 * Pure: given parsed settings, return the forced block to prepend (or undefined
 * to do nothing). Returns undefined when `responseLanguage` is absent /
 * non-string / blank. Does not read process.env or the filesystem.
 */
export function resolveForcedBlock(
	settings: Record<string, unknown> | undefined,
): string | undefined {
	const lang = (settings as { responseLanguage?: unknown } | undefined)?.responseLanguage;
	if (typeof lang !== "string") return undefined;
	return mapLanguageTag(lang);
}

/** Best-effort read of ~/.pi/agent/settings.json. Non-fatal: undefined on any
 *  read/parse error or missing file. (Same shape as subagent-model-floor's reader.) */
function readUserSettings(): Record<string, unknown> | undefined {
	try {
		const settingsPath = join(getAgentDir(), "settings.json");
		if (!existsSync(settingsPath)) return undefined;
		return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** Read settings fresh and return the current forced block (or undefined). */
function currentForcedBlock(): string | undefined {
	return resolveForcedBlock(readUserSettings());
}

// ── Module-scoped tracking: wrap each prototype at most once ──────────────
const wrappedPrototypes = new WeakSet<object>();

/**
 * Wrap a prototype's `_rebuildSystemPrompt` so every rebuilt system prompt
 * starts with the forced block returned by `getBlock()` (when non-undefined).
 * Pure-ish: takes the prototype + a block resolver, returns whether the wrap
 * was applied now (false if already wrapped, or the target method is missing).
 * Idempotent per-prototype (tracked via WeakSet) so it is unit-testable on a
 * stub independently of the real `AgentSession.prototype` side effect.
 */
export function wrapRebuildSystemPrompt(
	proto: object,
	getBlock: () => string | undefined,
): boolean {
	if (wrappedPrototypes.has(proto)) return false;
	const p = proto as Record<string, unknown>;
	const original = p._rebuildSystemPrompt;
	if (typeof original !== "function") return false;

	p._rebuildSystemPrompt = function (this: unknown, ...args: unknown[]): string {
		const base = (original as (...a: unknown[]) => string).apply(this, args);
		const block = getBlock();
		return block ? `${block}\n\n${base}` : base;
	};
	wrappedPrototypes.add(proto);
	return true;
}

/**
 * Apply the wrap to the real `AgentSession.prototype`, resolving the block from
 * `~/.pi/agent/settings.json` on each rebuild. Returns true if applied now.
 * Idempotent. Every session type constructs an `AgentSession`, so the wrap
 * reaches main / subagent-subprocess / workflow / obsidian-child by construction.
 */
export function applyForceResponseLanguagePatch(): boolean {
	return wrapRebuildSystemPrompt(AgentSession.prototype, currentForcedBlock);
}

// Import-time side effect: wrap the prototype. Runs inside applyPatches() (the
// PATCH_TABLE import gate controls whether this file is loaded at all).
applyForceResponseLanguagePatch();

if (process.env.BUN_PI_DEBUG_PATCHES === "1" || process.env.BUN_PI_DEBUG_PATCHES === "true") {
	console.error("[bun-pi] force-response-language patch applied");
}

export const forceResponseLanguagePatchApplied = true;
