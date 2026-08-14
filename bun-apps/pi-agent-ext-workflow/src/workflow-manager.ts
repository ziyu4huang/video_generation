/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentInFlightRegistry, WorkflowAgent } from "@repo/pi-agent-ext-core-runtime";
import { preview, WorkflowError, WorkflowErrorCode } from "@repo/pi-agent-ext-core-runtime";
import type { WorkflowSnapshot } from "./display.js";
import type { HostFnRegistry } from "./host-fn-registry.js";
import { mirrorIntermediate } from "./pack-run-context.js";
import {
  createRunPersistence,
  generateRunId,
  type PersistedExecOptions,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.js";
import { type JournalEntry, runWorkflow, type WorkflowRunResult } from "./workflow.js";
import type { ManifestIo } from "./workflow-pack-manifest.js";
import { parseWorkflowScript } from "./workflow-script-parser.js";

/** Hash of run args for run-meta.json (decision 11). */
function inputHash(args: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(args ?? null))
    .digest("hex")
    .slice(0, 12);
}

/** Filesystem-safe compact ISO timestamp for output subdir naming (decision 11).
 *  Ms-precision: same-ms collisions are disambiguated at the call site (-2, -3, …). */
function compactTimestamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

/** Resolve a non-colliding run output dir: `<ts>`, or `<ts>-2`, `<ts>-3`, … if the
 *  base name is already taken (decision 11: never overwrite a prior run's output).
 *  Synchronous callers only — there must be no `await` between this and `mkdirSync`
 *  so two runs cannot interleave in the exists/mkdir window. */
export function uniqueOutputDir(outputsDir: string, ts: string): string {
  let runOut = join(outputsDir, ts);
  let variant = 2;
  while (existsSync(runOut)) {
    runOut = join(outputsDir, `${ts}-${variant++}`);
  }
  return runOut;
}

/** In-flight registry id for a workflow run (decision 03 = b2). Prefixed so it
 *  never collides with a subagent/subagents toolCallId (the registry's other keys). */
export function workflowInFlightId(runId: string): string {
  return `wf:${runId}`;
}

/** Compact one-line preview for the context-box header + /subagents row:
 *  "<name> · <currentPhase> · <finished>/<total> agents". Counts derive from the
 *  snapshot's agent list (the manager keeps `agents` authoritative; the rollup
 *  count fields are recomputed downstream by recomputeWorkflowSnapshot). */
export function workflowPreview(snapshot: WorkflowSnapshot): string {
  const total = snapshot.agents.length;
  const finished = snapshot.agents.filter(
    (a) => a.status === "done" || a.status === "error" || a.status === "skipped",
  ).length;
  const phase = snapshot.currentPhase ? ` · ${snapshot.currentPhase}` : "";
  const counts = total > 0 ? ` · ${finished}/${total} agents` : "";
  return `${snapshot.name}${phase}${counts}`;
}

export interface ManagedRun {
  runId: string;
  status: RunStatus;
  snapshot: WorkflowSnapshot;
  result?: WorkflowRunResult;
  error?: WorkflowError;
  controller: AbortController;
  startedAt: Date;
  /** The real script, kept so the run can be resumed. */
  script: string;
  args?: unknown;
  /** Accumulated agent results for resume (deterministic call index -> result). */
  journal: JournalEntry[];
  /** Serializable execution caps captured at start, persisted for resume(). */
  exec?: PersistedExecOptions;
  /** Cross-process execution lease for this run, when it is actively executing. */
  lease?: RunLease;
  /**
   * True when the run was started in the background (or resumed) and the caller is
   * not awaiting its result inline. Only background runs deliver their result back
   * into the conversation; a foreground sync run already returns it as the tool
   * result, so re-delivering would duplicate it.
   */
  background: boolean;
  /** Pack identity (decision 08); absent for inline scripts. Presence routes state to stateRoot. */
  packId?: string;
  /** Pack-local state root; when set, this run's persistence writes to <stateRoot>/runs. */
  stateRoot?: string;
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /** Replay these journaled agent results for the unchanged prefix (resume). */
  resumeJournal?: Map<number, JournalEntry>;
  /** Cap on total agents for this run. */
  maxAgents?: number;
  /** Per-agent timeout in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
  externalSignal?: AbortSignal;
  /** Called with the live snapshot on every progress event. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
  /** Hard token budget for this run; once spent reaches it, agent() throws. */
  tokenBudget?: number | null;
  /** Max concurrent agents for this execution. */
  concurrency?: number;
  /** Retry attempts after recoverable agent failures for this execution. */
  agentRetries?: number;
  /** Resolve a checkpoint() question with a human reply (only for UI-bearing runs). */
  confirm?: (promptText: string, options: unknown) => Promise<unknown>;
  /** Pack identity (decision 08); absent for inline scripts. Presence routes state to stateRoot. */
  packId?: string;
  /** Pack-local state root; when set, this run's persistence writes to <stateRoot>/runs. */
  stateRoot?: string;
  /** Pack intermediate dir; onAgentJournal mirrors here when io.intermediate.persist. */
  intermediateDir?: string;
  /** Pack outputs dir; run end appends <outputsDir>/<ts>/. */
  outputsDir?: string;
  /** Pack io contract (decision 05). */
  io?: ManifestIo;
}

