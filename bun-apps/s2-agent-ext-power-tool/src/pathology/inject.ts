/**
 * Opt-in model-visible pathology note (ticket 04, decision D2).
 *
 * CC surfaces repeated identical failures TO THE MODEL so it can change
 * strategy. s2's pathology warnings are status-line-only by design — the
 * documented non-invasive contract (CONTEXT.md "Proactive warning") — so the
 * model-visible path is a hard OPT-IN: `BUN_PI_PATHOLOGY_INJECT=1`. Default
 * (unset) preserves the contract exactly: zero model-visible output.
 *
 * Mechanics: the warner (warning.ts) fires onNewEpisode once per (check, tool)
 * signature per active episode; when the env gate is set that arms a PENDING
 * note for the session. The factory's `before_agent_start` handler — the turn
 * boundary, which by construction cannot fire mid-stream — takes the pending
 * note and returns it as a CustomMessage injected alongside the next user
 * message (same trust model as CC's compact summaries: a system note phrased as
 * advice, never a turn hijack). Episode end (no high finding) drops the pending
 * note, re-arming for the next episode.
 *
 * State is keyed per sessionId like the accumulator, so an in-process subagent
 * child arms and consumes its OWN note.
 */
import type { Finding } from "../findings.ts";

const INJECT_ENV = "BUN_PI_PATHOLOGY_INJECT";

/** The opt-in gate. Default OFF — the non-invasive status-line contract holds unless explicitly enabled. */
export function injectionEnabled(): boolean {
  return process.env[INJECT_ENV] === "1";
}

/** CC-style note text for a high finding. PURE. */
export function noteText(f: Finding): string {
  const d = (f.detail ?? {}) as Record<string, unknown>;
  const tool = (d.tool as string) ?? "?";
  const n = (d.count as number) ?? (d.consecutive as number) ?? "?";
  const what = f.check === "consecutive-error" ? `failed ${n}× consecutively` : `called ${n}× with identical args`;
  return (
    `system note: ${tool} ${what} — you appear to be repeating the same failing action. ` +
    `Change strategy or call inspect_pathology for the full report.`
  );
}

// ─── per-session pending state ───────────────────────────────────────────────

interface InjectionState {
  /** Pending note armed by this session's current episode, awaiting the next turn boundary. */
  pending?: string;
}

const states = new Map<string, InjectionState>();

function state(sid?: string): InjectionState {
  const key = sid ?? "";
  let s = states.get(key);
  if (!s) {
    s = {};
    states.set(key, s);
  }
  return s;
}

/** Episode hooks the warner fires — the injection arming side of ticket 04. */
export interface InjectionHooks {
  onNewEpisode: (worst: Finding) => void;
  onEpisodeEnd: () => void;
}

/**
 * Build the warner-facing hooks for a session. Both hooks no-op unless the env
 * gate is set, so default sessions keep zero model-visible output no matter how
 * the warner is wired.
 */
export function makeInjectionHooks(sid?: string): InjectionHooks {
  return {
    onNewEpisode(worst) {
      if (!injectionEnabled()) return;
      state(sid).pending = noteText(worst);
    },
    onEpisodeEnd() {
      const s = states.get(sid ?? "");
      if (s) s.pending = undefined;
    },
  };
}

/**
 * Take (and clear) the pending note for a session — called by the factory's
 * `before_agent_start` handler, which returns it as the injected CustomMessage.
 * One note per turn boundary: the take clears, and the next episode re-arms.
 */
export function takePendingNote(sid?: string): string | undefined {
  const s = states.get(sid ?? "");
  if (!s) return undefined;
  const note = s.pending;
  s.pending = undefined;
  return note;
}

/** Reset injection state. No-arg / undefined = clear ALL sessions; a sid = drop just that session. */
export function resetInjection(sid?: string): void {
  if (sid === undefined) states.clear();
  else states.delete(sid);
}
