/**
 * registry-base-set.ts — the ONE line-scanner for "which extensions does
 * s2-agent.registry.yaml ship?", shared by extension-isolation-contract.test.ts
 * and dep-guard.test.ts.
 *
 * Authority semantics (run-dir/registry.ts): an entry ships iff it carries a
 * `deploy:` block that is not `enabled: false`. This scanner handles both YAML
 * forms — block-style (`deploy:` on its own line) and flow-style
 * (`deploy: {order: N}`) — and honours an explicit `enabled: false` in either.
 *
 * A hand-rolled line scanner rather than a YAML dependency or an import of
 * s2-agent's parseRegistry: the contract suites that consume this must stay
 * immune to `bun-apps/node_modules/@repo/*` link state (same reasoning as
 * seam-contract.test.ts's relative core-interface import), and the shape
 * needed is one key. The MIN_EXPECTED floors at each call site are what keep a
 * silent parse failure from turning every assertion vacuous.
 */

/** Short names (registry `name:` values) of every SHIPPED extension entry. */
export function parseRegistryBaseSetNames(yamlText: string): string[] {
	const names: string[] = [];
	let inExtensions = false;
	let name: string | null = null;
	let hasDeployBlock = false;
	let deployDisabled = false;
	let deployIndent = -1;
	const flush = (): void => {
		if (name !== null && hasDeployBlock && !deployDisabled) names.push(name);
	};
	for (const raw of yamlText.split("\n")) {
		if (/^extensions:\s*$/.test(raw)) {
			inExtensions = true;
			continue;
		}
		// Any other column-0 key ends the block.
		if (inExtensions && /^\S/.test(raw)) break;
		if (!inExtensions) continue;
		const m = /^\s*-\s*name:\s*(\S+)\s*$/.exec(raw);
		if (m) {
			flush();
			name = m[1] as string;
			hasDeployBlock = false;
			deployDisabled = false;
			deployIndent = -1;
			continue;
		}
		if (name === null) continue;
		// Flow-style `deploy: {order: 10, enabled: false}` — the whole block on
		// one line. (The top-level `deploy:` key is column-0 and never matches.)
		const flow = /^\s+deploy:\s*\{(.*)\}\s*$/.exec(raw);
		if (flow) {
			hasDeployBlock = true;
			deployDisabled = /enabled:\s*false/.test(flow[1] as string);
			deployIndent = -1;
			continue;
		}
		// Block-style `deploy:` opens the block that marks the entry shipped.
		if (/^\s+deploy:\s*$/.test(raw)) {
			hasDeployBlock = true;
			deployDisabled = false;
			deployIndent = raw.length - raw.trimStart().length;
			continue;
		}
		// Lines indented deeper than the block-style `deploy:` key belong to the
		// block; the first shallower (or equal) non-empty line closes it.
		if (deployIndent >= 0) {
			const ind = raw.length - raw.trimStart().length;
			if (raw.trim() === "" || ind > deployIndent) {
				const em = /^\s*enabled:\s*(\S+)\s*$/.exec(raw);
				if (em) deployDisabled = em[1] === "false";
				continue;
			}
			deployIndent = -1;
		}
	}
	flush();
	return names;
}
