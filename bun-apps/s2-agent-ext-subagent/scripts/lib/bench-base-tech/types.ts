/**
 * Shared types for the base-tech benchmark (self-arc-13, spec §4).
 *
 * The driver owns case sequencing, nonces, timeouts, receipts, and scoring;
 * adapters own process lifecycle + lane-native evidence only.
 */

export type TechId = "bun-terminal" | "bun-pty" | "tmux" | "rpc";

export const TECH_IDS: readonly TechId[] = ["bun-terminal", "bun-pty", "tmux", "rpc"];

export interface LaunchCtx {
  sh: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** Lane capability declaration (drives the capability matrix, spec §9). */
export interface EvidenceLanes {
  renderedTruth: boolean;
  structured: boolean;
  dialogs: "keystroke" | "protocol" | "none";
  asyncEvents: "screen" | "stream" | "none";
}

/** What awaitSettled's predicate sees: the lane's native evidence view. */
export interface SettleView {
  /** Reconstructed/captured screen text (rendered-truth lanes); null otherwise. */
  screen: string | null;
  /** Latest structured event/response (rpc); null otherwise. Kept as the raw
   *  parsed object — predicates run typeof checks, never trust shape. */
  structured: unknown;
}

export interface SettleResult {
  settled: boolean;
  ms: number;
  lastView: SettleView;
}

export interface StateInfo {
  model?: string;
  raw: unknown;
}

export interface GestureResult {
  ok: boolean;
  evidence: string;
}

export interface Session {
  /** Paced, verified submit (screen lanes: rendered-truth gates; rpc: command). */
  submit(text: string): Promise<void>;
  /** Lane-native settle poll: adapter cadence + stability gates, driver predicate. */
  awaitSettled(deadlineMs: number, pred: (v: SettleView) => boolean): Promise<SettleResult>;
  screenText?(): string | null;
  stateProbe?(): Promise<StateInfo | null>;
  /** TUI gesture by raw bytes (screen lanes) — e.g. "/subagents\r". */
  writeRaw?(bytes: string): Promise<void>;
  close(): Promise<void>;
}

export interface BenchAdapter {
  id: TechId;
  evidenceLanes: EvidenceLanes;
  launch(ctx: LaunchCtx): Promise<Session>;
}

/** Per-case receipt (spec §7). pass:null + verdict records D8 unreachables. */
export interface CaseReceipt {
  tech: TechId;
  case: string;
  nonce: string;
  pass: boolean | null;
  verdict?: "pass" | "fail" | "unreachable";
  timingsMs: Record<string, number>;
  evidence: Record<string, unknown>;
  env: Record<string, unknown>;
  notes: string[];
}

/** Map D1 arbitration: the lane's pty mechanism is unusable on this platform
 *  (e.g. macOS script(1) hard-fails tcgetattr on non-tty stdin). The driver
 *  records every case N/A with this evidence — never a mid-arc reinterpretation. */
export class LaneUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaneUnavailableError";
  }
}
