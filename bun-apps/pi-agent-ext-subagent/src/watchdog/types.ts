export type WatchdogSeverity = "blocker" | "concern" | "watchdog-error";
export type WatchdogSource = "lsp" | "model";

export interface WatchdogFinding {
  severity: WatchdogSeverity;
  source: WatchdogSource;
  path?: string;
  line?: number;
  message: string;
  suggestedFix?: string;
}

export interface WatchdogL1Result {
  ran: boolean;
  provider?: string;
  findings: WatchdogFinding[];
  note?: string;
}

export interface WatchdogL2Result {
  ran: boolean;
  findings: WatchdogFinding[];
  note?: string;
}

export interface WatchdogResult {
  ran: boolean;
  editGated: boolean;
  l1: WatchdogL1Result;
  l2: WatchdogL2Result;
  summary: string;
  elapsedMs: number;
}

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
