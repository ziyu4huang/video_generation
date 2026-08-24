/**
 * force-response-language — prepend a FORCED reply-language block to every
 * AgentSession's system prompt PER TURN, sourced from `responseLanguage` in
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
 * `AgentSession.prototype._installAgentNextTurnRefresh` (called in every
 * AgentSession constructor) to RE-WRAP `this.agent.prepareNextTurnWithContext`
 * — the per-turn context builder — so EVERY turn's `context.systemPrompt`
 * starts with the forced block (re-reading settings.json fresh each turn).
 * Because every session type (main, subagent subprocess, workflow agent,
 * obsidian/zk child) constructs an `AgentSession`, the per-turn injection
 * reaches all of them by construction.
 *
 * Reading `settings.json` fresh on each turn is what lets the
 * `/response-language` slash command flip the language live (it just writes the
 * file — the next turn picks up the new block; no reload, no restart, no
 * hand-edit). Per-turn (not cached) also avoids stale/duplicate blocks when the
 * language changes mid-session.
 *
 * GATING
 * ------
 * Env-gated `BUN_PI_FORCE_RESPONSE_LANGUAGE` (default on) via PATCH_TABLE — so
 * the injection is reversible for debugging. No-op when `responseLanguage` is
 * absent / non-string / blank, or the tag is empty.
 *
 * ASK_USER_LANGUAGE (Stage 1: content hardening)
 * ----------------------------------------------
 * This patch ALSO emits an `<ask_user_language>` block sourced from the
 * independent `askUserLanguage` setting — STRICTLY fixing the language of
 * ask_user_question CONTENT (question/header/labels/descriptions/previews),
 * OVERRIDING responseLanguage for that content only. Because a second prototype
 * wrap is blocked by the WeakSet + WRAP_TAG guard (wrapInstallAgentNextTurnRefresh
 * is idempotent per-prototype), BOTH blocks ride the SAME single per-turn wrap:
 * currentForcedBlock() → resolveCombinedForcedBlock() returns response block
 * FIRST + ask-user block second (joined by a blank line). The ask-user block has
 * its OWN env gate `BUN_PI_FORCE_ASK_USER_LANGUAGE` (default on), read in-file
 * via envFlag — independent of the file-level import gate, so it can be toggled
 * without disabling the response block. Byte-identical no-op when askUserLanguage
 * is unset (the combined block equals today's response-only block exactly).
 *
 * TESTABILITY
 * -----------
 * `mapLanguageTag` + `resolveForcedBlock` are pure (settings/tag in, block text
 * or undefined out); `wrapInstallAgentNextTurnRefresh` is pure-ish (prototype +
 * block resolver in, applied-now boolean out) and unit-testable on a stub. The
 * import-time prototype wrap is a thin side effect and is intentionally not
 * asserted here (mirrors subagent-model-floor / resolvePatchPlan).
 */
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { envFlag, isPatchDebug } from "./index.ts";
import { readAgentSettings } from "../paths.ts";

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
 * Pure: map a BCP-47 language tag to the FORCED ask_user_question CONTENT block.
 * This STRICTLY fixes the language of everything the model authors via the
 * ask_user_question tool (question text, headers, option labels, option
 * descriptions, previews) INDEPENDENTLY of responseLanguage — and OVERRIDES
 * responseLanguage for ask_user_question content ONLY. Conversation replies
 * still follow responseLanguage. Mirrors mapLanguageTag (shares LANGUAGE_LABELS)
 * but emits an <ask_user_language> block with the explicit "overrides
 * response_language" wording. Returns null for an empty/blank tag.
 */
