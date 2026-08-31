/**
 * parity-diff — pure diff semantics: the four FAIL classes + clean pass.
 * No spawns, no filesystem: fixtures only.
 */
import { describe, expect, test } from "bun:test";
import { diffFingerprints } from "../src/parity-diff.js";
import type { ParityFingerprint } from "../src/parity-probe.js";

const EXCLUDED = [
	{ name: "s2-agent-ext-flux2", package: "s2-agent-ext-flux2", reason: "machine-bound swift CLIs" },
	{ name: "research-tool", package: "s2-agent-ext-research-tool", reason: "machine-bound swift CLIs" },
];

const base = (over: Partial<ParityFingerprint> = {}): ParityFingerprint => ({
	mode: "dev",
	sessionStartFired: true,
	toolCount: 2,
	tools: [
		{ n: "read", s: "builtin", p: "<builtin:read>", dh: 1, sh: 2 },
		{ n: "flux2", s: "extension", p: "/w/bun-apps/s2-agent-ext-flux2/extensions/flux2.ts", dh: 3, sh: 4 },
	],
	skillCount: 1,
	skills: [{ n: "collect-youtube-llm", p: "/w/bun-apps/s2-agent-ext-research-tool/skills/collect-youtube-llm/SKILL.md", ch: 5 }],
	...over,
});

const deploy = (): ParityFingerprint => ({
	mode: "deploy",
	sessionStartFired: true,
	toolCount: 1,
	tools: [{ n: "read", s: "builtin", p: "<builtin:read>", dh: 1, sh: 2 }],
	skillCount: 0,
	skills: [],
});

describe("diffFingerprints", () => {
	test("clean pass: deploy ⊂ dev, excluded items attributed", () => {
		const r = diffFingerprints(base(), deploy(), EXCLUDED);
		expect(r.verdict).toBe("pass");
		expect(r.findings).toEqual([]);
	});

	test("FAIL: deploy-only tool", () => {
		const d = deploy();
		d.tools = [...d.tools, { n: "mystery", s: "extension", p: "/dist/ext/mystery/ext.cjs", dh: 9, sh: 9 }];
		const r = diffFingerprints(base(), d, EXCLUDED);
		expect(r.verdict).toBe("fail");
		expect(r.findings.some((f) => f.kind === "deploy-only-tool" && f.item === "mystery")).toBe(true);
	});

	test("FAIL: description hash drift on a shared tool", () => {
		const d = deploy();
		d.tools = [{ ...d.tools[0]!, dh: 999 }];
		const r = diffFingerprints(base(), d, EXCLUDED);
		expect(r.findings.some((f) => f.kind === "hash-drift-tool" && f.item === "read")).toBe(true);
		expect(r.verdict).toBe("fail");
	});

	test("FAIL: schema hash drift on a shared tool", () => {
		const d = deploy();
		d.tools = [{ ...d.tools[0]!, sh: 999 }];
		const r = diffFingerprints(base(), d, EXCLUDED);
		expect(r.findings.some((f) => f.kind === "hash-drift-tool" && f.item === "read")).toBe(true);
	});

	test("FAIL: dev-only tool NOT attributable to an excluded ext (incl. builtins)", () => {
		const v = base({
			tools: [...base().tools, { n: "stray", s: "builtin", p: "<builtin:stray>", dh: 7, sh: 8 }],
		});
		const r = diffFingerprints(v, deploy(), EXCLUDED);
		expect(r.findings.some((f) => f.kind === "unattributed-dev-tool" && f.item === "stray")).toBe(true);
		expect(r.verdict).toBe("fail");
	});

	test("FAIL: skill content drift / deploy-only skill / unattributed dev skill", () => {
		const d = deploy();
		d.skills = [{ n: "collect-youtube-llm", p: "/dist/ext/research-tool/skills/collect-youtube-llm/SKILL.md", ch: 555 }];
		const drift = diffFingerprints(base(), d, EXCLUDED);
		expect(drift.findings.some((f) => f.kind === "hash-drift-skill" && f.item === "collect-youtube-llm")).toBe(true);

		const d2 = deploy();
		d2.skills = [{ n: "ghost", p: "/dist/ext/ghost/skills/ghost/SKILL.md", ch: 1 }];
		const ghost = diffFingerprints(base(), d2, EXCLUDED);
		expect(ghost.findings.some((f) => f.kind === "deploy-only-skill" && f.item === "ghost")).toBe(true);

		const v = base({
			skills: [...base().skills, { n: "stray-skill", p: "/w/bun-apps/s2-agent-ext-devops/skills/stray-skill/SKILL.md", ch: 2 }],
		});
		const stray = diffFingerprints(v, deploy(), EXCLUDED);
		expect(stray.findings.some((f) => f.kind === "unattributed-dev-skill" && f.item === "stray-skill")).toBe(true);
	});

	test("attribution matches BOTH registry name and package dir forms", () => {
		// "research-tool" excluded entry (name form) + tool whose path uses the package dir form
		const v = base({
			tools: [...base().tools, { n: "collect_videos", s: "extension", p: "/w/bun-apps/s2-agent-ext-research-tool/extensions/research-tool.ts", dh: 7, sh: 8 }],
		});
		const r = diffFingerprints(v, deploy(), EXCLUDED);
		expect(r.verdict).toBe("pass");
	});

	test("PROBE_ERROR tool on either side fails loudly", () => {
		const d = deploy();
		d.tools = [{ n: "__PROBE_ERROR__", s: "error", p: "boom", dh: 0, sh: 0 }];
		const r = diffFingerprints(base(), d, EXCLUDED);
		expect(r.verdict).toBe("fail");
		expect(r.findings.some((f) => f.item === "__PROBE_ERROR__")).toBe(true);
	});
});