export interface WorkflowManagerOptions {
  cwd?: string;
  concurrency?: number;
  /** Resolve a saved-workflow name to its script, enabling nested `workflow('name')`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /** Inject a custom agent runner (tests); defaults to a real subagent session. */
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  mainModel?: string;
  /** The pi session id to tag runs with (see setSessionId). */
  sessionId?: string;
  /** Default per-agent timeout when a run does not pass agentTimeoutMs. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
  /**
   * Extension-registered tool definitions inherited from the parent session.
   * Passed through to child WorkflowAgent sessions so workflow subagents can
   * call the same extension tools the parent session has.
   */
  extensionTools?: ToolDefinition[];
  /**
   * Shared in-flight registry (decision 03 = b2). When set, every run registers
   * into it on start and deregisters on completion, so the unified
   * subagent-context box AND /subagents show workflow runs alongside
   * subagent/subagents runs. Per-WORKFLOW granularity (one entry per run). Optional so tests/hosts that don't care about the box stay unaffected.
   */
  inFlight?: SubagentInFlightRegistry;
}

/** Project the serializable caps out of ExecOptions (drops signals/callbacks). */
function toPersistedExec(exec: ExecOptions): PersistedExecOptions {
  const {
    maxAgents,
    agentTimeoutMs,
    tokenBudget,
    concurrency,
    agentRetries,
    packId,
    stateRoot,
    intermediateDir,
    outputsDir,
    io,
  } = exec;
  return {
    maxAgents,
    agentTimeoutMs,
    tokenBudget,
    concurrency,
    agentRetries,
    packId,
    stateRoot,
    intermediateDir,
    outputsDir,
    io,
  };
}

