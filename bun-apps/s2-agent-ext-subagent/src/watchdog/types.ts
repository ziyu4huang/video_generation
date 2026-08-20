/**
 * The watchdog record/result shapes moved to @repo/s2-agent-core-runtime
 * (subagent-record-types.ts, with the run-persistence layer) — re-exported
 * here so this package's public surface is unchanged.
 */
export type {
  WatchdogFinding,
  WatchdogL1Result,
  WatchdogL2Result,
  WatchdogResult,
  WatchdogSeverity,
  WatchdogSource,
} from "@repo/s2-agent-core-runtime";

export interface WatchdogOptions {
  l1: boolean;
  l2: boolean;
}

/** Normalize the tool param into WatchdogOptions. `true` = L1 on, L2 off. */
export function normalizeWatchdogParam(raw: unknown): WatchdogOptions | undefined {
  if (raw === undefined || raw === false || raw === null) return undefined;
  if (raw === true) return { l1: true, l2: false };
  if (typeof raw === "object") {
    const o = raw as { l1?: boolean; l2?: boolean };
    return { l1: o.l1 !== false, l2: o.l2 === true };
  }
  return undefined;
}
