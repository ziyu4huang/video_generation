/**
 * webui-config.ts — the optionality gate (architecture v2 §3.1).
 *
 * Pure: takes an injectable env (default process.env) so tests are
 * deterministic (no process.env mutation).
 *
 * The webui is ON by default — backward compatible with the v1 always-wired
 * static extension. Opt OUT via env `WEBUI_DISABLED` ("1" | "true",
 * case-insensitive) or via the wiring's `deps.enabled` override (tests / an
 * embedding host that wants to defer the decision). Port resolution stays in
 * port-resolver.ts (WEBUI_PORT > PORT > 0); this module owns ONLY the
 * enabled/disabled decision so the wiring can early-return an inert
 * WebuiWiring without creating a server, registering handlers, or touching pi.
 */
export function isWebuiDisabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env.WEBUI_DISABLED;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Effective enabled state: `explicit` (deps.enabled) wins; otherwise read the
 * env. `explicit` is `boolean | undefined` so `deps.enabled ?? …` semantics
 * live here and the wiring stays a one-liner.
 */
export function resolveWebuiEnabled(
  env: Record<string, string | undefined> = process.env,
  explicit?: boolean
): boolean {
  return explicit ?? !isWebuiDisabled(env);
}
