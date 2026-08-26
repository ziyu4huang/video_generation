/**
 * Isolated completion auditor — runs in a fresh pi agent session with no
 * extensions/skills/prompts/themes, read-only tools only.
 *
 * Clean-room port from ../pi-goal-list-loop-audit/extensions/goal-loop-auditor.ts
 * (read-only mentor). LAZY-IMPORTED by goal.ts so default sessions pay zero
 * import cost — the auditor module is only pulled in when an audit runs.
 *
 * Safety floors (non-negotiable, ported verbatim):
 *   1. must-call-a-read-tool (an approval with zero read tools → disapproval)
 *   2. silent-failure → error, not verdict (empty/no-marker output is infra)
 *   3. 10-min stall abort → error (never an unbounded hang, never a verdict)
 *   4. three-way verdict (approved/disapproved/impossible)
 *   5. regression_shield (approval w/o per-item evidence → disapproval)
 *   6. exception → error, not verdict
 *
 * Model-auth: reuses the PARENT's ModelRuntime (ctx.modelRegistry.runtime) so
 * extension-registered providers auth. NOTE: in pi 0.82.0 `ModelRegistry.runtime`
 * is declared `private readonly` (despite being a plain field at runtime), so the
 * access below uses an `as unknown as { runtime: ModelRuntime }` narrowing — this
 * is NOT an `as any` and is the only way to read the field at the type level.
 */

