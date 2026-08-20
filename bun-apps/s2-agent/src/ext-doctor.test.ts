import { describe, expect, test } from "bun:test";
import { resolvePiAgentDir } from "./ext-doctor.ts";

describe("resolvePiAgentDir", () => {
	test("decodes percent-encoded characters (e.g. spaces) in the module URL", () => {
		const dir = resolvePiAgentDir("file:///Users/John%20Doe/proj/bun-apps/s2-agent/src/ext-doctor.ts");
		expect(dir).toBe("/Users/John Doe/proj/bun-apps/s2-agent");
		expect(dir).not.toContain("%20");
	});

	test("plain paths (no special characters) resolve unchanged", () => {
		const dir = resolvePiAgentDir("file:///Users/ziyu/proj/bun-apps/s2-agent/src/ext-doctor.ts");
		expect(dir).toBe("/Users/ziyu/proj/bun-apps/s2-agent");
	});
});
