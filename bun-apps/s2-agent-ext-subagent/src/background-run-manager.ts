/**
 * BackgroundRunManager — the roster of background-from-birth subagent dispatches
 * (spawn_subagent `background:true`) and the completion-notifier behind them.
 *
 * Division of labor: the in-flight registry owns OBSERVABLE state (dock, viewer,
 * notify lines); this manager owns POST-COMPLETION ACTION — formatting the
 * <task-notification> and delivering it to the parent via the extension's
 * cached `pi.sendMessage(<CustomMessage>, { deliverAs: "followUp" })` (queued while
 * the parent turn is busy, delivered when idle — the seam btw uses for handoffs).
 *
 * Delivery is best-effort and silent on failure (no retry, never throws into
 * the parent): the completed run is already in run-persistence, so the next
 * list_subagent_runs still sees it. Singleton idiom: same shape as the two
 * registries (module-local lazy singleton).
 */
import type { AgentUsage } from "@repo/s2-agent-core-runtime";

export interface BackgroundRunSpec {
  id: string;
  agent?: string;
  model: string;
  taskPreview: string;
  startedAt: number;
}

/**
 * `detached` is DEFENSIVE-ONLY: structurally unreachable on the background
 * path — the Task 05 detach (alt+s / in-viewer ctrl+b → convertToBackground)
 * refuses already-background runs (ctrl-b.ts foregroundRunIds() filters
 * views({foreground: true}), and background runs register foreground:false).
 * The union member is kept so a future invariant break degrades to an
 * as-is status report rather than a type hole.
 */
export type BackgroundRunStatus =
  | "done"
  | "failed"
  | "timedout"
  | "budget"
  | "turns"
  | "aborted"
  | "detached"
  | "running";

export interface BackgroundRunOutcome {
  status: BackgroundRunStatus;
  output?: string;
  usage?: AgentUsage;
}

/** Preview budget: enough for the parent to decide "use as-is" vs "fetch full", small enough that several notifications landing together don't flood its context. */
const PREVIEW_CHARS = 600;

export function formatTaskNotification(spec: BackgroundRunSpec, outcome: BackgroundRunOutcome): string {
  const preview = outcome.output
    ? outcome.output.length > PREVIEW_CHARS
      ? `${outcome.output.slice(0, PREVIEW_CHARS)}\n[truncated]`
      : outcome.output
    : "(no output)";
  // cost fixed to 3 decimals — same precision as the render layer (raw floats
  // like $0.0123456 read as noise in a notification line).
  const usage = outcome.usage
    ? `${outcome.usage.input}in / ${outcome.usage.output}out ($${outcome.usage.cost.toFixed(3)})`
    : "—";
  return [
    "<task-notification>",
    `Background subagent run ${spec.id} completed.`,
    `- agent: ${spec.agent ?? "default"}  model: ${spec.model}`,
    `- status: ${outcome.status}`,
    `- usage: ${usage}`,
    `- result preview:`,
    preview,
    `Full output: call list_subagent_runs with subcommand "get", id "${spec.id}".`,
    "</task-notification>",
  ].join("\n");
}

