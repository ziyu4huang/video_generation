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
import { defineTool, getMarkdownTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { SpawnSubagentOptions } from "@repo/s2-agent-core-runtime";
import {
  type AgentDefinition,
  createWorktree,
  getLiveAgentRegistry,
  isForkChild,
  listAgentTypes,
  loadAgentRegistry,
  removeWorktree,
  resolveAgentType,
  roleAwareDefaults,
  runAsForkChild,
  spawnLiveAgentFirstExchange,
  spawnSubagent,
  tierDefaultToken,
  type Worktree,
} from "@repo/s2-agent-core-runtime";
import { getBackgroundRunManager } from "./background-run-manager.js";
import { dispatchChild } from "./child-dispatch.js";
import { ComposerComponent, GuardedComponent } from "./composer-component.js";
import { realGitOps, realGitSnapshotOps } from "./git-scope.js";
import { missingRequiredTools } from "./impossible-tools.js";
import {
  consecutiveIdenticalFailures,
  DEFAULT_RETRY_CIRCUIT_BREAK,
  failureClass,
  RETRY_LOOP_WINDOW_MS,
  shouldCircuitBreak,
  taskSignature,
} from "./retry-loop-detector.js";
import { buildSiblingRoster, buildStartupContextBlock } from "./startup-context.js";
import {
  formatSubagentLive,
  formatSubagentResult,
  renderSubagentCall,
  renderSubagentResult,
  renderSubagentResultHeader,
  subagentResultText,
  taskPreview,
  workIntentPreview,
} from "./subagent-tool-render.js";
import {
  augmentOutputWithSalvage,
  augmentOutputWithScopeViolation,
  buildDetails,
  buildRunRecord,
  buildSpawnOptions,
  captureWatchdogBaseline,
  extractSalvage,
  hasWriteTools,
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
  const liveRegistry = options.liveRegistry ?? getLiveAgentRegistry();
  const spawnLive = options.spawnLive ?? spawnLiveAgentFirstExchange;
  const gitOps = options.gitOps ?? realGitOps;
  return defineTool({
    // Renamed 2026-08-20 (tool-name verb_object effort): legacy name `subagent`
    // — see docs/agents/extension-naming.md for the rename history.
    name: "spawn_subagent",
    label: "Subagent",
    description: [
      "Dispatch a single subagent with an ISOLATED context to do a focused task and report back.",
      "The subagent does NOT inherit this session's history — pass a self-contained `task` prompt — unless `fork: true`, which prepends the parent transcript as context-only background context.",
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
    gating: { gate: "workflow" }, // reference form (ticket 01) — family declared in GATE_DEFS["workflow"] (workflow ext)
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

      // Fork invariants (ticket 02, map D3) — validated BEFORE any resource
      // (worktree, registry slot, session) is allocated. A fork is a one-shot
      // untyped background child; it cannot be named, typed, or forked again.
      if (params.fork) {
        if (params.name !== undefined) {
          return failEarly(
            "`fork` + `name` is not supported: a fork is a one-shot child with the parent conversation as " +
              "context, not a persistent session. Drop `fork` or drop `name`.",
          );
        }
        if (params.agentType !== undefined) {
          return failEarly(
            "`fork` + `agentType` is not supported: a fork is untyped (CC semantics) — it inherits the parent " +
              "conversation instead of an agent def. Drop `fork` or drop `agentType`.",
          );
        }
        if (isForkChild()) {
          return failEarly(
            "cannot fork from a fork child: the parent conversation is already inherited as this session's " +
              "context (fork chains are one deep — map D3). Dispatch a regular subagent with a self-contained " +
              "`task` instead.",
          );
        }
        if (!options.getParentTranscript) {
          return failEarly(
            "fork is unavailable in this host: no parent-session transcript source was captured at " +
              "session_start (detached-resume hosts have no parent conversation to inherit).",
          );
        }
      }

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

      // Named live agents (`name` param, ticket 01): validate the invariants
      // BEFORE any resource (worktree, session) is allocated. The live-agent
      // runner re-checks the registry authoritatively at registration (race-safe).
      if (params.name !== undefined) {
        if (params.schema !== undefined) {
          return failEarly(
            "`name` + `schema` is not supported: a named agent is a persistent multi-turn session, " +
              "structured output is a one-shot contract. Drop `name` or drop `schema`.",
          );
        }
        if (agentDef?.isolation === "worktree") {
          return failEarly(
            "`name` + worktree isolation is not supported: the worktree is torn down when the first " +
              "exchange returns, but the named agent's session must outlive it. Drop `name` or use a " +
              "non-isolated agentType.",
          );
        }
        if (liveRegistry.isNameTaken(params.name)) {
          return failEarly(
            liveRegistry.names().includes(params.name)
              ? `a live agent named "${params.name}" already exists. Live agents: ${liveRegistry.names().join(", ") || "(none)"}.`
              : `"${params.name}" is a reserved name (addresses the parent session).`,
          );
        }
        if (!liveRegistry.hasCapacity()) {
          return failEarly(
            `live-agent cap reached and every agent is mid-exchange. Live agents: ${liveRegistry.names().join(", ") || "(none)"}.`,
          );
        }
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

      // fork implies background DEFAULT true (CC behavior; ticket 02) — an
      // explicit background param still wins (false forces foreground).
      const background = params.background !== undefined ? params.background === true : params.fork === true;
      const manager = options.background ?? getBackgroundRunManager();

      // The dispatch+finalize tail, wrapped so the background branch can hand
      // the WHOLE lifecycle (worktree alloc through persistence save) to the
      // manager instead of awaiting it. Two deltas inside, everything else
      // moved verbatim:
      //   (a) the try/finally worktree teardown is INSIDE the closure — the
      //       worktree must outlive the immediate background return;
      //   (b) the dispatchChild request carries `background` and, when
      //       background, NO parentSignal (turn-abort decoupling,
      //       ADR-subagent-0007) and no onUpdate live-stream.
      const runCompletion = async (): Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: SubagentToolDetails;
      }> => {
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
        const scopedModels = options.getScopedModels?.();
        // Fork transcript (ticket 02): rendered HERE, once, pre-spawn — the
        // getter reads the sessionManager captured at session_start. undefined
        // getter was already rejected pre-flight above; undefined RENDER means
        // the parent conversation held no projectable text (fork of an empty
        // session runs without the block — accurate, not a silent degrade). A
        // throw inside the getter surfaces as this dispatch's failure.
        const forkTranscript = params.fork ? options.getParentTranscript?.() : undefined;
        // Startup-context block (ticket 04): git snapshot + sibling roster,
        // captured HERE (spawnCwd is final after the worktree alloc) and
        // composed by buildSpawnOptions as a task PREFIX. Best-effort — a
        // failed snapshot or empty roster just shrinks/omits the block, never
        // fails the dispatch. `minimal` drops the porcelain body and roster
        // (branch+HEAD only); `none` skips capture entirely.
        const contextMode = params.context ?? "full";
        let startupContext: string | undefined;
        if (contextMode !== "none") {
          const snapshotOps = options.gitSnapshotOps ?? realGitSnapshotOps;
          const [gitStatus, roster] = await Promise.all([
            snapshotOps.snapshot(spawnCwd).catch(() => undefined),
            Promise.resolve(
              contextMode === "full"
                ? (options.getSiblingRoster?.() ?? buildSiblingRoster(liveRegistry, options.inFlight))
                : undefined,
            ),
          ]);
          startupContext = buildStartupContextBlock({ spawnCwd, gitStatus, roster, mode: contextMode });
        }
        // Shown WHILE the subagent runs, before the resolved model is known.
        const displayModelBeforeResolve = resolveDisplayModel(requestedModel, capability, tier, mainModel);

        // 2026-08-15 hardening H3: role-aware dispatch bounds. Applied ONLY when
        // the dispatch omits ALL of tokenBudget/maxTurns/timeoutMs (detected on
        // the RAW params — timeoutMs is always defaulted downstream, so the check
        // must run first). Role comes from the effective toolset (write tools ⇒
        // writer); an unrestricted child reads as writer (bash is available).
        // An explicit bound of ANY kind opts the whole envelope out, and
        // SUBAGENT_TOKEN_BUDGET_DISABLE escapes entirely (same knob as the tier
        // ceilings). Computed BEFORE buildSpawnOptions and written back into
        // params so the spawn sees one coherent envelope; `bounds.notice` is
        // surfaced into the result output + durable record below.
        const effectiveAllowlist = params.tools ?? agentDef?.tools ?? options.getActiveTools?.();
        const dispatchRole = hasWriteTools(effectiveAllowlist, params.excludeTools ?? agentDef?.disallowedTools)
          ? "writer"
          : "recon";
        const explicitBounds =
          params.tokenBudget !== undefined || params.maxTurns !== undefined || params.timeoutMs !== undefined;
        const tierCeiling = tierDefaultToken(tier, requestedModel ?? mainModel);
        // A named dispatch opens a persistent live agent — its ceilings are
        // AGENT-LIFETIME caps (ticket 05 / F2), so the per-dispatch role
        // envelope is not applied as the lifetime default; the tier ceiling is.
        const persistent = params.name !== undefined;
        const bounds = roleAwareDefaults(
          { tokenBudget: params.tokenBudget, maxTurns: params.maxTurns, timeoutMs: params.timeoutMs },
          dispatchRole,
          tierCeiling,
          { persistent },
        );
        if (bounds.applied) {
          params.tokenBudget = bounds.tokenBudget;
          params.maxTurns = bounds.maxTurns;
          params.timeoutMs = bounds.timeoutMs;
        }
        // Budget-history cohort tag (2026-08-18 forward-fix): WHICH mechanism
        // set this dispatch's envelope — role-aware default ("envelope-<role>"),
        // explicit caller param ("explicit", captured pre-write-back), or tier
        // ceilings only ("tier"; a disabled ceiling leaves the bare tag).
        // Threads RunRecordCtx → durable record budget.source; absent on legacy
        // records = unknown cohort.
        const budgetCohort: SubagentToolDetails["budget"] = bounds.applied
          ? persistent
            ? {
                // Live-agent lifetime default (ticket 05 / F2): the tier ceiling
                // set this agent's lifetime token cap; no turn/timeout default.
                source: "tier" as const,
                tokenBudget: bounds.tokenBudget,
              }
            : {
                source: `envelope-${dispatchRole}` as const,
                tokenBudget: bounds.tokenBudget,
                maxTurns: bounds.maxTurns,
                timeoutMs: bounds.timeoutMs,
              }
          : explicitBounds
            ? {
                source: "explicit",
                tokenBudget: params.tokenBudget,
                maxTurns: params.maxTurns,
                timeoutMs: params.timeoutMs,
              }
            : tierCeiling !== undefined
              ? { source: "tier", tokenBudget: tierCeiling }
              : { source: "tier" };

        try {
          const opts = buildSpawnOptions(
            {
              toolCallId,
              t0,
              params,
              agentDef,
              modelCtx: { requestedModel, tier, capability, mainModel, scopedModels },
              spawnCwd,
              forkTranscript,
              startupContext,
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
          // A named dispatch (`name`) routes through the live-agent runner: the
          // first exchange runs on a session that is REGISTERED, not disposed,
          // when it completes — same dispatch machinery, different spawn fn.
          const dispatchSpawn = params.name
            ? (o: SpawnSubagentOptions) =>
                spawnLive(o, {
                  name: params.name as string,
                  agentId: toolCallId,
                  agentType: params.agentType,
                  registry: liveRegistry,
                }).then((r) => r.result)
            : params.fork
              ? // No-fork-recursion (ticket 02): the fork child's ENTIRE lifetime
                // runs inside the ambient fork-child scope, so the spawn_subagent
                // definition the child received via the extensionTools bridge
                // (this same closure) observes isForkChild() and rejects any
                // nested fork. Depth-inherited: a grandchild spawned from the
                // fork child is inside the scope too.
                (o: SpawnSubagentOptions) => runAsForkChild(() => spawn(o))
              : spawn;
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
              // background: NO parent signal — a whole-turn Esc must not kill a
              // background run (turn-abort decoupling, ADR-subagent-0007).
              parentSignal: background ? undefined : signal,
              background,
            },
            {
              spawn: dispatchSpawn,
              inFlight: options.inFlight,
              gitOps,
              // The transcript is only needed when it will be persisted.
              captureHistory: Boolean(options.persistence),
              // Live progress line — only when the host actually gave us a sink, and
              // never for a background dispatch (its tool call has already resolved
              // — there is no partial surface to stream onto).
              onHistory:
                onUpdate && !background
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
            // scope/watchdog review of a half-finished diff would be noise. The
            // transcript, though, is exactly the "code done, unreported" case —
            // salvage the child's last words + touched files (H2).
            const model = progress.resolvedModel ?? displayModelBeforeResolve;
            const salvage = extractSalvage(outcome.history ?? progress.lastHistory);
            const abortedText = augmentOutputWithSalvage("Subagent aborted by user.", result.failure, true, salvage);
            options.persistence?.save(
              buildRunRecord(
                {
                  toolCallId,
                  agent: params.agent,
                  agentName: params.name,
                  agentId: params.name ? toolCallId : undefined,
                  task: params.task,
                  model,
                  requestedModel,
                  fellBack: progress.fellBack,
                  tier,
                  budgetCohort,
                  runCwd,
                  t0,
                  elapsedMs,
                },
                {
                  status: "aborted",
                  output: abortedText,
                  usage: result.usage,
                  salvage,
                  // Stamps the record as a background-from-birth completion
                  // (stop lands here too — an aborted background run).
                  background: background || undefined,
                },
              ),
            );
            return {
              content: [{ type: "text" as const, text: abortedText }],
              details: {
                agent: params.agent,
                model,
                taskPreview: taskPreview(params.task),
                elapsedMs,
                startedAt: t0,
                status: "aborted" as const,
                usage: result.usage,
                salvage,
              },
            };
          }
          // Commit-scope audit (detection only) — computed by dispatchChild, which
          // swallows any git failure so the guard never fails a run.
          const scopeCheck = outcome.scopeCheck;
          let output = augmentOutputWithScopeViolation(formatSubagentResult(result), scopeCheck);
          // H3: one-line notice when role-aware bounds were applied (output+record).
          if (bounds.applied && bounds.notice) output += `\n${bounds.notice}`;
          // H2: terminal-abort salvage — budget/turns/timedout only (a "done" run
          // already carries its output; "failed" keeps its error head).
          const terminalAbort =
            result.failure?.kind === "budget" ||
            result.failure?.kind === "turns" ||
            result.failure?.kind === "timedout";
          const salvage = terminalAbort ? extractSalvage(outcome.history ?? progress.lastHistory) : undefined;
          output = augmentOutputWithSalvage(output, result.failure, false, salvage);
          // Named agent (ticket 01): surface that the session stays live and
          // addressable — the handle + agentId are what follow-up routing uses.
          if (params.name && !result.failure) {
            output += `\n\nNamed agent "${params.name}" is live (agentId ${toolCallId}); its session is retained for follow-up exchanges.`;
          }
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
            {
              task: params.task,
              agent: params.agent,
              elapsedMs,
              startedAt: t0,
              scopeCheck,
              watchdog: watchdogResult,
              salvage,
            },
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
                agentName: params.name,
                agentId: params.name ? toolCallId : undefined,
                task: params.task,
                model,
                requestedModel,
                fellBack: progress.fellBack,
                tier,
                budgetCohort,
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
                salvage,
                // Stamps the record as a background-from-birth completion;
                // omitted (undefined) on foreground records.
                background: background || undefined,
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
      };

      if (background) {
        const claim = manager.claim(toolCallId);
        if (!claim.ok) return failEarly(claim.error);
        try {
          manager.track(
            {
              id: toolCallId,
              agent: params.agent,
              model: params.model ?? agentDef?.model ?? "default",
              taskPreview: taskPreview(params.task),
              startedAt: t0,
            },
            runCompletion().then((r) => ({
              status: r.details.status,
              output: r.content[0]?.type === "text" ? r.content[0].text : undefined,
              usage: r.details.usage,
            })),
          );
        } catch (err) {
          // claim→track slot safety: a throw between a successful claim and
          // track would leak the slot (cap permanently shrunk). Release and
          // fail — no child was spawned, nothing else to unwind.
          manager.release(toolCallId);
          return failEarly(`background dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Subagent dispatched → background (run ${toolCallId}). Continue with other work; a <task-notification> ` +
                `follow-up will report completion. Block for the result with list_subagent_runs ` +
                `{action:"wait", id:"${toolCallId}"}; stop with {action:"stop", id:"${toolCallId}"}.`,
            },
          ],
          details: {
            agent: params.agent,
            model: params.model ?? "default",
            taskPreview: taskPreview(params.task),
            elapsedMs: Date.now() - t0,
            startedAt: t0,
            status: "running" as const,
          },
        };
      }
      return runCompletion();
    },
    renderCall(args, theme, context) {
      const component =
        context.lastComponent instanceof ComposerComponent ? context.lastComponent : new ComposerComponent(() => "");
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
      // Compose-in-render (ticket 02): the line is composed inside the
      // component's render(width) at the REAL terminal width — ticket 01's
      // width-aware helpers re-flow on resize for free. The closure swap on
      // the reused lastComponent mirrors the old text.setText pattern.
      // Root-cause hotfix: the host streams call args incrementally
      // (`message_update` → updateArgs) and an abort can freeze them partial,
      // so `args.task` may be undefined here — never forward a missing task.
      component.setComposer((width) =>
        renderSubagentCall({ ...args, task: args?.task ?? "", modelSeg: v?.modelSeg }, theme, width),
      );
      return component;
    },
    renderResult(result, renderOptions, theme, context) {
      const component =
        context.lastComponent instanceof ComposerComponent ? context.lastComponent : new ComposerComponent(() => "");
      // Fallback-aware model segment from the RunView (registry.view), when the
      // registry still holds an entry for this run; renderSubagentResult
      // degrades to the bare actual model otherwise. `options` here is the
      // tool-level closure (same source renderCall reads), not renderOptions.
      const v = options.inFlight?.view(context.toolCallId);
      // Ticket 03: the SETTLED expanded report renders as STYLED markdown — a
      // Container composing the unchanged header row (badge + meta) as Text
      // above a Markdown component fed the full, uncapped report text and the
      // host's shared theme (getMarkdownTheme), mirroring host chat's custom
      // message rendering instead of dumping raw `##`/`**` markers. Markdown is
      // itself width-aware (render(width) wraps), so resize re-flow stays free.
      // ONLY this branch moves to components — streaming/partial and
      // settled-collapsed keep the plain-string ComposerComponent path so the
      // #1104 flicker fix holds untouched.
      // Wrapped in GuardedComponent so this branch carries the SAME render-time
      // exception barrier the string path gets from ComposerComponent — it is a
      // Container, not a composer, and returning it bare was the one remaining
      // path where a throw (partial `result`, a Markdown parse fault) would
      // reach the host's frame loop and kill the session.
      if (!renderOptions.isPartial && renderOptions.expanded) {
        return new GuardedComponent(() => {
          const box = new Container();
          const header = renderSubagentResultHeader(result, theme, { modelSeg: v?.modelSeg });
          if (header) box.addChild(new Text(header, 0, 0));
          box.addChild(new Markdown(subagentResultText(result), 0, 0, getMarkdownTheme()));
          return box;
        });
      }
      // Compose-in-render (ticket 02): renderSubagentResult receives the
      // render-time width via opts (settled-collapsed cap becomes width-
      // derived); resize re-flow is free from the render(width) contract.
      component.setComposer((width) =>
        renderSubagentResult(result, renderOptions, theme, { modelSeg: v?.modelSeg, width }),
      );
      return component;
    },
  });
}
