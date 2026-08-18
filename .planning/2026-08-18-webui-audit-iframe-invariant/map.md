# webui-audit-iframe-invariant — inv 7: report-iframe-sized

status: done

## Why

The #1576 bug class (html-report iframe at the browser default 304x150 — NO
sizing rule matched it) passed ALL six existing audit invariants: they check
article PRESENCE and placement, never geometry. The verify instrument itself
had the blind spot; a regression of that class would sail through green.

## What (PR #<PR>)

- webui-tool.ts: WebuiAuditState articles gain an optional iframe rect
  (collected in collectDom); invariant 7 "report-iframe-sized" fails any
  report-pane iframe under 320x300 (catches 300x150 on any sane viewport;
  a 390px phone pane still measures ~358 wide; healthy 70vh frames are >=400
  tall). Absent iframe field (markdown articles / older shells) = not
  checked. Tool description updated.
- New src/__tests__/webui-invariants.test.ts — first UNIT tests for
  evaluateInvariants (pure logic ran untested since t01).

## Verification

power-tool suite green; e2e stub audit (real Chrome) shows 7/7 PASS.

## Verification update

Live e2e stub audit: 7/7 PASS — inv 7 reports "1 report iframe(s) sized >= 320x300" via the tab-click measurement overlay (rest-state collectDom measures hidden panes at 0x0; the overlay re-collects with each pane shown and 0x0 counts as unmeasured, never a failure). power-tool 255 pass / 0 fail / 4 skip.
