# webui-audit-dogfood — the audit reports into the surface it verifies

status: done

## Why

"Friendly and simple to use the pipeline": the webui audit's findings lived
only in the agent conversation + ~/.pi/power-browser/runs. One call should
leave the results visible IN the browser the user is looking at — and the
#1590 persistence mirror then accumulates audit history across restarts.

## What (PR #<PR>)

- webui-tool.ts: publishAuditReport(port, markdown) — POST /api/report
  {title: "webui audit — localhost:<port>", source: "webui-audit"}; returns
  ok/rejected/unreachable, NEVER throws. execute() publishes after writing
  report.md (default on; publish:false opts out) and annotates the tool
  result with the publish outcome.

## Verification

power-tool suite green (+2 unit tests: ok path against a node:http stub,
unreachable path); live dogfood proof on the e2e ws-stub: audit #1 publishes,
audit #2's outline lists the "webui audit — localhost:8892" article.
