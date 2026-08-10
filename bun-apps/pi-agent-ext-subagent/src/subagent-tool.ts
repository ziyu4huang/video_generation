/**
 * `subagent` tool — agent-callable single-agent dispatch over `spawnSubagent()`.
 *
 * Closes the Layer-3 drift: superpowers' subagent-driven-development and
 * dispatching-parallel-agents speak in terms of "dispatch a subagent" via the
 * `Subagent (general-purpose):` template; on Pi that resolves to "use an
 * installed `subagent` tool if available". This tool IS that surface, backed by
 * the workflow extension's existing isolated-child runner (WorkflowAgent.run).
 *
 * Minimal v1: { agent?, task, model?, cwd?, tools?, excludeTools? } → child output.
 * No clarify-TUI / acceptance / turnBudget / toolBudget (deferred — see spec.md).
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { AgentHistoryEntry } from "./agent-history.js";
import { type AgentDefinition, listAgentTypes, loadAgentRegistry, resolveAgentType } from "./agent-registry.js";
import { computeScopeCheck, realGitOps, type SubagentScopeCheck } from "./git-scope.js";
import { parseSddReport } from "./sdd-report.js";
import { spawnSubagent } from "./spawn-subagent.js";
import { generateSubagentRunId } from "./subagent-run-persistence.js";
import {
  deriveSubagentStatus,
  formatSubagentLive,
  formatSubagentResult,
  renderSubagentCall,
  renderSubagentResult,
  taskPreview,
  workIntentPreview,
} from "./subagent-tool-render.js";
import {
  DEFAULT_TIMEOUT_MS,
  isSchemaShaped,
  type SubagentToolDetails,
  type SubagentToolOptions,
  subagentToolSchema,
} from "./subagent-tool-schema.js";
import { computeBaseline, type RepoBaseline } from "./watchdog/repo-diff.js";
import { normalizeWatchdogParam, type WatchdogResult } from "./watchdog/types.js";
import { runWatchdog } from "./watchdog/watchdog.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";
export function createSubagentTool(
  options: SubagentToolOptions = {},
): ToolDefinition<typeof subagentToolSchema, SubagentToolDetails> {
  const defaultCwd = options.cwd ?? process.cwd();
  const spawn = options.spawn ?? spawnSubagent;
  const gitOps = options.gitOps ?? realGitOps;
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Dispatch a single subagent with an ISOLATED context to do a focused task and report back.",
      "The subagent does NOT inherit this session's history — pass a self-contained `task` prompt.",
      "Returns the subagent's output, plus an exit/timed-out status in `details`.",
    ].join(" "),
    // Owner-declared gating — migrated from tool-gate's hardcoded GATES (was the
    // {names:["workflow","workflow_help","subagent","workflow_control"]} combined
    // gate; tickets 10 + 11 rolled out TOGETHER as one atomic unit because they
    // SHARE that single combined gate). Per the semantics-preserving rule, the
    // SAME gating (keywords only, no `requires`) is mirrored IDENTICALLY on all
    // 4 tools so they activate together and reconstructOwnerDeclaredGates
    // collapses them back into one 4-name gate (names[0] === "workflow") —
    // preserving the original co-fire behavior. Mirrors the original GATES entry
    // verbatim (keywords were unambiguous workflow/orchestration intents that
    // never false-fired the way image/video nouns do, so no requires is needed).
    gating: {
      keywords: ["workflow", "pipeline", "orchestrate", "fan-out", "fan out", "parallel agent", "multi-step"],
    },
    promptSnippet:
      "Dispatch an isolated-context subagent for one focused task (implementer / reviewer / researcher). Pass a self-contained `task`; pick `model`/`tier` per role (omit to use the current model); restrict with `tools`/`excludeTools`.",
    // Sequential: serialize any turn whose tool-call batch contains a
    // subagent dispatch. Enforces the "parallel fan-out goes through the
    // `workflow` tool's parallel()" contract at the engine level — pi's rule
    // is "any sequential tool call in a turn ⇒ the whole batch runs serially"
    // (pi-agent-core agent-loop). The `workflow` tool's parallel()/agent()
    // dispatch via a SEPARATE createAgentSession() path, so this does NOT
    // throttle workflow fan-out. (ticket 10)
    executionMode: "sequential",
    parameters: subagentToolSchema,
    async execute(toolCallId, params, signal, onUpdate, _ctx) {
      const t0 = Date.now();
      // A retryOnTransient retry hands onHistory a fresh (shorter) history array
      // from a brand-new child session — track the running max across the whole
      // call so the displayed tool-call count never visibly regresses. See
      // formatSubagentProgress's `minToolCalls` param.
      let maxToolCallsSeen = 0;
      // Latest compact history snapshot, retained so the durable record (ticket
      // 08) can persist the transcript. Updated in the onHistory callback.
      let lastHistory: AgentHistoryEntry[] | undefined;
      const runCwd = params.cwd ?? defaultCwd;
      const makeWorktree = options.createWorktree ?? createWorktree;
      const teardownWorktree = options.removeWorktree ?? removeWorktree;

      const failEarly = (
        text: string,
      ): { content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails } => ({
        content: [{ type: "text" as const, text }],
        details: {
          exitCode: 1,
          timedOut: false,
          agent: params.agent,
          model: params.model ?? "default",
          taskPreview: taskPreview(params.task),
          elapsedMs: Date.now() - t0,
          startedAt: t0,
          status: "failed",
        },
      });

      let agentDef: AgentDefinition | undefined;
      if (params.agentType) {
        const registry = options.agentRegistry ?? loadAgentRegistry(runCwd);
        agentDef = resolveAgentType(params.agentType, registry);
        if (!agentDef) {
          const known = listAgentTypes(registry).map((t) => t.name);
          return failEarly(
            `Unknown agentType "${params.agentType}".${
              known.length
                ? ` Available: ${known.join(", ")}.`
                : " No agentType definitions found (.pi/agents/*.md or ~/.pi/agents/*.md)."
            }`,
          );
        }
      }

      if (params.schema !== undefined && !isSchemaShaped(params.schema)) {
        return failEarly(`Invalid schema: expected a JSON-Schema-shaped object with a "type" field.`);
      }

      let worktree: Worktree | undefined;
      let spawnCwd = runCwd;
      if (agentDef?.isolation === "worktree") {
        // toolCallId (not runId+callIndex) is fine here: this tool has no resume/journal
        // semantics, unlike workflow.ts's agent() — see the determinism note on
        // createWorktree() in worktree.ts.
        worktree = await makeWorktree(runCwd, `subagent-${toolCallId}`);
        if (worktree.isolated) spawnCwd = worktree.cwd;
      }

      // Opt-in commit-scope guardrail (commitScope param): record the repo HEAD
      // before dispatch so the post-run check can diff base..HEAD for out-of-scope
      // committed paths. Only the real-tree case is checked — a worktree-isolated
      // run is discarded after teardown, so it can never pollute the parent tree.
      const scope = params.commitScope;
      let baseCommit: string | undefined;
      if (scope !== undefined && spawnCwd === runCwd) {
        try {
          baseCommit = await gitOps.headCommit(runCwd);
        } catch {
          baseCommit = undefined;
        }
      }

      // Opt-in two-layer watchdog (watchdog param): snapshot the repo state NOW so the
      // post-spawn compute can tell whether the child edited anything. Captured on
      // spawnCwd (the real tree or the worktree the child ran in). A throw / non-repo
      // → undefined, which gates the post-spawn run entirely (no review, no summary).
      const watchdogOpts = normalizeWatchdogParam(params.watchdog);
      let watchdogBaseline: RepoBaseline | undefined;
      if (watchdogOpts) {
        try {
          watchdogBaseline = computeBaseline(spawnCwd);
        } catch {
          watchdogBaseline = undefined;
        }
      }

      const requestedModel = params.model ?? agentDef?.model;
      const tier = params.tier ?? agentDef?.tier;
      const capability = params.capability;
      const mainModel = options.getMainModel?.();
      // Shown WHILE the subagent runs, before the resolved model is known: the
      // requested model, else the capability, else the tier, else the live session model, else "default".
      const displayModelBeforeResolve =
        requestedModel ?? (capability ? `capability:${capability}` : tier ? `tier:${tier}` : mainModel) ?? "default";
      // The concrete provider/id the child actually ran on, captured from
      // WorkflowAgent once resolved. Falls back to the requested display string.
      let resolvedModel: string | undefined;
      // True when the model resolution fell back (onModelFallback fired).
      let fellBack = false;

      // Per-child AbortController (Frontier A): the user can abort ONE running
      // child via registry.abort(toolCallId) → this controller fires. We FAN IN
      // the parent tool-call `signal` so a whole-turn Esc still aborts the child.
      // spawn's own timeoutMs gate stays independent — it aborts spawn's internal
      // controller (not this one), so a timeout is detectable separately.
      const childAc = new AbortController();
      if (signal?.aborted) childAc.abort();
      else signal?.addEventListener("abort", () => childAc.abort(), { once: true });
      options.inFlight?.start({
        id: toolCallId,
        agent: params.agent,
        model: displayModelBeforeResolve,
        taskPreview: taskPreview(params.task),
        // Precompute the work-intent strip from the RAW task so the docked
        // context box can surface it (ticket 04, finding 1 — taskPreview is
        // already single-lined, so workIntentPreview can't strip its preamble).
        workIntent: workIntentPreview(params.task),
        startedAt: t0,
        abort: () => childAc.abort(),
        // Rendered inline in the CURRENT turn by this tool's own call/result line
        // (Surface A) — mark foreground so the above-editor context box EXCLUDES
        // it (no duplication). Background runs (foreground:false) are the box's
        // domain. See subagent-context-widget.ts.
        foreground: true,
      });
      try {
        const instructions =
          [params.agent ? `You are the ${params.agent} for this task.` : undefined, agentDef?.prompt]
            .filter((s): s is string => Boolean(s))
            .join("\n\n") || undefined;

        // Default to the parent's gated active set (not the full definition universe)
        // so a spawned subagent doesn't re-pay the ~18k tok/req schema baseline the
        // parent gated down to ~10k. Precedence: explicit per-call `tools` > agentType
        // `tools` binding > parent's gated active set (the fallback when neither
        // restricts). See .planning/2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task/
        // ticket 01 (optimization #1). Caller's explicit `tools` still overrides.
        const defaultActiveTools = options.getActiveTools?.();
        const result = await spawn({
          task: params.task,
          tools: params.tools ?? agentDef?.tools ?? defaultActiveTools,
          excludeTools: params.excludeTools ?? agentDef?.disallowedTools,
          model: requestedModel,
          tier,
          capability,
          mainModel,
          cwd: spawnCwd,
          instructions,
          extensionTools: options.getExtensionTools?.(),
          externalSignal: childAc.signal,
          timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          tokenBudget: params.tokenBudget,
          spendBudget: params.spendBudget,
          retryOnTransient: params.retryOnTransient,
          schema: params.schema as TSchema | undefined,
          schemaRepairAttempts: params.schemaRepairAttempts,
          onModelResolved: (id) => {
            resolvedModel = id;
            options.inFlight?.updateModel(toolCallId, id);
          },
          onModelFallback: (requestedSpec) => {
            fellBack = true;
            options.inFlight?.markFallback(toolCallId, requestedSpec);
          },
          onHistory:
            onUpdate || options.inFlight || options.persistence
              ? (history: AgentHistoryEntry[]) => {
                  lastHistory = history;
                  // Progress streaming is diagnostic only — a throwing onUpdate
                  // (e.g. a TUI re-render failure) must never fail the subagent's
                  // actual task result.
                  try {
                    const toolCallsNow = history.filter((h) => h.kind === "toolCall").length;
                    maxToolCallsSeen = Math.max(maxToolCallsSeen, toolCallsNow);
                    options.inFlight?.update(toolCallId, history);
                    onUpdate?.({
                      content: [
                        { type: "text" as const, text: formatSubagentLive(history, Date.now() - t0, maxToolCallsSeen) },
                      ],
                      details: undefined as unknown as SubagentToolDetails,
                    });
                  } catch {
                    // swallowed — see comment above
                  }
                }
              : undefined,
        });
        const elapsedMs = Date.now() - t0;
        // Per-child abort detection (Frontier A): a USER abort fires childAc
        // only (parent signal intact); a whole-turn Esc fans the parent signal
        // INTO childAc (so signal.aborted distinguishes); a timeout aborts
        // spawn's internal controller, not childAc (so childAc.signal stays
        // un-aborted → falls through to the timedout path unchanged).
        if (childAc.signal.aborted && !signal?.aborted) {
          // Partial work is discarded (worktree) or left in-tree (real-tree);
          // scope/watchdog review of a half-finished diff would be noise.
          const model = resolvedModel ?? displayModelBeforeResolve;
          options.persistence?.save({
            id: generateSubagentRunId(),
            toolCallId,
            agent: params.agent,
            task: params.task,
            model,
            requestedModel: fellBack ? (requestedModel ?? undefined) : undefined,
            fellBack: fellBack || undefined,
            tier,
            cwd: runCwd,
            status: "aborted",
            exitCode: result.exitCode,
            timedOut: false,
            startedAt: new Date(t0).toISOString(),
            elapsedMs,
            usage: result.usage,
            output: "Subagent aborted by user.",
          });
          return {
            content: [{ type: "text" as const, text: "Subagent aborted by user." }],
            details: {
              exitCode: result.exitCode,
              timedOut: false,
              agent: params.agent,
              model,
              taskPreview: taskPreview(params.task),
              elapsedMs,
              startedAt: t0,
              status: "aborted" as const,
              usage: result.usage,
            },
          };
        }
        // Opt-in commit-scope check (commitScope param): detection only. A
        // throwing op is swallowed — the scope guard never fails the run.
        let scopeCheck: SubagentScopeCheck | undefined;
        if (scope !== undefined && spawnCwd === runCwd && baseCommit !== undefined) {
          try {
            scopeCheck = await computeScopeCheck(gitOps, runCwd, baseCommit, scope);
          } catch {
            scopeCheck = undefined;
          }
        }
        let output = formatSubagentResult(result);
        if (scopeCheck && scopeCheck.outOfScope.length > 0) {
          // Surface the violation to the parent agent in the result text (not
          // just the details badge) so the controller cannot miss it — the
          // recurring `git add -A` sweep lands stray files into squash-merges.
          const paths = scopeCheck.outOfScope.map((p) => `  - ${p}`).join("\n");
          output += `\n\n--- ⚠ commit-scope violation (${scopeCheck.outOfScope.length}) ---\nThe subagent committed path(s) OUTSIDE the declared commitScope:\n${paths}\nInspect before merging — this is the recurring \`git add -A\` sweep signal.`;
        }
        // Opt-in two-layer watchdog: run the review against the captured baseline.
        // Soft gate — appends a summary line only when runWatchdog actually ran OR
        // was edit-gated (no diff). A throw anywhere in the watchdog path is caught
        // here so it can NEVER fail the run; in that case a `watchdog-error:` line
        // is appended instead and watchdogResult stays undefined.
        let watchdogResult: WatchdogResult | undefined;
        if (watchdogOpts && watchdogBaseline) {
          try {
            watchdogResult = await runWatchdog({
              cwd: spawnCwd,
              before: watchdogBaseline,
              opts: watchdogOpts,
              taskLabel: taskPreview(params.task),
            });
            if (watchdogResult.ran || watchdogResult.editGated) {
              output += `\n\n--- 🔍 ${watchdogResult.summary} (soft gate — review findings; not a failure) ---`;
            }
          } catch (e) {
            output += `\n\n--- 🔍 watchdog-error: ${(e as Error).message} ---`;
          }
        }
        const model = resolvedModel ?? displayModelBeforeResolve;
        const details: SubagentToolDetails = {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          agent: params.agent,
          model,
          requestedModel: fellBack ? (requestedModel ?? undefined) : undefined,
          fellBack: fellBack || undefined,
          taskPreview: taskPreview(params.task),
          elapsedMs,
          startedAt: t0,
          status: deriveSubagentStatus(result),
          usage: result.usage,
          budget: result.budget,
          // SDD report (ticket 04): parse the implementer's `**Status:**` block when
          // present (non-SDD / schema / failure outputs have no marker → undefined).
          report: parseSddReport(result.output),
          scopeCheck,
          watchdog: watchdogResult,
        };
        // Durable record for post-session replay (ticket 08). Write-once at
        // completion; best-effort — save() swallows errors so this can never
        // fail the run. Covers done/failed/timedout (spawnSubagent returns a
        // result, never throws, on child failure); the pre-flight failEarly
        // paths above do not persist (they are not real runs).
        options.persistence?.save({
          id: generateSubagentRunId(),
          toolCallId,
          agent: params.agent,
          task: params.task,
          model,
          requestedModel: fellBack ? (requestedModel ?? undefined) : undefined,
          fellBack: fellBack || undefined,
          tier,
          cwd: runCwd,
          status: details.status,
          exitCode: details.exitCode,
          timedOut: details.timedOut,
          stderr: result.stderr || undefined,
          startedAt: new Date(t0).toISOString(),
          elapsedMs,
          usage: details.usage,
          budget: details.budget,
          output,
          history: lastHistory,
          report: details.report,
          scopeCheck: details.scopeCheck,
          watchdog: watchdogResult,
        });
        return { content: [{ type: "text" as const, text: output }], details };
      } finally {
        options.inFlight?.end(toolCallId);
        if (worktree) await teardownWorktree(worktree);
      }
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      // The concrete model is only known mid-run (onModelResolved). Read the
      // latest from the registry (keyed by toolCallId) so the call line updates
      // live, and bind invalidate so updateModel can force a redraw even before
      // the next partial/history tick.
      // Live-run only: the registry entry is torn down in execute's finally
      // (end()), so after completion this reads undefined and the segment
      // reverts — the model then lives on the result line (d.model). While
      // running, onModelResolved → updateModel keeps this fresh + re-renders.
      const entry = options.inFlight?.get(context.toolCallId);
      const resolvedModel = entry?.resolvedModel;
      const fellBack = entry?.fellBack;
      options.inFlight?.bindInvalidate(context.toolCallId, context.invalidate);
      text.setText(renderSubagentCall({ ...args, resolvedModel, fellBack }, theme));
      return text;
    },
    renderResult(result, options, theme, _context) {
      const text = (_context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(renderSubagentResult(result, options, theme));
      return text;
    },
  });
}
