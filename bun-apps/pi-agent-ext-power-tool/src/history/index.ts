/**
 * power-tool history — longitudinal analysis over pi-agent session transcripts.
 *
 * Layering (strictly one-way): scan → replay → aggregate. `scope` and `sidecar`
 * are leaves. Nothing here imports a tool module or the extension entry.
 */
export { type CallRec, type ResultRec, type SessionScan, parseSessionLines } from "./scan.ts";
