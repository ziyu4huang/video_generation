# Ticket 08 — Detector coverage: quota/429, no-progress, KNOWN_EVENTS guard

Status: pending

## Why

Three coverage holes found in review: (1) provider-level errors (429/quota/
rate-limit) never appear as tool calls and `PathologyInput` has no slot for
them (types.ts:27-33), so a quota storm is undetectable — CC retries with
backoff and surfaces repeated API failures to the model; (2) near-identical
args (bumped counter, changed line number) defeat exact `argsSig` equality,
leaving no-progress loops visible only via the blunt long-session proxy;
(3) `KNOWN_EVENTS` is hand-pinned to "pi 0.82.0" while the dependency is
0.84.2 (runner-hooks.ts:14-31) — an SDK-added event flags legitimate
handlers as `unknown-event-name` false positives, and the subset test
(inspect-hooks.test.ts:155-158) cannot catch drift.

## Scope

1. **API-error channel**: extend the accumulator to record provider-error
   events (whatever the SDK exposes — `after_provider_response` error
   shapes / `agent_end` error reasons; investigate the event surface first)
   into a bounded per-session list; new detector `quota-storm` (N provider
   errors in window, severity high when 429-family dominates) + replay
   parity (the transcript scan must see the same events — extend scan.ts;
   if transcripts don't record them, replay reports the check as
   `unmeasurable`, the existing honest degradation).
2. **No-progress detector**: `argsSig` variant normalizing digits and
   whitespace (keep the exact sig as primary; normalized sig only feeds
   THIS check) — same tool + normalized-identical args ≥ threshold across
   a window ⇒ `no-progress-loop` (medium). Must not fire on legitimate
   retries of read-only calls that legitimately return errors → require
   zero state change between calls (no interleaved write tools) before
   firing.
3. **KNOWN_EVENTS drift guard**: derive the event-name set from the SDK's
   `ExtensionEvent` union at the TYPE level (`satisfies` / key remap) so an
   SDK add/remove fails `tsc`, replacing the hand list; keep the runtime
   Set for lookups.
4. Tests: quota-storm accumulation + detection + replay parity (or honest
   unmeasurable), no-progress table (bumped counter fires; interleaved
   writes don't; distinct calls don't), type-level guard compile test.

Not in scope: thresholds on the tool surface (warner configurability);
pathology injection (04); history segmentation (07).

## Done-when

- [ ] A synthetic 429 storm fires the new detector live; replay agrees
      (or reports unmeasurable honestly, test-pinned).
- [ ] No-progress fires on a counter-bumping loop fixture, not on
      interleaved-write sequences.
- [ ] KNOWN_EVENTS derives from the SDK union (tsc fails on a
      deliberately-added fake event — verified by mutation once, manually).
- [ ] Canonical gates green; PR merged CLEAN.
