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
}

export interface CaptureAssemblyDeps {
  /** Resolves the current session id; undefined/empty ⇒ no capture. */
  getSessionId: () => string | undefined;
  /** Builds the assembly receipt; null ⇒ nothing to prove (skip record). */
  build: () => AssemblyReceipt | null;
  /** Records the receipt; failures are swallowed by captureAssembly. */
  record: (sessionId: string, mdIds: string[], hash: string) => Promise<void>;
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
    return true;
  } catch {
    /* best-effort provenance; never block startup */
    return false;
  }
}
