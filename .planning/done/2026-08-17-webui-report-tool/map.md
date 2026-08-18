# webui-report-tool — in-process report producer

status: done

## Why

The user asked: "why POST? why not transfer data without going through HTTP?"
The report frame had NO agent-side producer — POST /api/report (t02) was the
only door, built as a cross-process API. But the webui server is IN-PROCESS
with the agent; the agent curling its own loopback is a pure socket detour.

## What

`webui_report` tool (core, always-on, non-blocking) — validation + frame
construction extracted to shared `src/report-frame.ts`, used by BOTH doors:
- agent-side: `createWebuiReportTool({ onReport })` registered in wiring next
  to webui_present; sink = store-wrapped broadcaster (identical semantics:
  live broadcast + replay append)
- external: POST /api/report unchanged behavior (route body now delegates)

## Tickets

| # | ticket | status | notes |
| - | - | - | - |
| 01 | webui_report tool + shared builder | closed | #1572 |

## Verification

webui suite (504 pass / 0 fail expected), ci-local 17 gates PASS.

## Follow-up (2026-08-17): body cap 128KB -> 16MB

User decision: the text-era 128KB cap rejected HTML artifacts (full archify
renders ~600KB). Raised in the shared builder + route raw pre-check; oversize
tests updated. Truly huge content should ride /files references, not frames.
