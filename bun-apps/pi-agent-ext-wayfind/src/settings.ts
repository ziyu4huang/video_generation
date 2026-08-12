/**
 * settings.ts — read/write the boolean `wayfindStatusBar` key in
 * ~/.pi/agent/settings.json (opt-in persistent effort status bar).
 *
 * Mirrors the response-language/settings.ts pattern: a pure decision function
 * (withWayfindStatusBar) is separated from the IO wrappers
 * (readWayfindStatusBar / writeWayfindStatusBar) so the merge logic is
 * unit-testable without touching the filesystem.
 *
 * Default is OFF. The key is only ever written by `/wayfind statusbar on|off`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Pure: return a shallow-cloned settings object with `wayfindStatusBar` set to
 * `enabled`. Shallow-merges, preserving every other key. Never mutates input.
 * Passing `enabled` always sets a boolean — there is no "unset" variant (the
 * toggle is binary; deleting the key is equivalent to `false`).
 */
export function withWayfindStatusBar(
  current: Record<string, unknown> | undefined,
  enabled: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = current ? { ...current } : {};
  base.wayfindStatusBar = enabled;
  return base;
}

/**
 * Best-effort read of `wayfindStatusBar` from ~/.pi/agent/settings.json.
 * Returns `false` on missing file, parse error, absent key, or any non-boolean
 * value. Never throws — the status bar is a cosmetic feature and must never
 * break startup.
 */
export function readWayfindStatusBar(): boolean {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (!existsSync(settingsPath)) return false;
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const v = parsed?.wayfindStatusBar;
    return v === true;
  } catch {
    return false;
  }
}

/**
 * IO: merge `enabled` into ~/.pi/agent/settings.json under `wayfindStatusBar`
 * (creating the file/dir if needed). Read-modify-write via withWayfindStatusBar
 * so sibling keys are preserved. Never throws on the read side; a write failure
 * propagates (the user asked to flip the toggle — a silent no-op would mislead).
 */
export function writeWayfindStatusBar(enabled: boolean): void {
  let current: Record<string, unknown>;
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    current = existsSync(settingsPath)
      ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
      : {};
  } catch {
    current = {};
  }
  const next = withWayfindStatusBar(current, enabled);
  const dir = getAgentDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(next, null, 2)}\n`);
}
