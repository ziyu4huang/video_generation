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
import {
  type AgentDefinition,
  createWorktree,
  listAgentTypes,
  loadAgentRegistry,
  removeWorktree,
  resolveAgentType,
  type Worktree,
} from "@repo/pi-agent-ext-core-runtime";
import { dispatchChild } from "./child-dispatch.js";
import { realGitOps } from "./git-scope.js";
import { missingRequiredTools } from "./impossible-tools.js";
import {
  consecutiveIdenticalFailures,
  DEFAULT_RETRY_CIRCUIT_BREAK,
  failureClass,
  RETRY_LOOP_WINDOW_MS,
  shouldCircuitBreak,
  taskSignature,
} from "./retry-loop-detector.js";
import { spawnSubagent } from "./spawn-subagent.js";
import {
  formatSubagentLive,
  formatSubagentResult,
  renderSubagentCall,
  renderSubagentResult,
  taskPreview,
  workIntentPreview,
} from "./subagent-tool-render.js";
import {
  augmentOutputWithScopeViolation,
  buildDetails,
  buildRunRecord,
  buildSpawnOptions,
  captureWatchdogBaseline,
  type RunProgress,
  resolveDisplayModel,
  runWatchdogReview,
} from "./subagent-tool-run.js";
import {
  isSchemaShaped,
  type SubagentToolDetails,
  type SubagentToolOptions,
  subagentToolSchema,
} from "./subagent-tool-schema.js";
import { computeBaseline } from "./watchdog/repo-diff.js";
import type { WatchdogResult } from "./watchdog/types.js";
import { runWatchdog } from "./watchdog/watchdog.js";
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
      // Mutable progress box — updated from spawn callbacks, read in teardown/save.
      const progress: RunProgress = {
        resolvedModel: undefined,
        fellBack: false,
        lastHistory: undefined,
        maxToolCallsSeen: 0,
      };
      const runCwd = params.cwd ?? defaultCwd;
      const makeWorktree = options.createWorktree ?? createWorktree;
      const teardownWorktree = options.removeWorktree ?? removeWorktree;

      const failEarly = (
        text: string,
      ): { content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails } => ({
        content: [{ type: "text" as const, text }],
        details: {
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

      // #04 retry-loop / runaway detector (circuit-break BEFORE spawn + BEFORE
      // worktree allocation). Counts completed dispatch OUTCOMES (persisted
      // records), NOT retryOnTransient's single in-dispatch tryOnce() retry.
      // Placed before worktree/inFlight so a broken dispatch leaks nothing.
      const circuitThreshold = params.retryCircuitBreak ?? DEFAULT_RETRY_CIRCUIT_BREAK;
      if (circuitThreshold > 0 && options.persistence) {
        const prior = options.persistence.list();
        const sig = taskSignature(params.task);
        // Derive the prospective failure class from the MOST RECENT matching
        // record (the repeat we'd be about to re-create). No match → no class → 0.
        const mostRecentMatch = prior.find((r) => taskSignature(r.task) === sig);
        const fclass = mostRecentMatch ? failureClass(mostRecentMatch) : "";
        if (fclass) {
          const count = consecutiveIdenticalFailures(prior, sig, fclass, RETRY_LOOP_WINDOW_MS);
          if (shouldCircuitBreak(count, circuitThreshold)) {
            return failEarly(
              `circuit-break: this task has already failed ${count} consecutive times ` +
                `(same error class, within ${Math.round(RETRY_LOOP_WINDOW_MS / 60_000)} min). ` +
                `Change the task, fix the root cause, or raise retryCircuitBreak (currently ${circuitThreshold}).`,
            );
          }
        }
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

      // Opt-in two-layer watchdog (watchdog param): snapshot the repo state NOW so the
      // post-spawn compute can tell whether the child edited anything. Captured on
      // spawnCwd (the real tree or the worktree the child ran in). A throw / non-repo
      // → undefined, which gates the post-spawn run entirely (no review, no summary).
      const watchdog = captureWatchdogBaseline(spawnCwd, params.watchdog, computeBaseline);

      const requestedModel = params.model ?? agentDef?.model;
      const tier = params.tier ?? agentDef?.tier;
      const capability = params.capability;
      const mainModel = options.getMainModel?.();
      // Shown WHILE the subagent runs, before the resolved model is known.
      const displayModelBeforeResolve = resolveDisplayModel(requestedModel, capability, tier, mainModel);

      try {
        const opts = buildSpawnOptions(
          {
            toolCallId,
            t0,
            params,
            agentDef,
            modelCtx: { requestedModel, tier, capability, mainModel },
            spawnCwd,
            // dispatchChild owns the child controller and overwrites this field;
            // buildSpawnOptions still needs a signal-shaped value for its type.
            childSignal: new AbortController().signal,
          },
          progress,
          {
            getActiveTools: options.getActiveTools,
            getExtensionTools: options.getExtensionTools,
            inFlight: options.inFlight,
            persistence: options.persistence,
            onUpdate,
          },
        );
        // #03 impossible-tool preflight (ABORT, pre-spawn). Sits inside this try
        // so the finally still tears down the worktree on abort.
        const missing = missingRequiredTools(params.requiredTools, opts.tools, opts.excludeTools);
        if (missing) {
          return failEarly(
            `preflight: task requires tools not in the child allowlist: ${missing.join(", ")}. ` +
              `Add them to \`tools\` (or drop them from \`excludeTools\` / \`requiredTools\`).`,
          );
        }
        // The per-child pipeline — abort fan-in, in-flight lifecycle,
        // resolved-model capture, the commit-scope audit and status derivation —
        // is shared with the `subagents` batch tool (see child-dispatch.ts).
        const outcome = await dispatchChild(
          {
            id: toolCallId,
            startedAt: t0,
            spawn: opts,
            entry: {
              agent: params.agent,
              model: displayModelBeforeResolve,
              taskPreview: taskPreview(params.task),
              // Work-intent strip from the RAW task so the docked context box can
              // surface it (ticket 04, finding 1 — taskPreview is already
              // single-lined, so workIntentPreview can't strip its preamble).
              workIntent: workIntentPreview(params.task),
            },
            // Audited even with no declared scope: this child holds raw `bash`,
            // so an unset scope means "flag ANY commit" (#02 B1 default-on) —
            // the recurring `git add -A` sweep signal.
            scope: { declared: params.commitScope, runCwd, spawnCwd },
            parentSignal: signal,
          },
          {
            spawn,
            inFlight: options.inFlight,
            gitOps,
            // The transcript is only needed when it will be persisted.
            captureHistory: Boolean(options.persistence),
            // Live progress line — only when the host actually gave us a sink.
            onHistory: onUpdate
              ? (history) => {
                  progress.lastHistory = history;
                  const toolCallsNow = history.filter((h) => h.kind === "toolCall").length;
                  progress.maxToolCallsSeen = Math.max(progress.maxToolCallsSeen, toolCallsNow);
                  onUpdate({
                    content: [
                      {
                        type: "text" as const,
                        text: formatSubagentLive(history, Date.now() - t0, progress.maxToolCallsSeen),
                      },
                    ],
                    details: undefined as unknown as SubagentToolDetails,
                  });
                }
              : undefined,
          },
        );
        const result = outcome.result;
        const elapsedMs = outcome.elapsedMs;
        progress.resolvedModel = outcome.model;
        progress.fellBack = outcome.fellBack;
        // Task 05: the run was detached to background mid-flight. The detached
        // OS subprocess (spawned by convertToBackground) owns execution and the
        // eventual completed-record write; the parent turn resumes WITHOUT
        // killing anything and WITHOUT persisting here (persistence owns
        // recovery via the detach manifest). The registry entry stays live for
        // the subagents section.
        if (outcome.status === "detached") {
          const model = progress.resolvedModel ?? displayModelBeforeResolve;
          return {
            content: [
              {
                type: "text" as const,
                text: `Subagent detached → background (run ${toolCallId}; still live in the status section / /subagents)`,
              },
            ],
            details: {
              agent: params.agent,
              model,
              taskPreview: taskPreview(params.task),
              elapsedMs,
              startedAt: t0,
              status: "detached" as const,
            },
          };
        }
        if (outcome.userAborted) {
          // Partial work is discarded (worktree) or left in-tree (real-tree);
          // scope/watchdog review of a half-finished diff would be noise.
          const model = progress.resolvedModel ?? displayModelBeforeResolve;
          options.persistence?.save(
            buildRunRecord(
              {
                toolCallId,
                agent: params.agent,
                task: params.task,
                model,
                requestedModel,
                fellBack: progress.fellBack,
                tier,
                runCwd,
                t0,
                elapsedMs,
              },
              {
                status: "aborted",
                output: "Subagent aborted by user.",
                usage: result.usage,
              },
            ),
          );
          return {
            content: [{ type: "text" as const, text: "Subagent aborted by user." }],
            details: {
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
        // Commit-scope audit (detection only) — computed by dispatchChild, which
        // swallows any git failure so the guard never fails a run.
        const scopeCheck = outcome.scopeCheck;
        let output = augmentOutputWithScopeViolation(formatSubagentResult(result), scopeCheck);
        // Opt-in two-layer watchdog: run the review against the captured baseline.
        // Soft gate — appends a summary line only when runWatchdog actually ran OR
        // was edit-gated (no diff). A throw anywhere in the watchdog path is caught
        // here so it can NEVER fail the run; in that case a `watchdog-error:` line
        // is appended instead and watchdogResult stays undefined.
        let watchdogResult: WatchdogResult | undefined;
        if (watchdog?.baseline) {
          const review = await runWatchdogReview(
            runWatchdog,
            watchdog.opts,
            watchdog.baseline,
            spawnCwd,
            taskPreview(params.task),
          );
          if (review.result) watchdogResult = review.result;
          if (review.outputAppend) output += review.outputAppend;
        }
        const model = progress.resolvedModel ?? displayModelBeforeResolve;
        const details = buildDetails(
          result,
          { model, requestedModel, fellBack: progress.fellBack },
          { task: params.task, agent: params.agent, elapsedMs, startedAt: t0, scopeCheck, watchdog: watchdogResult },
        );
        // Durable record for post-session replay (ticket 08). Write-once at
        // completion; best-effort — save() swallows errors so this can never
        // fail the run. Covers done/failed/timedout (spawnSubagent returns a
        // result, never throws, on child failure); the pre-flight failEarly
        // paths above do not persist (they are not real runs).
        options.persistence?.save(
          buildRunRecord(
            {
              toolCallId,
              agent: params.agent,
              task: params.task,
              model,
              requestedModel,
              fellBack: progress.fellBack,
              tier,
              runCwd,
              t0,
              elapsedMs,
            },
            {
              status: details.status,
              usage: details.usage,
              output,
              error: result.failure?.message,
              budget: details.budget,
              turns: details.turns,
              history: outcome.history,
              report: details.report,
              scopeCheck: details.scopeCheck,
              watchdog: watchdogResult,
            },
          ),
        );
        return { content: [{ type: "text" as const, text: output }], details };
      } finally {
        // dispatchChild owns the abort-listener cleanup and the in-flight
        // release (both in its own finally, so they run on a throw too). The
        // worktree is this tool's alone — the batch tool never allocates one.
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
      const v = options.inFlight?.view(context.toolCallId);
      options.inFlight?.bindInvalidate(context.toolCallId, context.invalidate);
      text.setText(renderSubagentCall({ ...args, modelSeg: v?.modelSeg }, theme));
      return text;
    },
    renderResult(result, renderOptions, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      // Fallback-aware model segment from the RunView (registry.view), when the
      // registry still holds an entry for this run; renderSubagentResult
      // degrades to the bare actual model otherwise. `options` here is the
      // tool-level closure (same source renderCall reads), not renderOptions.
      const v = options.inFlight?.view(context.toolCallId);
      text.setText(renderSubagentResult(result, renderOptions, theme, { modelSeg: v?.modelSeg }));
      return text;
    },
  });
}