/** Concurrent-background ceiling. Env override read at call time; invalid values silently ignored (SUBAGENT_MAX_TURNS idiom). */
export function backgroundCap(): number {
  const raw = process.env.SUBAGENT_MAX_BACKGROUND;
  if (raw === undefined) return 4;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

export class BackgroundRunManager {
  /** The roster: claimed ids awaiting completion (claimed at dispatch, freed in track's finally). */
  private runs = new Map<string, BackgroundRunSpec>();
  private deliverer: ((msg: string) => void) | undefined;

  /** Wired by the extension entry via wireBackgroundDeliverer: wraps the notification string in a CustomMessage and sends it `deliverAs: "followUp"`. Undefined = no wake (background still runs; results live in persistence). */
  setDeliverer(fn: ((msg: string) => void) | undefined): void {
    this.deliverer = fn;
  }

  /** Reserve a background slot BEFORE dispatching. No queueing — a full cap fails fast. */
  claim(id: string): { ok: true } | { ok: false; error: string } {
    if (this.runs.has(id)) return { ok: true }; // re-claim of a live id is inert
    if (this.runs.size >= backgroundCap()) {
      return {
        ok: false,
        error: `background slot limit reached; ${this.runs.size} running (${[...this.runs.keys()].join(", ")}) — wait for one to complete (list_subagent_runs wait) or stop one (list_subagent_runs stop), or raise SUBAGENT_MAX_BACKGROUND.`,
      };
    }
    this.runs.set(id, { id, model: "default", taskPreview: "", startedAt: Date.now() });
    return { ok: true };
  }

  /** Register the completion promise for a claimed id. Owns slot release and notification delivery; never throws. */
  track(spec: BackgroundRunSpec, promise: Promise<BackgroundRunOutcome>): void {
    this.runs.set(spec.id, spec);
    promise
      .catch(
        (err): BackgroundRunOutcome => ({
          status: "failed",
          output: `background run threw: ${err instanceof Error ? err.message : String(err)}`,
        }),
      )
      .then((outcome) => {
        this.notify(spec, outcome);
      })
      .finally(() => {
        this.runs.delete(spec.id);
      });
  }

  /**
   * Deliver one task-notification WITHOUT a roster claim/track — the
   * send_message `wait:false` completion path (ticket 02): the exchange is
   * owned by the live agent, not a background slot. Best-effort and silent,
   * same contract as track's delivery.
   */
  notify(spec: BackgroundRunSpec, outcome: BackgroundRunOutcome): void {
    this.deliver(formatTaskNotification(spec, outcome));
  }

  /**
   * Deliver a caller-formatted notification string through the same seam —
   * for shapes that are NOT a background run completion (send_message
   * replies), where formatTaskNotification's "Full output: list_subagent_runs
   * get" pointer would resolve to the WRONG record (the first exchange's, by
   * agentId — follow-up exchanges are not persisted). Best-effort, silent.
   */
  deliver(message: string): void {
    try {
      this.deliverer?.(message);
    } catch {
      // silent by design — no retry
    }
  }

  runningIds(): string[] {
    return [...this.runs.keys()];
  }

  /**
   * Free a claimed slot WITHOUT a completion — the claim→track failure path in
   * the tool's background branch only (anything throwing between a successful
   * claim() and track() would otherwise leak the slot and permanently shrink
   * the cap). Normal completions release via track's finally.
   */
  release(id: string): void {
    this.runs.delete(id);
  }
}

let singleton: BackgroundRunManager | undefined;

export function getBackgroundRunManager(): BackgroundRunManager {
  singleton ??= new BackgroundRunManager();
  return singleton;
}

/**
 * Wire the singleton's deliverer to a pi-like sender. The notification string
 * is wrapped in a CustomMessage (`customType: "subagent-task-notification"`,
 * `display: true`) — sendMessage takes a message OBJECT, not a raw string
 * (same shape as ultracode's installResultDelivery).
 *
 * Wake semantics (agent-session sendCustomMessage): `deliverAs: "followUp"`
 * routes the message into the RUNNING turn when the parent is streaming, and
 * `triggerTurn: true` is what wakes an IDLE parent into a new turn — without
 * it the message is merely appended and no turn runs, silently breaking the
 * AUTO-WAKE promise for the exact case background dispatch targets. Sending
 * both (streaming → followUp queue, idle → fresh turn) mirrors task-panel's
 * installResultDelivery. Called once by the extension entry at load.
 * Best-effort: a host without sendMessage (or a wiring-time throw) degrades
 * to no-wake — results still land in run-persistence, so list_subagent_runs
 * keeps working.
 */
export function wireBackgroundDeliverer(
  pi: {
    sendMessage?: (
      message: { customType: string; content: string; display: boolean },
      opts?: { deliverAs?: "followUp" | "nextTurn" | "steer"; triggerTurn?: boolean },
    ) => void;
  },
  manager: BackgroundRunManager = getBackgroundRunManager(),
): void {
  try {
    manager.setDeliverer((msg) =>
      pi.sendMessage?.(
        { customType: "subagent-task-notification", content: msg, display: true },
        { deliverAs: "followUp", triggerTurn: true },
      ),
    );
  } catch {
    // best-effort only
  }
}
