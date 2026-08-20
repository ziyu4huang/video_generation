/**
 * registry-base-set.test.ts — unit tests for the shared base-set scanner
 * (tests/lib/registry-base-set.ts).
 *
 * The scanner is the DERIVED scope of two gated contract suites
 * (extension-isolation-contract, dep-guard): every extension the registry
 * ships. Its authority is run-dir/registry.ts — an entry ships iff its entry
 * carries a `deploy:` block that is not `enabled: false`. The two historical
 * line-scanner copies each missed a form the authority handles:
 *   - flow-style `deploy: {order: 10}` (no newline after the colon) was
 *     silently NOT shipped;
 *   - `enabled: false` inside a deploy block was silently shipped.
 * Both divergences are pinned here so the contract suites can share ONE
 * scanner instead of two drifting ones.
 *
 * Run: bun test tests/registry-base-set.test.ts
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseRegistryBaseSetNames } from "./lib/registry-base-set.ts";

const FIXTURE = `deploy:
  outRoot: ~/proj/dist/pi-agent-sh
extensions:
  - name: blocky
    package: pi-agent-ext-blocky
    entry: extensions/blocky.ts
    load: static
    deploy:
      order: 10
  - name: flowy
    package: pi-agent-ext-flowy
    entry: extensions/flowy.ts
    load: dynamic
    deploy: {order: 20}
  - name: blockyDisabled
    package: pi-agent-ext-blocky-disabled
    entry: extensions/blocky-disabled.ts
    load: dynamic
    deploy:
      order: 30
      enabled: false
  - name: flowyDisabled
    package: pi-agent-ext-flowy-disabled
    entry: extensions/flowy-disabled.ts
    load: dynamic
    deploy: {order: 40, enabled: false}
  - name: localOnly
    package: pi-agent-ext-local-only
    entry: extensions/local-only.ts
    load: dynamic
    excludeReason: machine-bound
lazyExtensions: {}
`;

describe("parseRegistryBaseSetNames", () => {
	it("ships block-style deploy blocks", () => {
		const names = parseRegistryBaseSetNames(FIXTURE);
		assert.ok(names.includes("blocky"));
	});

	it("ships flow-style deploy blocks (deploy: {order: N}) — the divergence dep-guard/isolation each missed", () => {
		const names = parseRegistryBaseSetNames(FIXTURE);
		assert.ok(names.includes("flowy"), `flowy missing from: ${names.join(", ")}`);
	});

	it("does NOT ship a block-style deploy disabled via `enabled: false`", () => {
		const names = parseRegistryBaseSetNames(FIXTURE);
		assert.ok(!names.includes("blockyDisabled"), `blockyDisabled wrongly shipped: ${names.join(", ")}`);
	});

	it("does NOT ship a flow-style deploy disabled via `enabled: false`", () => {
		const names = parseRegistryBaseSetNames(FIXTURE);
		assert.ok(!names.includes("flowyDisabled"), `flowyDisabled wrongly shipped: ${names.join(", ")}`);
	});

	it("does not ship entries without a deploy block (excludeReason entries)", () => {
		const names = parseRegistryBaseSetNames(FIXTURE);
		assert.ok(!names.includes("localOnly"));
	});

	it("stops at the first column-0 key after extensions:", () => {
		const names = parseRegistryBaseSetNames(FIXTURE);
		assert.deepEqual(names, ["blocky", "flowy"]);
	});

	it("a block whose enabled is explicitly true still ships", () => {
		const yaml = `extensions:
  - name: optin
    deploy:
      order: 1
      enabled: true
`;
		assert.deepEqual(parseRegistryBaseSetNames(yaml), ["optin"]);
	});
});