import {
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionResult,
	type ExtensionContext,
	type ModelRuntime,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { ActiveGoal } from "./format.js";
import { checkRegressionShield, parseAuditorVerdict, type GoalAuditorResult } from "./shield.js";

/**
 * Opaque model type. The auditor only reads `.id` (for labels) and forwards
 * the value to {@link createAgentSession}. Derived from the real consumer so
 * it stays structurally compatible WITHOUT a `@earendil-works/pi-ai` dependency
 * — same rationale overflow.ts uses to inline pi-ai types locally.
 */
type AuditorModel = NonNullable<Parameters<typeof createAgentSession>[0]>["model"];

export const AUDITOR_STALL_MS = 10 * 60_000; // 10-min inactivity → abort → error
export const AUDIT_MAX_RETRIES = 3;           // consecutive disapprovals before escalate-to-user
export const AUDIT_HISTORY_CAP = 8;           // max audit results retained on the goal

/**
 * The auditor's read-only tool grant (ticket 01: bash REMOVED). The auditor
 * verifies completion by READING the tree; `bash` here was a write escape
 * hatch guarded only by prompt-level "Never modify files". The must-call-
 * read-tool floor is unaffected. Test-pinned — extend only with tools that
 * cannot mutate the tree.
 */
export const AUDITOR_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface AuditProgress {
	recentOutput: string[];
	toolCalls: Array<{ name: string; argsPrefix: string; finishedAt: number }>;
}
export type AuditorProgressCallback = (progress: AuditProgress) => void;

/** A session factory (the real createAgentSession by default; faked in tests). */
export type SessionFactory = (opts: {
	cwd: string;
	model: AuditorModel;
	modelRuntime: ModelRuntime;
	resourceLoader: ResourceLoader;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	tools: string[];
}) => Promise<CreateAgentSessionResult>;

export interface AuditRunnerArgs {
	ctx: ExtensionContext;
	goal: ActiveGoal;
	completionSummary?: string | null;
	/** Override the auditor model; defaults to the session model. */
	model?: AuditorModel;
	/** Test seam: inject a fake session factory. */
	sessionFactory?: SessionFactory;
	signal?: AbortSignal;
	onProgress?: AuditorProgressCallback;
}

function makeAuditorResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => [
			"You are a read-only completion auditor running in an isolated pi agent session.",
			"Inspect the repository and decide whether the claimed goal completion is genuinely satisfied.",
			"Never modify files. Never approve unless the actual user objective is complete.",
		].join("\n"),
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function buildGoalAuditorPrompt(goal: ActiveGoal, completionSummary: string | null | undefined): string {
	return [
		"You are the independent completion auditor for ext-task.",
		"The executor claims the goal is complete. Decide whether the user's objective is actually satisfied.",
		"Be skeptical and semantic. Do not approve from paperwork, intent, file count, word count, build success, or a plausible summary alone.",
		"Use read/grep/find/ls to inspect real artifacts. Do not mutate files or run destructive commands.",
		"If the work is an alpha scaffold, generated template, shallow draft, or lacks the user-facing value requested, disapprove.",
		"If any explicit requirement is missing, weakly verified, contradicted, or not inspectable, disapprove.",
		"Return a concise audit report. The final line MUST be exactly one of:",
		"<approved/>",
		"<disapproved/>",
		"<impossible>one-line reason</impossible>",
		"Use <impossible> ONLY when the objective can NEVER be satisfied as stated. Incomplete/shoddy work is <disapproved/>, not impossible.",
		"",
		"Goal objective:",
		"<goal>",
		goal.text,
		"</goal>",
		"",
		"Executor completion claim:",
		"<completion_summary>",
		(completionSummary?.trim() || "(none provided)"),
		"</completion_summary>",
		...(goal.verificationContract?.trim() ? [
			"",
			"Goal verification contract (what the executor was required to verify):",
			"<verification_contract>",
			goal.verificationContract.trim(),
			"</verification_contract>",
			"",
			"REGRESSION SHIELD (mandatory because this goal has a verification contract):",
			"Your report MUST contain an <evidence> section. For EACH contract item,",
			"quote the item, then paste the RAW tool output that proves it. Format:",
			"",
			"<evidence>",
			"Item: <contract item>",
			"Output:",
			"<raw command output>",
			"</evidence>",
			"",
			"An approval without a complete <evidence> section will be rejected automatically.",
		] : []),
	].join("\n");
}

/** Best-effort extraction of the ModelRuntime from pi's ModelRegistry. pi
 *  exposes no public API for this, so we reach the `runtime` field by cast;
 *  if a pi rename removes/renames it, this returns undefined (caught by the
 *  caller) rather than throwing opaquely. */
function extractModelRuntime(registry: unknown): ModelRuntime | undefined {
	const rt = (registry as Record<string, unknown> | null | undefined)?.runtime;
	return typeof rt === "object" && rt !== null ? (rt as ModelRuntime) : undefined;
}

function modelLabel(model: AuditorModel | undefined): string {
	if (!model) return "(unset)";
	if (typeof model === "string") return model;
	if (model && typeof model === "object" && "id" in model) return (model as { id: string }).id;
	return "(unknown model)";
}

export async function runGoalCompletionAuditor(args: AuditRunnerArgs): Promise<GoalAuditorResult> {
	const { ctx } = args;
	const model = args.model ?? (ctx as { model?: AuditorModel }).model;
	if (!model) {
		return { approved: false, disapproved: false, output: "", model: "(unset)", error: "no model (session model also unset)" };
	}
	const sessionFactory: SessionFactory = args.sessionFactory ?? (async (opts) => createAgentSession(opts));
	const outputParts: string[] = [];
	const toolCalls: AuditProgress["toolCalls"] = [];
	let currentTool: string | undefined;
	let currentToolArgs: string | undefined;
	let streamError: string | undefined;

	try {
		const modelRuntime = extractModelRuntime(ctx.modelRegistry);
		if (!modelRuntime) {
			return { approved: false, disapproved: false, output: "", model: modelLabel(model),
				error: "ModelRegistry.runtime unavailable on this pi version — completion auditor disabled" };
		}
		const { session } = await sessionFactory({
			cwd: ctx.cwd,
			model,
			modelRuntime,
			resourceLoader: makeAuditorResourceLoader(),
			sessionManager: SessionManager.inMemory(ctx.cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: true } }),
			tools: [...AUDITOR_TOOLS],
		});

		// Stall watchdog: no session event for AUDITOR_STALL_MS → abort → error.
		let lastEventAt = Date.now();
		let stalled = false;
		const stallTimer = setInterval(() => {
			if (Date.now() - lastEventAt > AUDITOR_STALL_MS) { stalled = true; void session.abort(); }
		}, 15_000);
		stallTimer.unref?.();

		const unsub = session.subscribe((event: any) => {
			lastEventAt = Date.now();
			if (event.type === "error" || event.error || event.type === "auto_retry_start") {
				const msg = event.error?.message ?? event.message ?? event.errorMessage;
				if (typeof msg === "string") streamError = msg.slice(0, 300);
			}
			if (event.type === "tool_execution_start") {
				currentTool = event.toolName;
				currentToolArgs = typeof event.args === "object" && event.args !== null
					? JSON.stringify(event.args).slice(0, 120) : String(event.args ?? "").slice(0, 120);
				return;
			}
			if (event.type === "tool_execution_end") {
				if (currentTool) toolCalls.push({ name: currentTool, argsPrefix: currentToolArgs ?? "", finishedAt: Date.now() });
				currentTool = undefined; currentToolArgs = undefined;
				return;
			}
			if (event.type === "message_end") {
				const message = event.message;
				if (message?.role !== "assistant") return;
				if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.trim()) {
					streamError = message.errorMessage.slice(0, 300);
				}
				for (const part of message.content ?? []) {
					if (part.type === "text" && typeof part.text === "string") outputParts.push(part.text);
				}
			}
		});
		const onAbort = () => { session.abort(); };
		args.signal?.addEventListener("abort", onAbort, { once: true });

		args.onProgress?.({ recentOutput: [], toolCalls });

		try {
			if (args.signal?.aborted) {
				return { approved: false, disapproved: false, output: "", model: modelLabel(model), error: "Auditor aborted." };
			}
			await session.prompt(buildGoalAuditorPrompt(args.goal, args.completionSummary));
		} finally {
			clearInterval(stallTimer);
			unsub();
			args.signal?.removeEventListener("abort", onAbort);
		}

		if (stalled) {
			return { approved: false, disapproved: false, output: outputParts.join("\n\n"), model: modelLabel(model),
				error: `Auditor stalled — no activity for ${Math.round(AUDITOR_STALL_MS / 60_000)}m, aborted. Infrastructure failure, not a verdict.` };
		}

		const output = outputParts.join("\n\n");
		if (!output.trim()) {
			return { approved: false, disapproved: false, output, model: modelLabel(model),
				error: `Auditor produced no output${streamError ? `: ${streamError}` : " — check the model's auth/quota."}` };
		}

		const parsed = parseAuditorVerdict(output);
		if (!parsed.approved && !parsed.disapproved && !parsed.impossible) {
			return { approved: false, disapproved: false, output, model: modelLabel(model),
				error: `Auditor produced no verdict marker${streamError ? ` — stream error: ${streamError}` : ""}. Treated as error, not a verdict.` };
		}

		const usedReadTool = toolCalls.some((c) => (AUDITOR_TOOLS as readonly string[]).includes(c.name));
		if (parsed.approved && !usedReadTool) {
			return { approved: false, disapproved: true, output, model: modelLabel(model),
				error: "Auditor approved without calling any read tool; treated as disapproved." };
		}

		// Safety floor #5: regression_shield (approval w/o per-item evidence → disapproval).
		// NOTE: This floor is INERT-by-design. It can never fire because
		// goal.verificationContract is never set by any command/flag.
		// Activation would require wiring a /goal --verify flag (left as a
		// separate future decision; see ticket 06, option b).
		// Refs: .planning/2026-08-02-core-task-review/tickets/06-regression-shield-activation.md
		if (parsed.approved && args.goal.verificationContract?.trim()) {
			const shield = checkRegressionShield(output, args.goal.verificationContract);
			if (!shield.passed) {
				const why = !shield.hasEvidenceBlock ? "report has no <evidence> block"
					: `evidence does not address: ${shield.missingItems.join("; ")}`;
				return { approved: false, disapproved: true, output, model: modelLabel(model),
					error: `regression_shield: approved but ${why}`,
					regressionShieldPassed: false, regressionShieldMissing: shield.missingItems };
			}
			return { approved: true, disapproved: false, impossible: parsed.impossible, impossibleReason: parsed.impossibleReason,
				output, model: modelLabel(model), regressionShieldPassed: true };
		}

		return { approved: parsed.approved, disapproved: parsed.disapproved, impossible: parsed.impossible,
			impossibleReason: parsed.impossibleReason, output, model: modelLabel(model) };
	} catch (err) {
		// Exception is INFRASTRUCTURE, never a verdict (error && !disapproved).
		return { approved: false, disapproved: false, output: "", model: modelLabel(model),
			error: err instanceof Error ? err.message : String(err) };
	}
}
