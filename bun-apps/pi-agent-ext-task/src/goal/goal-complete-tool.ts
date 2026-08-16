/**
 * goal-complete-tool.ts — the `goal_complete` tool the agent calls to close a
 * goal, plus the audit seam it runs through.
 *
 * Extracted from goal.ts (spec 1a), where its inline `defineTool({...})` was
 * roughly 290 lines — a fifth of the file, and the single largest thing in it.
 *
 * `auditRunner` came with it. The spec proposed moving it into `goalState`
 * alongside the overlay; it stayed a module-level binding here instead, because
 * unlike the overlay it has exactly one reader — the audit branch below — and it
 * is a TEST SEAM, not session state. Putting it in goalState would have meant
 * typing it `unknown` (its signature names pi's ExtensionContext, which state.ts
 * must not import) and casting at the call site, trading real types for a
 * uniformity nothing needed.
 */
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ActiveGoal } from "./format.js";
import { createGoal, goalState, transitionGoal, type GoalCompleteDetails } from "./state.js";
import { appendReviewerEntry, loadReviewerEntries, persistGoal } from "./persistence.js";
import { resolveReviewerConfig, runReviewer } from "./reviewer.js";
import { isQuotaError, parseQuotaError, scheduleQuotaRetry } from "./quota-retry.js";
import { addListItems, promoteNext } from "./list.js";
import { pushCapped, REPETITION } from "./repetition.js";
import type { GoalAuditorResult } from "./shield.js";
import type { StatusContext } from "./context.js";
import { isContradictoryCompletionSummary } from "./overflow.js";
import {
	cancelContinuationPending,
	currentTokenTotal,
	planningGateBlocking,
	showCompletionStatus,
} from "./internals.js";
import { clearActiveGoal, setAndPersistGoal } from "./status.js";
import { resumeGoal, updateGoalUsage } from "./lifecycle.js";

// ─── T04 opt-in auditor: test seam + module singleton ────────────────────────
// `auditRunner` is a module-level singleton so tests can inject a fake via the
// exported `__setAuditRunnerForTest` seam — the ONLY way to avoid invoking a
// real model. The default lazy-imports `runGoalCompletionAuditor` from
// ./auditor.js, which transitively imports createAgentSession from
// pi-coding-agent; the dynamic `import()` only resolves when an audit actually
// runs (inside the `if (completedGoal.auditEnabled)` guard in goal_complete),
// so default (non-audited) sessions pay ZERO import cost.

type AuditRunnerArgs = {
	ctx: ExtensionContext;
	goal: ActiveGoal;
	completionSummary: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Model is a broad union from pi-ai; the seam only forwards it to runGoalCompletionAuditor.
	model?: any;
};
type AuditRunner = (args: AuditRunnerArgs) => Promise<GoalAuditorResult>;

let auditRunner: AuditRunner = async (args) => {
	const { runGoalCompletionAuditor } = await import("./auditor.js");
	return runGoalCompletionAuditor(args);
};

/** Test seam: override the audit runner. Pass `undefined` to restore the default. */
export function __setAuditRunnerForTest(fn: AuditRunner | undefined): void {
	auditRunner =
		fn ??
		(async (args) => {
			const { runGoalCompletionAuditor } = await import("./auditor.js");
			return runGoalCompletionAuditor(args);
		});
}

/**
 * Parse a `"provider/id"` override string into a Model ref (best-effort; used
 * for the `--model` flag). The session's modelRegistry resolves provider/id via
 * the parent runtime; createAgentSession accepts a bare `{provider,id}` object.
 * A bare id (no slash) is returned as-is so a fully-qualified model string works too.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- Model is a broad union; a structural {provider,id} is the documented override shape. */
function parseModelRef(ref: string): any {
	const slash = ref.indexOf("/");
	if (slash < 1) return ref;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}
// ─── Tool definition ──────────────────────────────────────────────────────────

