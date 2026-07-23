import { describe, expect, test } from "bun:test";
import { parseDeployOutput } from "./deploy-tool.ts";

const SUCCESS_OUTPUT = `
▶ bundle → /tmp/out/pi-agent.js
  ✓ /tmp/out/pi-agent.js  (10.4 MB)
▶ build thin extension bundles → /tmp/out/ext-bundles
  ▶ pi-agent-ext-research-tool  bun-apps/pi-agent-ext-research-tool/extensions/research-tool.ts
    ✓ /tmp/out/ext-bundles/pi-agent-ext-research-tool.thin.js  (252 KB)
  (6 built, 0 skipped via hash cache)
✓ 7/7 extension(s) built → /tmp/out/ext-bundles
✓ deployed → /tmp/out (read-only)
`;

const FAILURE_OUTPUT = `
  ▶ pi-agent-ext-research-tool  bun-apps/pi-agent-ext-research-tool/extensions/research-tool.ts
    ✗ pi-agent-ext-research-tool: Bundle failed
  (6 built, 0 skipped via hash cache, 1 failed)
`;

describe("parseDeployOutput", () => {
	test("parses pi-agent.js size in MB → bytes", () => {
		expect(parseDeployOutput(SUCCESS_OUTPUT).piAgentJsBytes).toBe(10.4e6);
	});
	test("parses built count from the build-extensions summary", () => {
		expect(parseDeployOutput(SUCCESS_OUTPUT).built).toBe(6);
	});
	test("no failures → empty failed list", () => {
		expect(parseDeployOutput(SUCCESS_OUTPUT).failed).toEqual([]);
	});
	test("captures failing extension names from ✗ lines", () => {
		expect(parseDeployOutput(FAILURE_OUTPUT).failed).toEqual(["pi-agent-ext-research-tool"]);
	});
	test("parses KB size when present", () => {
		expect(parseDeployOutput("  ✓ x.thin.js  (252 KB)")).toMatchObject({ piAgentJsBytes: undefined });
	});
});
