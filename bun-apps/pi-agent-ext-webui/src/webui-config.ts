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
 * enabled/disabled decision + the /files root allowlist parsing (ticket 06,
 * archify-webui-html) so the wiring can early-return an inert WebuiWiring
 * without creating a server, registering handlers, or touching pi.
 */
import * as path from "node:path";

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

/**
 * Resolve the /files serving roots (spec §4.1, archify-webui-html ticket 06):
 * `explicit` (`deps.fileRoots` — tests / embedding hosts) wins; otherwise env
 * `WEBUI_FILE_ROOTS` (OS PATH-style `:`-separated — trailing `:` and empty
 * segments are dropped); default `[]` = **fail closed** (the /files route
 * serves nothing but uniform 404s and the `webui:open` handler ignores every
 * path). Roots may be relative — they are resolved to absolute vs cwd here so
 * BOTH consumers (route + event handler) anchor identically. Resolved roots
 * are DEDUPED (first occurrence keeps its position — first-match-wins: the
 * containment loop in file-routes assigns rootIdx by the FIRST root that
 * contains the file, so a duplicated root must never occupy two indexes).
 * An explicitly EMPTY array is honored (fail closed on purpose), while
 * `undefined` falls through to the env. Pure: injectable env keeps tests
 * deterministic.
 */
export function resolveFileRoots(
  env: Record<string, string | undefined> = process.env,
  explicit?: string[]
): string[] {
  const raw = explicit ?? env.WEBUI_FILE_ROOTS ?? "";
  if (raw === "") return [];
  const parts = (Array.isArray(raw) ? raw : raw.split(":"))
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return [...new Set(
    parts.map((p) => (path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)))
  )];
}
