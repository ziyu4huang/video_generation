/**
 * The PRODUCTION fork-transcript getter (cc-parity-2 ticket 02), extracted
 * from extensions/subagent.ts so the real chain — sessionManager captured at
 * session_start → getEntries()/getLeafId() → buildForkTranscript — is
 * testable against a REAL SessionManager instead of only through the
 * `getParentTranscript: () => block` fake every dispatch test injects
 * (issue #2081: the fake-injection blind spot — an SDK re-shape of the
 * sessionManager surface or SessionEntry left all tests green while forks
 * silently inherited nothing).
 */

import { buildForkTranscript, forkTranscriptCap } from "@repo/s2-agent-core-runtime";

/**
 * The structural slice of pi's SessionManager the getter reads. Structural
 * (not the SDK type) so this module stays import-light and the real-seam
 * tripwire fails on SHAPE drift (a renamed method no longer satisfies the
 * interface) rather than on a type-only mismatch compiled away.
 */
export interface ForkTranscriptSource {
  getEntries(): ReadonlyArray<Parameters<typeof buildForkTranscript>[0][number]>;
  getLeafId(): string | null;
}

/**
 * Build the production getter over a lazily-populated holder. `undefined` =
 * no sessionManager captured (fork then fails pre-flight in the tool — never
 * a silent empty inheritance). A projection throw propagates to the dispatch
 * and fails it with the real error.
 */
export function createParentTranscriptGetter(
  holder: { current: ForkTranscriptSource | undefined },
  cap: () => number = forkTranscriptCap,
): () => string | undefined {
  return () => {
    const sm = holder.current;
    if (!sm) return undefined;
    return buildForkTranscript(sm.getEntries() as Parameters<typeof buildForkTranscript>[0], sm.getLeafId(), cap());
  };
}
