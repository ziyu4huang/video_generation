/**
 * pi-agent-ext-power-tool — canonical extension entry.
 *
 * Uniform convention: every bun-apps/pi-agent-ext-<X>/ registers its extension
 * at extensions/<X>.ts. The implementation (extension factory + lib) lives in
 * src/index.ts (also the package.json `main` for programmatic use); this file
 * is the single registered entry point and re-exports the default factory.
 */
/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of the runtime
 * `gating` object). Consumed by pi-agent-ext-tool-gate/qa/collect-probes.ts.
 * Plain object: no `satisfies` / type import, so this extension never depends
 * on tool-gate (avoids a circular dep); shape is enforced by tool-gate's
 * drift-guard test. Dispatch gate → controls-only (recallFloor 0, adversarial
 * []): narrow keywords are intentional, so we assert the predicate fires on
 * its own keywords / requires path, not paraphrased intent.
 */
export const __GATE_PROBES__ = {
	gate: "inspect_context",
	recallFloor: 0,
	adversarial: [],
	controls: ["inspect the agent context", "show token usage", "diagnose extension pathology"],
};

export { default } from "../src/index.ts";
