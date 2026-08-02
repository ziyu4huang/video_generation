/**
 * Per-session prompt-provenance capture (UPSP §5 request_body_sha256 analogue).
 *
 * Extracted as a pure, injectable helper so the once-per-session capture at
 * `session_start` is unit-testable with stubs (mirrors the
 * scheduleSessionBackfill / scheduleLiveSessionIndex pattern). The handler in
 * index.ts binds the real `ctx.sessionManager.getSessionId`,
 * `buildPromptAssembly`, and `sessionRepo.recordAssembly` via the deps below.
 *
 * Best-effort: NEVER throws — a missing sid, a null assembly (policy-only mode
 * or an empty store), or a throwing `record` are all swallowed so agent startup
 * is never blocked (mirrors the backfillStableIds guard). Returns true only
 * when a record actually landed.
 */

export interface AssemblyReceipt {
  mdIds: string[];
  hash: string;
  /**
   * Per-entry content signatures (UPSP §9 / ticket #06) for the surfaced md_ids —
   * the turn-end scanner matches these against assistant output to mark entries
   * `used`. Unioned (deduped by mdId, memory-before-project order) by
   * buildPromptAssembly. captureAssembly IGNORES this field: it records mdIds +
   * hash only (Task 3 adds the sibling markUsed separately). Additive over #05.
   */
  signatures: { mdId: string; signature: string }[];
}

export interface CaptureAssemblyDeps {
  /** Resolves the current session id; undefined/empty ⇒ no capture. */
  getSessionId: () => string | undefined;
  /** Builds the assembly receipt; null ⇒ nothing to prove (skip record). */
  build: () => AssemblyReceipt | null;
  /** Records the receipt; failures are swallowed by captureAssembly. */
  record: (sessionId: string, mdIds: string[], hash: string) => Promise<void>;
  /**
   * Optional consumer of the SAME receipt that was just built + recorded
   * (UPSP §9 / ticket #06, Task 6). Called exactly once, AFTER a successful
   * `record`, only when `build` returned a non-null assembly — so anything the
   * caller derives from the receipt (e.g. populating the surfaced-signature
   * set) is guaranteed to mirror the mdIds just persisted (the §5↔§9 join).
   * Additive + optional: #05 call sites that omit it are unaffected.
   */
  onReceipt?: (receipt: AssemblyReceipt) => void;
}

/**
 * Run the once-per-session prompt-provenance capture. Idempotent at the store
 * layer (recordAssembly re-call replaces). Returns whether a record landed.
 */
export async function captureAssembly(deps: CaptureAssemblyDeps): Promise<boolean> {
  try {
    const sid = deps.getSessionId();
    if (!sid) return false;
    const assembly = deps.build();
    if (!assembly) return false;
    await deps.record(sid, assembly.mdIds, assembly.hash);
    // Surface the same receipt AFTER the record landed, so the §5↔§9 join stays
    // exact (the surfaced mdIds the matcher tracks == the mdIds just persisted).
    // A throwing onReceipt is swallowed by the outer guard (never blocks startup).
    deps.onReceipt?.(assembly);
    return true;
  } catch {
    /* best-effort provenance; never block startup */
    return false;
  }
}