export const goalCompleteTool = defineTool({
	name: "goal_complete",
	gating: { core: true },
	label: "Goal Complete",
	description:
		"Mark the active /goal as complete after all required work is done and verified. Do not use for partial progress, blockers, failing, or unverified work.",
	parameters: Type.Object({
		summary: Type.String({
			description:
				"State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
		}),
	}),
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: (msg: any) => void, ctx: any) {
		let completedGoal = goalState.activeGoal;
		const goal = completedGoal?.text ?? "unknown goal";
		const summary = (params.summary as string).trim();

		if (!completedGoal) {
			const rejection = "Goal completion rejected: no active goal.";
			ctx.ui.notify(rejection, "warning");
			return {
				content: [{ type: "text", text: rejection }],
				details: { goal, summary } satisfies GoalCompleteDetails,
			};
		}

		const rejectionReason = !summary
			? "summary is empty"
			: isContradictoryCompletionSummary(summary)
				? "summary says the goal is not complete"
				: undefined;
		if (rejectionReason) {
			updateGoalUsage(completedGoal, ctx);
			setAndPersistGoal(completedGoal, ctx);
			const rejection = `Goal completion rejected: ${rejectionReason}.`;
			ctx.ui.notify(rejection, "warning");
			return {
				content: [{ type: "text", text: rejection }],
				details: { goal, summary } satisfies GoalCompleteDetails,
			};
		}

		// Plan A coordination seam: block goal_complete while the plan coordinator
		// reports open phases. The goal's own summary audit can't see plan state; this
		// closes the gap. Release valve: close the plan (→ __piPlanIncomplete returns
		// false). Best-effort: if no plan coordinator is loaded or it errors, the
		// gate is a no-op (goal_complete proceeds).
		const planningReason = planningGateBlocking(ctx.cwd);
		if (planningReason) {
			updateGoalUsage(completedGoal, ctx);
			setAndPersistGoal(completedGoal, ctx);
			const rejection =
				`Goal completion rejected: ${planningReason}. ` +
				"Finish the remaining plan phases, or close the plan, then call goal_complete again.";
			ctx.ui.notify(rejection, "warning");
			return {
				content: [{ type: "text", text: rejection }],
				details: { goal, summary } satisfies GoalCompleteDetails,
			};
		}

		// T04 opt-in auditor: gate completion on an isolated read-only audit.
		// The entire block is guarded by `auditEnabled`, so a non-audited goal's
		// goal_complete is byte-for-byte the pre-T04 path (the auditor module is
		// not even imported). D3 routing: approve/impossible → fall through to the
		// normal complete transition; disapprove → bounded re-loop (stay active,
		// return the finding, terminate:false so the agent self-corrects in-turn);
		// 3 consecutive disapprovals → pause + escalate; infra error → never
		// complete (let the agent/user retry).
		if (completedGoal.auditEnabled) {
			const { AUDIT_MAX_RETRIES, AUDIT_HISTORY_CAP } = await import("./auditor.js");
			ctx.ui.notify("Auditing completion…", "info");
			const auditResult = await auditRunner({
				ctx,
				goal: completedGoal,
				completionSummary: summary,
				model: completedGoal.auditorModel ? parseModelRef(completedGoal.auditorModel) : undefined,
			});
			// Cap the audit history on the goal (mutate a clone, reassign activeGoal,
			// persist) so the verdict trail survives compaction + is visible on the goal.
			completedGoal = {
				...completedGoal,
				auditHistory: pushCapped(completedGoal.auditHistory ?? [], auditResult, AUDIT_HISTORY_CAP),
			};
			goalState.activeGoal = completedGoal;
			persistGoal(goalState.extensionApi as ExtensionAPI, completedGoal);

			// Infrastructure error (error && !disapproved) → never complete; let the
			// agent/user retry. A disapprove WITH an error field is still a verdict.
			if (auditResult.error && !auditResult.disapproved) {
				// quota-retry (GLA faithful baseline): a 429/quota auditor error must NOT
				// loop — the default "re-verify" return re-fires goal_complete → auditor →
				// 429 → burn tokens. Pause + schedule a one-shot resume at Retry-After.
				if (isQuotaError(auditResult.error)) {
					const quota = parseQuotaError(auditResult.error);
					cancelContinuationPending();
					goalState.activeGoal = transitionGoal(completedGoal, "paused");
					setAndPersistGoal(goalState.activeGoal, ctx);
					scheduleQuotaRetry(ctx, quota.retryAfterSec, auditResult.error, () => resumeGoal((goalState.extensionApi as ExtensionAPI), ctx));
					return {
						content: [{ type: "text", text: `Goal audit hit a quota/rate limit — paused, auto-retry in ${Math.max(1, Math.round(quota.retryAfterSec / 60))}m (${quota.fromUpstream ? "upstream hint" : "default"}). /goal resume retries now.` }],
						details: { goal, summary } satisfies GoalCompleteDetails,
						terminate: true, // stop the agent; the scheduled resume re-triggers
					};
				}
				ctx.ui.notify(`Goal audit failed (infrastructure): ${auditResult.error}`, "warning");
				return {
					content: [{ type: "text", text: `Audit could not produce a verdict: ${auditResult.error}. Re-verify and call goal_complete again.` }],
					details: { goal, summary } satisfies GoalCompleteDetails,
				};
			}
			// Impossible → the objective can never be satisfied; complete with a note
			// (fall through to the normal complete transition below).
			if (auditResult.impossible) {
				ctx.ui.notify(`Goal marked impossible by audit: ${auditResult.impossibleReason ?? "unspecified"}`, "info");
			}
			// Disapproved → bounded re-loop (D3): stay active, return the finding,
			// terminate defaults to false so the agent continues in-turn and self-corrects.
			if (auditResult.disapproved) {
				const attempts = (completedGoal.auditAttempts ?? 0) + 1;
				completedGoal = { ...completedGoal, auditAttempts: attempts };
				goalState.activeGoal = completedGoal;
				persistGoal(goalState.extensionApi as ExtensionAPI, completedGoal);
				if (attempts >= AUDIT_MAX_RETRIES) {
					// Escalate: pause the goal so the user decides.
					goalState.activeGoal = transitionGoal(completedGoal, "paused");
					setAndPersistGoal(goalState.activeGoal, ctx);
					ctx.ui.notify(`Goal audit disapproved ${attempts}× — paused for review. Address the audit findings or /goal resume.`, "warning");
					return {
						content: [{ type: "text", text: `Audit disapproved ${attempts}× and paused the goal. Findings: ${auditResult.output.slice(0, 500)}` }],
						details: { goal, summary } satisfies GoalCompleteDetails,
					};
				}
				ctx.ui.notify(`Goal audit disapproved (attempt ${attempts}/${AUDIT_MAX_RETRIES}). Address the findings and re-verify.`, "warning");
				return {
					content: [{ type: "text", text: `Audit DISAPPROVED. Findings:\n${auditResult.output.slice(0, 1000)}\n\nAddress these and call goal_complete again only when genuinely complete.` }],
					details: { goal, summary } satisfies GoalCompleteDetails, // terminate defaults to false → agent continues in-turn
				};
			}
			// Approved (and shield passed) → fall through to the normal complete transition.
		}

		if (completedGoal) {
			goalState.activeGoal = transitionGoal(completedGoal, "complete");
			updateGoalUsage(goalState.activeGoal, ctx);
			persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
		}

		// Loop 2 (Task 6): auto-advance the /list queue on a clean complete. We
		// reach here ONLY on a clean complete (approved / no-audit /
		// impossible-note); freeze cases (audit 3× disapprove → paused; infra
		// error) returned early above, so the queue stays put on freeze. If a tail
		// item exists, promote it to the active goal (its item.audit, if any,
		// wires the auditor for ITS goal_complete — D5) and continue in-turn on
		// the new goal. If the tail is empty, complete as today.
		const { item, rest } = promoteNext(goalState.list);
		if (item) {
			goalState.list = rest;
			goalState.activeGoal = createGoal(item.text, item.tokenBudget, currentTokenTotal(ctx), item.audit, "list");
			goalState.headAdvances += 1;
			setAndPersistGoal(goalState.activeGoal, ctx);
			ctx.ui.notify(`Goal complete. Advanced to: ${item.text}`, "success");
			return {
				content: [{ type: "text", text: `Goal complete: ${summary}. Advanced to next goal: ${item.text}` }],
				details: { goal, summary } satisfies GoalCompleteDetails,
				terminate: false, // continue in-turn on the new goal (mirrors the disapprove path's terminate:false)
			};
		}

		// ─── Reviewer (Task 5): post-completion cascade at clean complete ────────
		// Fires ONLY on this clean-complete terminal path (the pause / abort /
		// infra-error paths all early-returned above). runReviewer is PURE + SYNC:
		// every side effect is injected. `proposeGoal` only RECORDS onto a local
		// array (returning true); the actual `await ctx.ui.confirm(...)` Confirm
		// loop runs AFTER runReviewer returns, here in the async execute handler.
		// First accepted proposal wins → createGoal + terminate:false so the agent
		// continues in-turn on the follow-up. Nothing accepted → fall through to
		// the normal clearActiveGoal + terminate:true path (preserving any
		// bug/refactor /list items the reviewer enqueued as the new queue tail).
		// A Reviewer failure MUST NEVER block completion — the whole block is
		// try/catch'd and degrades to the plain complete on any error.
		// Hoist reviewerEnqueued before the try so the catch can preserve the list on a throw.
		let reviewerEnqueued = 0;
		try {
			const recordedProposals: Array<{ objective: string; reason: string }> = [];
			const reviewerNowMs = Date.now();
			const reviewerConfig = resolveReviewerConfig({ enabled: goalState.reviewerEnabled, mode: goalState.reviewerMode });
			const reviewerSource = {
				kind: (completedGoal.origin === "list" ? "list" : "goal") as "goal" | "list",
				goalId: completedGoal.id,
				objective: completedGoal.text,
				terminal: "goal-complete",
			};
			// Finding sources (no new capture): the completion summary is the highest-
			// signal source; disapproved audit entries are the second. completedGoal.
			//text is passed as source.objective for restatement dedup.
			const reviewerSources = [
				{ name: "completion-summary", text: summary },
				{
					name: "audit-disapproved",
					text: (completedGoal.auditHistory ?? [])
						.filter((r) => r.disapproved)
						.map((r) => r.output)
						.join("\n\n"),
				},
			];
			// Read the ledger fresh each fire so the refire-window + day-cap gates see
			// entries recorded by earlier fires in this same session.
			const reviewerLedgerEntries = loadReviewerEntries(ctx.sessionManager);
			// goalState.activeGoal is the just-completed goal (transitionGoal to
			// "complete" ran above) — capture it for the enqueue dep's persist so TS
			// can narrow away undefined without a non-null assertion at each call.
			const reviewerActiveGoal = goalState.activeGoal;
			runReviewer(reviewerConfig, reviewerSource, {
				cwd: ctx.cwd,
				nowMs: reviewerNowMs,
				ledgerEntries: reviewerLedgerEntries,
				sources: reviewerSources,
				enqueueListItems: (objs: string[]) => {
					goalState.list = addListItems(goalState.list, objs);
					reviewerEnqueued += objs.length;
					persistGoal(goalState.extensionApi as ExtensionAPI, reviewerActiveGoal!);
				},
				proposeGoal: (objective: string, reason: string) => {
					// SYNC + record-only: the Confirm loop runs after runReviewer returns.
					recordedProposals.push({ objective, reason });
					return true;
				},
				notify: (m: string, lvl: "info" | "warning") => ctx.ui.notify(m, lvl),
				ledger: (type: string, value: Record<string, unknown>) => {
					// Fresh record literal each call (Task 4 finding #5:
					// appendReviewerEntry does NOT clone — never alias a mutable object).
					appendReviewerEntry(goalState.extensionApi as ExtensionAPI, {
						type: type as "reviewer_fired" | "reviewer_suppressed",
						at: new Date(reviewerNowMs).toISOString(),
						goalId: completedGoal.id,
						...value,
					});
				},
			});

			// Confirm loop — async, AFTER runReviewer returns. First accepted wins.
			let acceptedObjective: string | undefined;
			for (const p of recordedProposals) {
				const ok = await ctx.ui.confirm(
					"Reviewer proposal",
					`${p.reason}\n\nProposed follow-up goal:\n${p.objective}`,
				);
				if (ok) {
					acceptedObjective = p.objective;
					break;
				}
			}
			if (acceptedObjective) {
				goalState.activeGoal = createGoal(
					acceptedObjective,
					undefined,
					currentTokenTotal(ctx),
					undefined,
				); // origin defaults "bare" — a Reviewer-proposed goal is not a list item
				setAndPersistGoal(goalState.activeGoal, ctx);
				ctx.ui.notify(`Goal complete. Reviewer follow-up now active: ${acceptedObjective}`, "info");
				return {
					content: [
						{
							type: "text",
							text: `Goal complete: ${summary}. Reviewer proposed a follow-up goal, now active: ${acceptedObjective}`,
						},
					],
					details: { goal, summary } satisfies GoalCompleteDetails,
					terminate: false, // continue in-turn on the follow-up goal
				};
			}
			// Nothing accepted (or no proposals) → fall through. Preserve any
			// reviewer-enqueued /list items: they are the legitimate new queue tail.
			clearActiveGoal(ctx, { preserveList: reviewerEnqueued > 0 });
		} catch (reviewerError) {
			ctx.ui.notify(`Reviewer skipped (non-fatal): ${String(reviewerError)}`, "warning");
			clearActiveGoal(ctx, { preserveList: reviewerEnqueued > 0 });
		}

		showCompletionStatus(ctx, goal);
		ctx.ui.notify(`Goal complete: ${goal}`, "info");

		return {
			content: [{ type: "text", text: `Goal complete: ${summary}` }],
			details: { goal, summary } satisfies GoalCompleteDetails,
			terminate: true,
		};
	},
});