/**
 * runner-hooks.ts — the runner-shape adapters behind hook observability: the known
 * event set, the in-place firing-count wrapper, and the raw `runner.extensions[]` →
 * typed-snapshot mapper.
 *
 * These sit BELOW the tool layer, not inside it. `sdk-patch.ts` calls
 * `wrapHookHandlers` and `collectHooks` from `applyContextPolyfills` — the lowest-level
 * runtime shim in the package — and it used to reach up into `tools/inspect-hooks.ts`
 * to do it, inverting the dependency direction (infra → tool). Everything here is
 * about the SDK's runner shape; nothing here renders. `tools/inspect-hooks.ts` keeps
 * the analysis and the report, and imports downward into this file.
 */

// ─── Known events (pi 0.82.0) ───────────────────────────────────────────────
// The on() overload string literals. A handler registered on an event NOT in
// this set can never fire → likely a typo. Keep in sync with the SDK's
// ExtensionEvent.type union if the SDK adds events.

export const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  "project_trust", "resources_discover",
  "session_start", "session_info_changed", "session_before_switch",
  "session_before_fork", "session_before_compact", "session_compact",
  "session_shutdown", "session_before_tree", "session_tree",
  "context", "before_provider_request", "before_provider_headers",
  "after_provider_response", "before_agent_start", "agent_start",
  "agent_end", "agent_settled", "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "model_select", "thinking_level_select", "tool_call", "tool_result",
  "user_bash", "input",
]);

// ─── Firing-count intercept (Phase 2) ───────────────────────────────────────
// Idempotent in-place counting wrapper installed on the live extension.handlers
// arrays. The SDK emit() (runner.js) calls createContext() at the top of every
// emit, then reads the LIVE handlers array (no captured copy), so replacing an
// array entry IN-PLACE intercepts dispatch. applyContextPolyfills() (sdk-patch.ts)
// calls wrapHookHandlers() on every createContext — i.e. before handlers run.
//
// Counters are keyed by the ORIGINAL handler fn (the wrapper closes over orig);
// readers of extension.handlers still see a callable fn delegating to orig, and
// getHookFiringCount() unwraps (via Symbols) so the live (post-wrap) array reads
// back the right count. Wrap is idempotent (Symbol guard) and cheap (one Symbol
// check per handler per emit — createContext is on the hot emit path).

const hookFiringCounts = new WeakMap<Function, number>();
const kWrapped = Symbol("power-tool.hook.wrapped");
const kOrig = Symbol("power-tool.hook.orig");

type AnyHandler = (...args: any[]) => unknown;

/**
 * Idempotently wrap every registered hook handler on every extension's live
 * handlers array with a counting proxy (IN-PLACE array mutation). Safe to call
 * repeatedly (Symbol guard) — already-wrapped entries are skipped, so repeated
 * createContext walks never double-wrap or double-count. PURE w.r.t. counts: a
 * handler is wrapped at most once.
 */
export function wrapHookHandlers(extensions: unknown): void {
  if (!Array.isArray(extensions)) return;
  for (const ext of extensions as any[]) {
    const handlers: Map<string, AnyHandler[]> | undefined = ext?.handlers;
    if (!handlers || typeof handlers.values !== "function") continue;
    for (const arr of handlers.values()) {
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const orig = arr[i];
        if (typeof orig !== "function") continue;
        if ((orig as { [kWrapped]?: unknown })[kWrapped]) continue; // already wrapped
        const wrapped: AnyHandler & { [kWrapped]: true; [kOrig]: AnyHandler } =
          (...args) => {
            hookFiringCounts.set(orig, (hookFiringCounts.get(orig) ?? 0) + 1);
            return orig(...args);
          };
        wrapped[kWrapped] = true;
        wrapped[kOrig] = orig;
        arr[i] = wrapped; // IN-PLACE — emit() reads this live array at fire time
      }
    }
  }
}

/**
 * Read the firing count for a handler. Accepts either the original fn or its
 * counting wrapper (unwraps via the Symbols), so callers reading the live
 * extension.handlers array (post-wrap) get the right count. Default 0.
 */
export function getHookFiringCount(handler: Function): number {
  const marked = handler as { [kWrapped]?: unknown; [kOrig]?: Function };
  const orig = marked[kWrapped] ? (marked[kOrig] ?? handler) : handler;
  return hookFiringCounts.get(orig) ?? 0;
}

// ─── Snapshot types (also the analyzeHooks input) ───────────────────────────

export interface HookRegistration {
  event: string;
  /** handler-array length for this event */
  count: number;
  /** how many times the registered handlers actually fired since first emit */
  fired: number;
}
export interface ExtensionHooks {
  path: string;
  hooks: HookRegistration[];
}
export interface HooksSnapshot {
  extensions: ExtensionHooks[];
  /** false when the polyfill couldn't reach runner.extensions */
  available: boolean;
}

/**
 * PURE: map the raw runner.extensions[] (each `{ path, handlers: Map<event,Fn[]> }`)
 * into a typed HooksSnapshot. Tolerates shape drift → available:false.
 */
export function collectHooks(rawExtensions: unknown): HooksSnapshot {
  if (!Array.isArray(rawExtensions)) return { extensions: [], available: false };
  const extensions: ExtensionHooks[] = rawExtensions.map((ext: any) => {
    const handlers: Map<string, unknown[]> | undefined = ext?.handlers;
    const path: string = ext?.path ?? ext?.resolvedPath ?? "(unknown)";
    const hooks: HookRegistration[] =
      handlers && typeof handlers.entries === "function"
        ? [...(handlers as Map<string, unknown[]>).entries()].map(([event, hs]) => ({
            event: String(event),
            count: Array.isArray(hs) ? hs.length : 0,
            fired:
              Array.isArray(hs)
                ? hs.reduce<number>(
                    (s, h) => s + (typeof h === "function" ? getHookFiringCount(h) : 0),
                    0,
                  )
                : 0,
          }))
        : [];
    return { path, hooks };
  });
  return { extensions, available: true };
}
