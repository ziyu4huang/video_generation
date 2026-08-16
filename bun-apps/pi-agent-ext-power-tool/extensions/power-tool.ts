/**
 * pi-agent-ext-power-tool — canonical extension entry.
 *
 * Uniform convention: every bun-apps/pi-agent-ext-<X>/ registers its extension
 * at extensions/<X>.ts. The implementation (extension factory + lib) lives in
 * src/index.ts (also the package.json `main` for programmatic use); this file
 * is the single registered entry point and re-exports the default factory.
 *
 * NOTE: the former `__GATE_PROBES__` export (inspect_context gate-recall
 * probes) was REMOVED in wayfinder ticket 06 — the six inspect_* diagnostics
 * are owner-declared CORE (always-on), so there is no inspect gate to probe.
 */

export { default } from "../src/index.ts";