export function mapAskUserLanguageTag(tag: string): { block: string } | null {
	const trimmed = tag.trim();
	if (!trimmed) return null;
	const label = LANGUAGE_LABELS[trimmed.toLowerCase()] ?? `the language denoted by the BCP-47 tag "${trimmed}"`;
	const block = [
		`<ask_user_language priority="forced" overrides="response_language">`,
		`For ALL content you author via the ask_user_question tool — question text, headers, option labels, option descriptions, and previews — you MUST use ${label} (${trimmed.toLowerCase()}). This OVERRIDES response_language for ask_user_question content ONLY. Conversation replies still follow response_language.`,
		`</ask_user_language>`,
	].join("\n");
	return { block };
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

/**
 * Given parsed settings, return the FORCED ask_user_question content block (or
 * null to do nothing). Reads the `askUserLanguage` key INDEPENDENTLY of
 * responseLanguage (mirrors how resolveForcedBlock reads responseLanguage).
 * Additionally gated by BUN_PI_FORCE_ASK_USER_LANGUAGE (default ON) via envFlag
 * — a gate independent of the file-level BUN_PI_FORCE_RESPONSE_LANGUAGE import
 * gate, so ask-user can be disabled without disabling the response block. Returns
 * null when `askUserLanguage` is absent / non-string, the tag is empty, or the
 * gate is OFF. Reads process.env (via envFlag) — NOT pure-re-settings.
 */
export function resolveAskUserForcedBlock(settings: unknown): string | null {
	if (!envFlag("BUN_PI_FORCE_ASK_USER_LANGUAGE", true)) return null;
	const lang = (settings as { askUserLanguage?: unknown } | undefined)?.askUserLanguage;
	if (typeof lang !== "string") return null;
	return mapAskUserLanguageTag(lang)?.block ?? null;
}

/**
 * Pure-ish combiner (modulo envFlag read inside resolveAskUserForcedBlock): given
 * parsed settings, return the COMBINED per-turn block to prepend — response
 * block FIRST, then the ask-user block (when set AND its gate on), joined by a
 * blank line. If the ask-user block is null, returns the response block
 * UNCHANGED (byte-identical to today's response-only behavior). If the response
 * block is null but the ask-user block is set, returns the ask-user block alone.
 * Returns undefined when NEITHER resolves — the wrap's getBlock then does
 * nothing. This is the resolver wired into wrapInstallAgentNextTurnRefresh via
 * currentForcedBlock; exported so the combining logic (incl. the byte-identical
 * no-op guarantee when askUserLanguage is unset) is directly unit-testable
 * without touching the filesystem.
 */
export function resolveCombinedForcedBlock(
	settings: Record<string, unknown> | undefined,
): string | undefined {
	const responseBlock = resolveForcedBlock(settings);
	const askUserBlock = resolveAskUserForcedBlock(settings);
	if (askUserBlock && responseBlock) return `${responseBlock}\n\n${askUserBlock}`;
	if (askUserBlock) return askUserBlock;
	return responseBlock;
}

/** Read settings fresh and return the current COMBINED forced block (or
 *  undefined). Per-turn (re-reads settings.json) so /response-language and
 *  /ask-user-language both flip live with no reload. */
function currentForcedBlock(): string | undefined {
	return resolveCombinedForcedBlock(readAgentSettings());
}

// ── Module-scoped tracking ───────────────────────────────────────────────
const wrappedPrototypes = new WeakSet<object>();
/** Tag stamped on our per-agent wrapper: if the original `_installAgentNextTurnRefresh`
 *  re-assigns the per-turn fn, we re-wrap the (untagged) original instead of
 *  chaining wrappers / double-prepending the block. */
const WRAP_TAG = Symbol("forceResponseLanguage");

/**
 * Wrap a prototype's `_installAgentNextTurnRefresh` so every turn's system
 * prompt starts with the forced block. Per-turn (not cached): the original
 * `_installAgentNextTurnRefresh` assigns `this.agent.prepareNextTurnWithContext`
 * (the per-turn context builder, agent-session.js:262); we run it, then re-wrap
 * that per-turn function to prepend the block returned by `getBlock()` (re-
 * reading settings.json fresh each turn — so /response-language flips live with
 * no reload). Idempotent per-prototype (WeakSet) and per-agent (function tag).
 *
 * Pure-ish: takes the prototype + a block resolver; returns whether the
 * prototype wrap was applied now (false if already wrapped, or the target
 * method is missing). Unit-testable on a stub independently of the real
 * AgentSession side effect.
 */
export function wrapInstallAgentNextTurnRefresh(
	proto: object,
	getBlock: () => string | undefined,
): boolean {
	if (wrappedPrototypes.has(proto)) return false;
	const p = proto as Record<string, unknown>;
	const original = p._installAgentNextTurnRefresh;
	if (typeof original !== "function") return false;

	p._installAgentNextTurnRefresh = function (this: unknown, ...args: unknown[]): void {
		(original as (...a: unknown[]) => void).apply(this, args);
		// The original just (re-)assigned this.agent.prepareNextTurnWithContext — wrap it
		// unless it's already our wrapper (tagged), so a re-install re-wraps the original
		// rather than chaining / double-prepending.
		const self = this as { agent?: object | undefined };
		const agent = self.agent;
		if (!agent) return;
		const agentRec = agent as { prepareNextTurnWithContext?: (...a: unknown[]) => unknown };
		const current = agentRec.prepareNextTurnWithContext;
		if (typeof current !== "function") return;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		if ((current as any)[WRAP_TAG] === true) return;
		const origPrep = current;

		const wrapped = async function (...prepArgs: unknown[]): Promise<unknown> {
			const snapshot = (await origPrep.apply(agent, prepArgs)) as
				| { context?: { systemPrompt?: string } | undefined }
				| undefined;
			const block = getBlock();
			const ctx = snapshot?.context;
			if (block && ctx && typeof ctx.systemPrompt === "string") {
				snapshot!.context = { ...ctx, systemPrompt: `${block}\n\n${ctx.systemPrompt}` };
			}
			return snapshot;
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(wrapped as any)[WRAP_TAG] = true;
		agentRec.prepareNextTurnWithContext = wrapped;
	};
	wrappedPrototypes.add(proto);
	return true;
}

/**
 * Apply the wrap to the real `AgentSession.prototype`. `_installAgentNextTurnRefresh`
 * runs in every AgentSession constructor (agent-session.js:156), so the per-turn
 * injection reaches main / subagent-subprocess / workflow / obsidian-child by
 * construction. Returns true if applied now. Idempotent.
 */
export function applyForceResponseLanguagePatch(): boolean {
	return wrapInstallAgentNextTurnRefresh(AgentSession.prototype, currentForcedBlock);
}

// Import-time side effect: wrap the prototype. Runs inside applyPatches() (the
// PATCH_TABLE import gate controls whether this file is loaded at all).
const outcome = applyForceResponseLanguagePatch();

if (isPatchDebug()) {
	console.error(`[bun-pi] force-response-language patch ${outcome ? "applied" : "DID NOT BIND"}`);
}

/**
 * Outcome, not intent — read by `readPatchOutcome()` in ./index.ts.
 *
 * `wrapInstallAgentNextTurnRefresh` returns false when
 * `AgentSession.prototype._installAgentNextTurnRefresh` is missing, i.e. when
 * the pinned pi core moved under us. This module used to discard that boolean,
 * print "patch applied" unconditionally under debug, and export a hardcoded
 * `true` — the two failure modes ./index.ts `readPatchOutcome` was written to
 * end. The reply language would have silently stopped being forced while every
 * check reported success.
 */
export const patchApplied = outcome;
