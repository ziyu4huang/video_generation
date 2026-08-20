/**
 * session-state.ts — session-scoped "a movie run has happened" flag.
 *
 * The movie-director tool-scope guard exists to constrain the movie-DRIVING
 * agent (the #291 ungrounded-edit class: an unsupervised LLM driving the
 * `movie` tool edited repo infra on a wrong diagnosis). In a session with NO
 * movie activity there is nothing to guard against, so the guard is a NO-OP
 * until the first movie command/host-fn fires (markMovieActive).
 *
 * Sticky for the session: movie production spans many turns (idea→assets→edit
 * →compose), and a movie session rarely mixes with bun-apps/ repo editing, so
 * arm-once-then-on matches the real workflow. Reset only by process restart
 * (or _resetMovieActiveForTests). The MD_TOOL_SCOPE_DISABLE env bypass still
 * overrides even when the guard is armed.
 *
 * Pure Bun (no pi-SDK) so it is unit-testable in isolation. Consumed by:
 *   • tool-scope.ts scopeViolationForToolCall — reads isMovieActive() to gate.
 *   • host-fns.ts buildMovieHostFnEntries — marks active on every movie.* call
 *     (covers both the event-bus + explicit-registry workflow paths).
 *   • extensions/movie-director.ts movie tool execute — marks active on the
 *     agent-driven path (calls dispatch() directly, bypassing host-fns).
 */
let movieActive = false;

/** Arm the guard for the rest of the session. Idempotent. */
export function markMovieActive(): void {
  movieActive = true;
}

/** True once any movie command/host-fn has fired this session. */
export function isMovieActive(): boolean {
  return movieActive;
}

/** Test-only: reset the session flag between tests. */
export function _resetMovieActiveForTests(): void {
  movieActive = false;
}
