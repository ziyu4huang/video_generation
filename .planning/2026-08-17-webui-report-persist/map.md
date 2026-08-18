# webui-report-persist — reports survive pi restarts

status: done

## Why

The session store is in-memory: every pi restart wiped the Report tab clean (bitten in practice — four reports vanished on a routine restart and had to be republished by hand). The Report tab is the ARCHIVE surface; it must outlive the process.

## What (PR #1590)

- src/report-persist.ts: per-port JSONL mirror (~/.pi/webui/reports/reports-<port>.jsonl; WEBUI_REPORT_DIR override). BEST-EFFORT contract — write failures never break a broadcast. Restore = store-append only (no broadcast: no bell, no live push; surfaces via the connect-time snapshot). Newest 25 frames reload at boot (REPORT_RESTORE_CAP).
- webui-wiring.ts: port taken from the RESOLVED value (deps.port ?? resolvePort()) — the WebServer port getter throws before start(). Restore loop right after store creation; the persistence hook sits INSIDE the store-wrapped broadcaster (after append) — the ONE point every report frame crosses, so both doors persist with zero producer changes.
- tests/report-persist.test.ts (6 tests); README Report section updated.

## Verification

webui suite 512 pass / 0 fail; ci-local PASS. Live end-to-end (publish -> restart -> reports still present) lands at the user's next pi restart.
