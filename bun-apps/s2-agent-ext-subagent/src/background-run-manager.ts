/**
 * BackgroundRunManager — the roster of background-from-birth subagent dispatches
 * (spawn_subagent `background:true`) and the completion-notifier behind them.
 *
 * Division of labor: the in-flight registry owns OBSERVABLE state (dock, viewer,
 * notify lines); this manager owns POST-COMPLETION ACTION — formatting the
 * <task-notification> and delivering it to the parent via the extension's
 * cached `pi.sendMessage(msg, { deliverAs: "followUp" })` (queued while the
 * parent turn is busy, delivered when idle — the seam btw uses for handoffs).
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

export type BackgroundRunStatus = "done" | "failed" | "timedout" | "budget" | "turns" | "aborted" | "running";

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
  const usage = outcome.usage ? `${outcome.usage.input}in / ${outcome.usage.output}out ($${outcome.usage.cost})` : "—";
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

  /** Wired by the extension entry: `(msg) => pi.sendMessage(msg, { deliverAs: "followUp" })`. Undefined = no wake (background still runs; results live in persistence). */
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
        try {
          this.deliverer?.(formatTaskNotification(spec, outcome));
        } catch {
          // silent by design — the run is already persisted; no retry
        }
      })
      .finally(() => {
        this.runs.delete(spec.id);
      });
  }

  runningIds(): string[] {
    return [...this.runs.keys()];
  }
}

let singleton: BackgroundRunManager | undefined;

export function getBackgroundRunManager(): BackgroundRunManager {
  singleton ??= new BackgroundRunManager();
  return singleton;
}
