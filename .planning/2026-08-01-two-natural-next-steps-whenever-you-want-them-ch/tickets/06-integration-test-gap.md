type: task
blocked by: 02 (Session-type reach gaps)

## Question

Close the integration-test gap: there is currently **NO test that the forced
block actually reaches a REAL session's system prompt.** The existing suite
(`force-response-language.test.ts`, 24 green) is pure/unit on stubs — the patch
header explicitly defers the import-time prototype side effect.

**Blocked by 02** because the test SCOPE depends on the reach matrix: test the
session types 02 confirms are reached-by-construction (start with the **main
session baseline**), then add per-type coverage for any gap 02 exposes.

**Deliverable:** an integration test (L2-style, `PI_RUN_L2=1`-gated, mirroring
the power-tool L2 suite conventions) that boots a real `AgentSession` and
asserts the forced block is present in `context.systemPrompt` on a turn. The
test must be:
- **green with the patch on** (block present), and
- **red with the patch disabled** (`BUN_PI_FORCE_RESPONSE_LANGUAGE=0`) — proving
  it actually exercises the mechanism, not a tautology.

Resolved when the test exists, passes in both directions, and is checked in
under the appropriate `__tests__/` L2 path. If the test reveals the block does
NOT reach the main session, that is a P0 escalation — surface it to the map's
Not-yet-specified escalation signal rather than silently "fixing" it.
