# 01 — webui_report tool + shared report-frame builder

status: closed

## Done when

- [x] src/report-frame.ts: buildReportFrame (title 1-200, exactly-one body,
      128KB cap, source<=100 per-door default) — shared by route + tool
- [x] src/report-tool.ts: createWebuiReportTool (envelope mirrors webui_present:
      content[] + details; errors are RESULTs, never throws)
- [x] wiring registers webui_report beside webui_present (same broadcaster sink
      as POST /api/report)
- [x] render-routes.ts delegates to the shared builder (statuses preserved)
- [x] tests/report-tool.test.ts (6 tests); README producer line updated