export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
  private persistence: RunPersistence;
  private persistences = new Map<string, RunPersistence>();

  /** Resolve the persistence for a run: a cached stateRoot store for packs, else the cwd store. */
  private persistenceFor(stateRoot?: string): RunPersistence {
    if (!stateRoot) return this.persistence;
    let p = this.persistences.get(stateRoot);
    if (!p) {
      p = createRunPersistence(this.cwd, undefined, stateRoot);
      this.persistences.set(stateRoot, p);
    }
    return p;
  }

  /** Locate a run across stores: the cwd store first, then cached pack stores.
   *  Covers in-session delivery/resume/delete of pack runs — the pack store is
   *  cached the moment executeRun starts the run in this process, so a background
   *  pack run that finishes in-session is found here. Cross-session pack-run
   *  redelivery (originating session closed before finish → cold cache) needs a
   *  pack-store registry / fs scan and is deferred to Plan C. */
  private locateRun(runId: string): { run: PersistedRunState; persistence: RunPersistence } | null {
    const cwdHit = this.persistence.load(runId);
    if (cwdHit) return { run: cwdHit, persistence: this.persistence };
    for (const p of this.persistences.values()) {
      const r = p.load(runId);
      if (r) return { run: r, persistence: p };
    }
    return null;
  }

  private cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  private mainModel?: string;
  /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
  private sessionId?: string;
  private defaultAgentTimeoutMs: number | null;
  private defaultAgentRetries: number;
  private extensionTools: ToolDefinition[];
  private hostFns?: HostFnRegistry;
  /** Shared in-flight registry (decision 03 = b2); undefined in hosts that don't
   *  surface the subagent-context box. Late-bindable via setInFlight(). */
  private inFlight?: SubagentInFlightRegistry;

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.sessionId = options.sessionId;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.extensionTools = options.extensionTools ?? [];
    this.inFlight = options.inFlight;
    this.persistence = createRunPersistence(this.cwd);
    this.recoverStaleRuns();
  }

  /** Bind the manager to the current pi session, so new runs are tagged with it and
   * the navigator/task-panel show only this session's runs (set on session_start). */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /**
   * Inject extension-registered tool definitions after construction.
   * Called from the workflow extension's session_start handler once the
   * extension runtime has registered all tools. These tools are then
   * passed to child WorkflowAgent sessions via createAgentSession() so
   * workflow subagents can call extension tools the parent session has.
   */
  setExtensionTools(tools: ToolDefinition[]): void {
    this.extensionTools = tools;
  }

  /**
   * Bind the session-scoped host-fn registry (sub-project ②). The registry is
   * mutated in place as `workflow:hostfn:v1:register` events arrive, so runs
   * started after late registrations still see them. `undefined` = no host fns.
   */
  setHostFns(registry: HostFnRegistry | undefined): void {
    this.hostFns = registry;
  }

  /**
   * Late-bind the shared in-flight registry (decision 03 = b2). Mirrors
   * setMainModel/setHostFns: the workflow tool threads the singleton obtained
   * from getSubagentInFlightRegistry() into the manager after construction, so
   * every run (tool + /workflows command + resume) registers into the SAME
   * registry the subagent/subagents tools and the context box read. Idempotent.
   */
  setInFlight(registry: SubagentInFlightRegistry | undefined): void {
    this.inFlight = registry;
  }

  /**
   * On startup, any persisted run still marked "running" belongs to a process
   * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
   * to "paused" — never "failed" — so its journal is preserved and resume() can
   * replay the completed prefix and finish the rest.
   */
  private recoverStaleRuns(): void {
    try {
      for (const p of this.listAllRuns()) {
        if (p.status === "running" && !this.runs.has(p.runId)) {
          const lease = this.persistence.acquireRunLease(p.runId);
          if (!lease) continue;
          try {
            this.persistence.save({ ...p, status: "paused" });
          } finally {
            this.persistence.releaseRunLease(lease);
          }
        }
      }
    } catch {
      // Recovery is best-effort; never let it block manager construction.
    }
  }

  /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
  setMainModel(spec: string | undefined): void {
    this.mainModel = spec;
  }

  /**
   * The session's current model (provider/id), captured at session_start. Used by
   * the `subagent` tool so an untagged dispatch defaults to the live session model
   * instead of a stale medium tier. Undefined before session_start fires.
   */
  getMainModel(): string | undefined {
    return this.mainModel;
  }

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const runId = generateRunId();
    const controller = new AbortController();
    const parsed = parseWorkflowScript(script);
    const persistence = this.persistenceFor(exec.stateRoot);
    const lease = persistence.acquireRunLease(runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${runId}`);

    const managed: ManagedRun = {
      runId,
      stateRoot: exec.stateRoot,
      packId: exec.packId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script,
      args,
      journal: [],
      background: true,
      lease,
      exec: toPersistedExec(exec),
    };

    this.runs.set(runId, managed);

    try {
      // Persist initial state
      persistence.save({
        runId,
        workflowName: parsed.meta.name,
        script,
        args,
        exec: managed.exec,
        sessionId: this.sessionId,
        packId: managed.packId,
        background: true,
        status: "running",
        phases: managed.snapshot.phases,
        agents: [],
        logs: [],
        startedAt: managed.startedAt.toISOString(),
        updatedAt: managed.startedAt.toISOString(),
      });
    } catch (err) {
      this.releaseRunLease(managed);
      this.runs.delete(runId);
      throw err;
    }

    // Run workflow asynchronously.
    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    const promise = this.executeRun(managed, script, args, exec);
    promise.catch(() => {});

    return { runId, promise };
  }

  /**
   * Execute a workflow synchronously (blocking) while still tracking it like a
   * background run, so the `/workflows` navigator and the live task panel see it.
   * `onProgress` fires on every progress event with the current snapshot, letting
   * a caller (e.g. the workflow tool) drive its own inline display.
   */
  async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const managed = this.createManaged(script, args);
    managed.exec = toPersistedExec(exec);
    managed.stateRoot = exec.stateRoot;
    managed.packId = exec.packId;
    const persistence = this.persistenceFor(exec.stateRoot);
    const lease = persistence.acquireRunLease(managed.runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
    managed.lease = lease;
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    this.persistRun(managed);
    return this.executeRun(managed, script, args, exec);
  }

  /** Build a fresh managed run with an empty snapshot. */
  private createManaged(script: string, args?: unknown): ManagedRun {
    const parsed = parseWorkflowScript(script);
    return {
      runId: generateRunId(),
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller: new AbortController(),
      startedAt: new Date(),
      script,
      args,
      journal: [],
      background: false,
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    // Register into the shared in-flight registry (decision 03 = b2) FIRST, before
    // any await: executeRun is async, so this synchronous head runs DURING the
    // startInBackground()/runSync() call itself — for a background run the entry
    // is live BEFORE startInBackground returns its runId, so the context box
    // shows it immediately even though the run is detached. Per-WORKFLOW
    // granularity (one entry per run). foreground mirrors `managed.background`
    // inverted: background run → foreground:false (box shows it); foreground
    // runSync → foreground:true (excluded from the box, rendered inline by the
    // workflow tool's own component — no duplication with Surface A).
    this.registerInFlight(managed);
    const {
      resumeJournal,
      maxAgents,
      agentTimeoutMs,
      externalSignal,
      onProgress,
      tokenBudget,
      concurrency,
      agentRetries,
      confirm,
    } = exec;
    // Thread pack fields onto the managed run so persistRun/releaseRunLease
    // route through the correct persistence store.
    managed.stateRoot = exec.stateRoot;
    managed.packId = exec.packId;
    const resolvedAgentTimeoutMs = agentTimeoutMs !== undefined ? agentTimeoutMs : this.defaultAgentTimeoutMs;
    const resolvedConcurrency = concurrency ?? this.concurrency;
    const resolvedAgentRetries = agentRetries ?? this.defaultAgentRetries;
    // Capture the raw (un-defaulted) caps so persistRun writes them and resume()
    // re-runs with the SAME budget/limits instead of resetting to defaults.
    // (Start paths set this before their initial persist; this re-capture covers
    // resume(), whose fresh ManagedRun is built without exec.)
    managed.exec = toPersistedExec(exec);
    const progress = () => {
      onProgress?.(managed.snapshot);
      // Refresh the registry entry's preview (phase / k-of-N agents) on every
      // progress event — covers BOTH modes (background runs have no tool-layer
      // onProgress; the manager's events drive this).
      this.updateInFlight(managed);
    };
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    if (externalSignal) {
      if (externalSignal.aborted) managed.controller.abort();
      else externalSignal.addEventListener("abort", () => managed.controller.abort(), { once: true });
    }
    try {
      const result = await runWorkflow(script, {
        cwd: this.cwd,
        args,
        agent: this.agent,
        mainModel: this.mainModel,
        extensionTools: this.extensionTools,
        hostFns: this.hostFns,
        signal: managed.controller.signal,
        concurrency: resolvedConcurrency,
        agentRetries: resolvedAgentRetries,
        maxAgents,
        agentTimeoutMs: resolvedAgentTimeoutMs,
        tokenBudget,
        confirm,
        loadSavedWorkflow: this.loadSavedWorkflow,
        resumeJournal,
        resumeFromRunId: resumeJournal ? managed.runId : undefined,
        onAgentJournal: (entry) => {
          // Append (crash-safe-ish): keep the latest entry per index, then persist.
          managed.journal = managed.journal.filter((e) => e.index !== entry.index);
          managed.journal.push(entry);
          if (exec.io?.intermediate?.persist && exec.intermediateDir) {
            mirrorIntermediate(exec.intermediateDir, entry.phase, entry);
          }
          this.persistRun(managed);
        },
        onLog: (message) => {
          managed.snapshot.logs.push(message);
          this.emit("log", { runId: managed.runId, message });
          progress();
        },
        onPhase: (title) => {
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          this.emit("phase", { runId: managed.runId, title });
          progress();
        },
        onAgentStart: (event) => {
          managed.snapshot.agents.push({
            id: managed.snapshot.agents.length + 1,
            callIndex: event.callIndex,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
            model: event.model,
            startedAt: Date.now(),
          });
          this.emit("agentStart", { runId: managed.runId, ...event });
          progress();
        },
        onAgentEnd: (event) => {
          const agent = [...managed.snapshot.agents]
            .reverse()
            .find((a) => a.callIndex === event.callIndex && a.status === "running");
          if (agent) {
            agent.status = event.result === null ? "error" : "done";
            agent.resultPreview = preview(event.result);
            agent.error = event.error;
            agent.errorCode = event.errorCode;
            agent.recoverable = event.recoverable;
            agent.tokens = event.tokens;
            if (event.model) agent.model = event.model;
          }
          this.emit("agentEnd", { runId: managed.runId, ...event });
          progress();
        },
        onAgentHistory: (event) => {
          const agent = [...managed.snapshot.agents]
            .reverse()
            .find((a) => a.callIndex === event.callIndex && a.status === "running");
          if (agent) {
            agent.history = event.history;
          }
          this.emit("agentHistory", { runId: managed.runId, ...event });
          progress();
        },
        onTokenUsage: (usage) => {
          managed.snapshot.tokenUsage = usage;
          this.emit("tokenUsage", { runId: managed.runId, usage });
          progress();
        },
      });

      managed.status = "completed";
      managed.result = result;
      this.emit("complete", { runId: managed.runId, result });

      // Write outputs/<ts>/result.json + run-meta.json when outputsDir is set (decision 11).
      if (exec.outputsDir) {
        try {
          const ts = compactTimestamp();
          // Decision 11 guarantees no overwrite. compactTimestamp() is ms-precision,
          // so near-instant repeat runs (or a coarse runner clock) can collide;
          // uniqueOutputDir disambiguates with a sequential -2/-3… suffix. This
          // block is synchronous (no awaits) so two runs cannot interleave here.
          const runOut = uniqueOutputDir(exec.outputsDir, ts);
          mkdirSync(runOut, { recursive: true });
          writeFileSync(join(runOut, "result.json"), JSON.stringify(result.result ?? null, null, 2));
          writeFileSync(
            join(runOut, "run-meta.json"),
            JSON.stringify(
              {
                runId: managed.runId,
                packId: managed.packId,
                inputHash: inputHash(args),
                startedAt: managed.startedAt.toISOString(),
                finishedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
          );
        } catch {
          // outputs/<ts>/ is an inspection aid, never a correctness gate.
        }
      }

      // Persist final state
      this.persistRun(managed);
      this.releaseRunLease(managed);

      return result;
    } catch (error) {
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(
              error instanceof Error ? error.message : String(error),
              WorkflowErrorCode.WORKFLOW_ABORTED,
              { recoverable: true },
            );

      const intentionalAbort = managed.controller.signal.aborted;
      const usageLimitPaused = !intentionalAbort && workflowError.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
      // The run is over either way — abort the controller so in-flight sibling
      // agents (spawned by parallel()/pipeline() before the failure) stop
      // instead of running to completion for a run that is already dead.
      // No-op for the intentional pause/stop/Esc paths, which aborted already.
      if (!intentionalAbort) managed.controller.abort();
      if (intentionalAbort) {
        // Intentional abort (pause/stop/Esc) — preserve status set by pause()/stop()
        if (managed.status === "running") {
          managed.status = "aborted";
        }
      } else if (usageLimitPaused) {
        // Provider quota/usage limit: NOT a failure. Checkpoint the run as paused so
        // the persisted journal (completed agent results) is replayed by resume()
        // once the budget refills — instead of the user starting from scratch.
        managed.status = "paused";
      } else {
        managed.status = "failed";
      }
      managed.error = workflowError;
      if (usageLimitPaused) {
        this.emit("paused", {
          runId: managed.runId,
          reason: "usage_limit",
          error: workflowError,
          resetHint: workflowError.resetHint,
        });
      } else {
        this.emit("error", { runId: managed.runId, error: workflowError });
      }

      // Persist final state
      this.persistRun(managed);
      this.releaseRunLease(managed);

      throw workflowError;
    } finally {
      // Always deregister — success, error, abort, AND usage-limit pause all end
      // the run's live footprint. A paused run is NOT running, so removing it is
      // correct; resume() re-registers via executeRun's head. This guarantees no
      // entry leaks in the context box / /subagents, including the detached
      // background completion path (the whole point of decision 03 = b2).
      this.endInFlight(managed);
    }
  }

  /** Register this run into the shared in-flight registry (decision 03 = b2).
   *  See executeRun's head comment for the synchronous-before-await guarantee
   *  that makes background runs appear in the box immediately. No-op when no
   *  registry is bound (tests/hosts without the context box). */
  private registerInFlight(managed: ManagedRun): void {
    if (!this.inFlight) return;
    this.inFlight.start({
      id: workflowInFlightId(managed.runId),
      agent: "workflow",
      // model omitted: a workflow aggregates agents across models, so it has no
      // single model. The context box renders a workflow-specific header;
      // /subagents omits the model segment for entries without one.
      taskPreview: workflowPreview(managed.snapshot),
      startedAt: managed.startedAt.getTime(),
      foreground: !managed.background,
    });
  }

  /** Refresh the registry entry's taskPreview (phase / k-of-N agents) on every
   *  progress event. No-op when no registry / entry is gone (e.g. racing end). */
  private updateInFlight(managed: ManagedRun): void {
    if (!this.inFlight) return;
    const entry = this.inFlight.get(workflowInFlightId(managed.runId));
    if (entry) entry.taskPreview = workflowPreview(managed.snapshot);
  }

  /** Remove the registry entry on run completion. Idempotent (registry.end is a
   *  delete-by-key no-op when absent). No-op when no registry is bound. */
  private endInFlight(managed: ManagedRun): void {
    this.inFlight?.end(workflowInFlightId(managed.runId));
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    this.persistenceFor(managed.stateRoot).releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  private persistRun(managed: ManagedRun) {
    // Refuse stale writes: once this ManagedRun was superseded in the map (a
    // resume() created a fresh run object for the same runId), a late write from
    // the old executeRun's teardown would clobber the newer state — e.g. the
    // resumed run's "running" record + fresh journal overwritten by the paused
    // run's dying snapshot. (Cross-PROCESS staleness is still governed by the
    // run lease at acquire time; save() itself does not verify lock ownership.)
    if (this.runs.get(managed.runId) !== managed) return;
    try {
      const p = this.persistenceFor(managed.stateRoot);
      p.save({
        runId: managed.runId,
        workflowName: managed.snapshot.name,
        // Persist the real script + journal so the run can be resumed. Runs live
        // in workflow run storage — protect via directory permissions, not blanking.
        script: managed.script,
        args: managed.args,
        exec: managed.exec,
        sessionId: this.sessionId,
        packId: managed.packId,
        background: managed.background,
        journal: managed.journal,
        status: managed.status,
        // Why a usage-limit pause happened, so the navigator / a future cold start
        // can show it and (eventually) re-arm resume after the budget refills.
        pauseReason:
          managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
            ? "usage_limit"
            : undefined,
        resetHint:
          managed.status === "paused" && managed.error?.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT
            ? managed.error.resetHint
            : undefined,
        phases: managed.snapshot.phases,
        currentPhase: managed.snapshot.currentPhase,
        agents: managed.snapshot.agents.map((a) => ({
          ...a,
          startedAt: managed.startedAt.toISOString(),
          endedAt: new Date().toISOString(),
        })),
        logs: managed.snapshot.logs,
        result: managed.result?.result,
        tokenUsage: managed.snapshot.tokenUsage
          ? {
              input: managed.snapshot.tokenUsage.input,
              output: managed.snapshot.tokenUsage.output,
              total: managed.snapshot.tokenUsage.total,
              cost: managed.snapshot.tokenUsage.cost,
              cacheRead: managed.snapshot.tokenUsage.cacheRead,
              cacheWrite: managed.snapshot.tokenUsage.cacheWrite,
            }
          : undefined,
        startedAt: managed.startedAt.toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
        durationMs: managed.result?.durationMs,
      });
    } catch (err) {
      // Persistence is best-effort: the run is still healthy in memory.
      // Log so an operator debugging state-loss has a lead, but never crash
      // the workflow over a disk-full situation.
      console.warn("[workflow-manager] Persist run failed:", err);
    }
  }

  /**
   * Pause a running workflow.
   */
  pause(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;

    managed.controller.abort();
    managed.status = "paused";
    this.emit("paused", { runId });
    this.persistRun(managed);
    this.releaseRunLease(managed);
    return true;
  }

  /**
   * Resume an interrupted run: replay journaled results for the unchanged prefix
   * and run the rest live. Returns false if there is nothing resumable.
   */
  async resume(runId: string): Promise<boolean> {
    // Guard: refuse to resume a run that is already running, or one that was
    // intentionally aborted (pause/stop/Esc). Paused and failed runs can restart.
    const active = this.runs.get(runId);
    if (active?.status === "running") return false;
    if (active?.status === "aborted") return false;

    const located = this.locateRun(runId);
    const persisted = located?.run ?? null;
    if (!persisted?.script || persisted.status === "completed" || persisted.status === "aborted") return false;
    const persistence = located?.persistence ?? this.persistence;
    const lease = persistence.acquireRunLease(runId);
    if (!lease) return false;

    const controller = new AbortController();
    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        phases: persisted.phases ?? [],
        logs: persisted.logs ?? [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script: persisted.script,
      args: persisted.args,
      journal: persisted.journal ?? [],
      background: true,
      lease,
    };
    this.runs.set(runId, managed);

    const resumeJournal = new Map((persisted.journal ?? []).map((e) => [e.index, e] as const));
    this.emit("resumed", { runId });
    // Run in the background; executeRun records status/errors on the managed run.
    // Rehydrate the caps the run was started with (token budget, maxAgents, …)
    // so e.g. a run paused for exhausting its budget does not resume unbounded.
    void this.executeRun(managed, persisted.script, persisted.args, {
      resumeJournal,
      ...(persisted.exec ?? {}),
    }).catch(() => {});
    return true;
  }

  /**
   * Stop a running workflow.
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (!managed || (managed.status !== "running" && managed.status !== "paused")) return false;

    managed.controller.abort();
    managed.status = "aborted";
    this.emit("stopped", { runId });
    this.persistRun(managed);
    this.releaseRunLease(managed);
    return true;
  }

  /**
   * Get status of a specific run.
   */
  getRun(runId: string): ManagedRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * List all runs (active + persisted).
   */
  /**
   * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
   * that session's runs are returned — runs from other sessions stay on disk and
   * reappear when you switch back. Unbound (tests/legacy) returns everything.
   */
  listRuns(): PersistedRunState[] {
    const all = this.persistence.list();
    return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  /**
   * Load a persisted run by id regardless of session — used by `/workflows result`
   * so a run started in a now-closed session (whose result was never delivered)
   * is still retrievable. Returns null if the run id is unknown in this project.
   */
  getPersistedRun(runId: string): PersistedRunState | null {
    return this.locateRun(runId)?.run ?? null;
  }

  /**
   * Mark a background run's result as delivered (into a conversation), stamping
   * `deliveredAt`. Idempotent: re-saving a run that already has a `deliveredAt`
   * only overwrites it with a newer timestamp. Used by installResultDelivery's
   * complete handler and by session_start re-delivery so each run is delivered
   * exactly once across the process lifetime + across sessions.
   */
  markDelivered(runId: string): void {
    const located = this.locateRun(runId);
    if (!located) return;
    try {
      located.persistence.save({ ...located.run, deliveredAt: new Date().toISOString() });
    } catch {
      // Best-effort: a failed mark just means the run may redeliver once more — harmless.
    }
  }

  /**
   * Completed background runs whose result was never delivered — eligible for
   * session_start re-delivery. Cross-session by design: the originating session
   * closed before the run finished (e.g. a `-p` batch run), so its result is
   * stranded on disk. Returned oldest-first so multiple recoveries read in order.
   * Runs persisted before the `background` field existed are excluded (absent →
   * not eligible); recover those via `/workflows result <id>`.
   */
  listUndeliveredCompletedBackgroundRuns(): PersistedRunState[] {
    // Scan the cwd store + every cached pack store so an in-session pack run
    // that finished is redeliverable. Cross-session pack runs (cold cache) are a
    // known gap (Plan C: needs a pack-store registry / fs scan).
    const all = [this.persistence, ...this.persistences.values()].flatMap((p) => p.list());
    return all
      .filter((r) => r.background === true && r.status === "completed" && !r.deliveredAt)
      .sort((a, b) => (a.completedAt ?? a.updatedAt).localeCompare(b.completedAt ?? b.updatedAt));
  }

  /**
   * Get snapshot of a run.
   */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  /**
   * Delete a persisted run.
   */
  deleteRun(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed) this.releaseRunLease(managed);
    this.runs.delete(runId);
    const located = this.locateRun(runId);
    return located ? located.persistence.delete(runId) : this.persistence.delete(runId);
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }
}
