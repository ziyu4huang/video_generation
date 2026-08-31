# Dev↔Deploy Surface-Parity Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee the 15 deployable `s2-agent-ext-*` extensions expose an identical session surface (tools + descriptions + schemas + skills + providers) in dev mode (`./s2-agent.sh`) and deploy mode (dist `current/s2-agent.sh`), enforced as a `parity` probe in `verify-deploy-e2e` at every deploy.

**Architecture:** A zero-import probe source (string constant, `TOOLS_ACTIVE_PROBE` precedent) is written to a tmpdir and loaded via `-e` through BOTH launchers; it fingerprints the live session surface (`session_start` → tools with `sourceInfo` + description hash + stable-stringified schema hash; `before_agent_start` → skills + content hash; marker on stderr; `process.exit(0)` before any provider call). A pure `diffFingerprints(dev, deploy, excluded)` compares them — FAIL on deploy-only items, hash drift, or dev-only items not attributable to registry-excluded extensions. `runDeployE2e` gains a `devLauncher` option and a `parity` probe; `deploy-cli` passes the dev launcher so every deploy runs the gate automatically.

**Tech Stack:** Bun + `bun:test`, TypeScript, existing devops seams (`SpawnFn`, `DeployE2eOptions`, `excludedExtensionsFromRegistry`).

**Spec:** `.planning/specs/2026-08-31-dev-deploy-parity-gate-design.md`. One plan-level refinement of spec §1: the probe asset is an exported string constant (`src/parity-probe.ts`), not a standalone asset file — this follows the `TOOLS_ACTIVE_PROBE` precedent (`src/tools-active-probe.ts`), keeps the zero-import property, and lets the recipe, CLI, and future surfaces share one source. Spec intent unchanged.

## Global Constraints

- The probe source string must import NOTHING (deployed `-e` host-module-map constraint — `typebox/compile` incident). Guarded by a unit test that greps the constant for import statements.
- Marker missing after spawn = **FAIL, never skip** (a silently-skipped probe is exactly the incident class this gate exists to catch).
- `diffFingerprints` is pure: takes registry-derived `excluded` as a parameter (no module mocking in tests).
- Canonical JSON before hashing: recursively sort object keys (`stableStringify`) — schema key order may differ between dev TS and bundled CJS construction.
- Never compare `sourceInfo.path` / skill `filePath` ACROSS sides (dev and deploy trees have different absolute roots by design); item identity is the NAME; paths are for within-side attribution only.
- Repo shell rules: no top-level `cd`; subshells `( cd bun-apps/s2-agent-ext-devops && … )`.
- Package gates for `s2-agent-ext-devops`: `bun run check` (tsc) + `bun test`.
- Commit style: English conventional commits, one commit per task.

---

### Task 1: Probe source constant + fingerprint parser

**Files:**
- Create: `bun-apps/s2-agent-ext-devops/src/parity-probe.ts`
- Test: `bun-apps/s2-agent-ext-devops/tests/parity-probe.test.ts`

**Interfaces:**
- Produces: `PARITY_PROBE_SOURCE: string` (the zero-import probe source), `parseParityFpLine(stderr: string): { ok: true; fp: ParityFingerprint } | { ok: false; error: string }`, `type ParityFingerprint` — consumed by Tasks 2–4.

- [ ] **Step 1: Write the failing tests**

```ts
// bun-apps/s2-agent-ext-devops/tests/parity-probe.test.ts
/**
 * parity-probe — unit tests for the fingerprint probe source + parser.
 * Spawn-free: the probe source is exercised as a string (zero-import lint,
 * marker emission shape) and the parser against synthetic stderr payloads.
 */
import { describe, expect, test } from "bun:test";
import { PARITY_PROBE_SOURCE, parseParityFpLine, type ParityFingerprint } from "../src/parity-probe.js";

const GOOD_FP: ParityFingerprint = {
	mode: "dev-head",
	sessionStartFired: true,
	toolCount: 1,
	tools: [{ n: "read", s: "builtin", p: "<builtin:read>", dh: 123, sh: 456 }],
	skillCount: 1,
	skills: [{ n: "devops-workflow", p: "/x/s2-agent-ext-devops/skills/devops-workflow/SKILL.md", ch: 789 }],
};

describe("PARITY_PROBE_SOURCE (zero-import contract)", () => {
	test("contains no import statements", () => {
		expect(/^\s*import\s/m.test(PARITY_PROBE_SOURCE)).toBe(false);
		expect(/^\s*export\s+.*from\s/m.test(PARITY_PROBE_SOURCE)).toBe(false);
	});
	test("emits the marker pair and exits 0 before any provider call", () => {
		expect(PARITY_PROBE_SOURCE).toContain("[PARITY-FP-START]");
		expect(PARITY_PROBE_SOURCE).toContain("[PARITY-FP-END]");
		expect(PARITY_PROBE_SOURCE).toContain("process.exit(0)");
	});
	test("hashes schemas through a key-sorting stable stringify", () => {
		// stableStringify must be defined inside the probe source (zero-import):
		// assert the canonicalization call site, not the runtime value.
		expect(PARITY_PROBE_SOURCE).toContain("stable(");
		expect(PARITY_PROBE_SOURCE).toMatch(/Object\.keys\(v\)\.sort\(\)/);
	});
});

describe("parseParityFpLine", () => {
	test("extracts the fingerprint from noisy stderr", () => {
		const noisy = `[hermes-memory] slow startup\n[PARITY-FP-START]${JSON.stringify({ ...GOOD_FP, marker: "PARITY_FP_v1" })}[PARITY-FP-END]\nother noise`;
		const r = parseParityFpLine(noisy);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.fp.tools[0]?.n).toBe("read");
			expect(r.fp.skillCount).toBe(1);
		}
	});
	test("no marker → ok:false", () => {
		const r = parseParityFpLine("just noise, maybe a provider auth error line");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("PARITY-FP-START");
	});
	test("wrong marker version → ok:false", () => {
		const r = parseParityFpLine(`[PARITY-FP-START]${JSON.stringify({ ...GOOD_FP, marker: "PARITY_FP_v0" })}[PARITY-FP-END]`);
		expect(r.ok).toBe(false);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/s2-agent-ext-devops && bun test tests/parity-probe.test.ts )`
Expected: FAIL — `Cannot resolve module "../src/parity-probe.js"`.

- [ ] **Step 3: Write the implementation**

```ts
// bun-apps/s2-agent-ext-devops/src/parity-probe.ts
/**
 * parity-probe — the dev↔deploy surface fingerprint probe.
 *
 * WHY THIS EXISTS
 * ----------------
 * verify-deploy-e2e probes the dist IN ISOLATION (core builtins present,
 * deploy.json set reports loaded). Nothing diffs the dist against the dev
 * tree. Three incident classes motivated this (spec 2026-08-31): the silent
 * `-e` skip (host-module-map miss), #1946 (toolless deploys past every
 * isolated gate), and bundled-vs-discovered skill precedence. Survey
 * 2026-08-31 measured same-commit parity holding (tools 64⊂88, 0 hash
 * diffs, providers identical) — this probe makes that a checked invariant.
 *
 * The probe source itself must import NOTHING: it is written to a tmpdir and
 * loaded by the target launcher's own bun (deployed trees resolve `-e`
 * imports against a fixed host-module map — see TOOLS_ACTIVE_PROBE).
 *
 * ORDERING (tools-active-probe precedent): `-e` probes load FIRST, so
 * session_start here fires before other extensions' handlers. That is fine
 * for the REGISTRATION surface (getAllTools reads what loaded, not the
 * active set); skills are read at before_agent_start, after all load-time
 * handlers ran. The exit happens before any provider response is awaited.
 */
export const PARITY_PROBE_SOURCE = `
// parity fingerprint probe v1 — zero-import by contract (tests grep for import).
export default (pi: any) => {
	const mode = process.env.PARITY_MODE ?? "unknown";
	const stable = (v: any): string => {
		if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
		if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
		const ks = Object.keys(v).sort();
		return "{" + ks.map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
	};
	const hash = (s: string): number => Bun.hash(s);
	let tools: any[] = [];
	let sessionStartFired = false;
	pi.on("session_start", () => {
		sessionStartFired = true;
		try {
			tools = pi
				.getAllTools()
				.map((t: any) => ({
					n: String(t.name),
					s: String(t.sourceInfo?.source ?? ""),
					p: String(t.sourceInfo?.path ?? ""),
					dh: hash(String(t.description ?? "")),
					sh: hash(stable(t.parameters ?? null)),
				}))
				.sort((a: any, b: any) => (a.n < b.n ? -1 : 1));
		} catch (e: any) {
			tools = [{ n: "__PROBE_ERROR__", s: "error", p: String(e), dh: 0, sh: 0 }];
		}
	});
	pi.on("before_agent_start", async (event: any) => {
		const skills: any[] = [];
		for (const sk of event?.systemPromptOptions?.skills ?? []) {
			try {
				const p = String(sk.filePath ?? sk.path ?? "");
				skills.push({ n: String(sk.name ?? ""), p, ch: p ? hash(await Bun.file(p).text()) : 0 });
			} catch {
				skills.push({ n: String(sk?.name ?? ""), p: String(sk?.filePath ?? ""), ch: 0 });
			}
		}
		skills.sort((a: any, b: any) => (a.n < b.n ? -1 : 1));
		const fp = {
			marker: "PARITY_FP_v1",
			mode,
			sessionStartFired,
			toolCount: tools.length,
			tools,
			skillCount: skills.length,
			skills,
		};
		process.stderr.write("\\n[PARITY-FP-START]" + JSON.stringify(fp) + "[PARITY-FP-END]\\n");
		process.exit(0);
	});
};
`;

export interface ParityFpTool {
	n: string;
	s: string;
	p: string;
	dh: number;
	sh: number;
}
export interface ParityFpSkill {
	n: string;
	p: string;
	ch: number;
}
export interface ParityFingerprint {
	mode: string;
	sessionStartFired: boolean;
	toolCount: number;
	tools: ParityFpTool[];
	skillCount: number;
	skills: ParityFpSkill[];
}

const FP_MARKER = "PARITY_FP_v1";

export type ParseParityFp =
	| { ok: true; fp: ParityFingerprint }
	| { ok: false; error: string };

/** Extract the fingerprint JSON from launcher stderr (tolerates surrounding noise). */
export function parseParityFpLine(stderr: string): ParseParityFp {
	const i = stderr.indexOf("[PARITY-FP-START]");
	if (i < 0) return { ok: false, error: "PARITY-FP-START marker absent from probe stderr" };
	const j = stderr.indexOf("[PARITY-FP-END]", i);
	if (j < 0) return { ok: false, error: "PARITY-FP-END marker absent (truncated probe output?)" };
	let raw: unknown;
	try {
		raw = JSON.parse(stderr.slice(i + "[PARITY-FP-START]".length, j));
	} catch (e) {
		return { ok: false, error: `fingerprint JSON unparseable: ${(e as Error).message}` };
	}
	const o = raw as Partial<ParityFingerprint>;
	if (o.marker !== FP_MARKER) return { ok: false, error: `marker version mismatch: ${String(o.marker)}` };
	if (!Array.isArray(o.tools) || !Array.isArray(o.skills)) {
		return { ok: false, error: "fingerprint missing tools/skills arrays" };
	}
	return {
		ok: true,
		fp: {
			mode: String(o.mode ?? "unknown"),
			sessionStartFired: o.sessionStartFired === true,
			toolCount: Number(o.toolCount ?? o.tools.length),
			tools: o.tools as ParityFpTool[],
			skillCount: Number(o.skillCount ?? o.skills.length),
			skills: o.skills as ParityFpSkill[],
		},
	};
}
```

Note: `marker` is intentionally NOT part of the exported `ParityFingerprint` type (it is a wire detail); the parser validates it and drops it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/s2-agent-ext-devops && bun test tests/parity-probe.test.ts )`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-devops/src/parity-probe.ts bun-apps/s2-agent-ext-devops/tests/parity-probe.test.ts
git commit -m "feat(devops): parity fingerprint probe source + stderr parser"
```

---

### Task 2: Pure diff — `diffFingerprints`

**Files:**
- Create: `bun-apps/s2-agent-ext-devops/src/parity-diff.ts`
- Test: `bun-apps/s2-agent-ext-devops/tests/parity-diff.test.ts`

**Interfaces:**
- Consumes: `ParityFingerprint` from Task 1.
- Produces: `diffFingerprints(dev: ParityFingerprint, deploy: ParityFingerprint, excluded: ParityExcludedExt[]): ParityDiffResult` where `ParityDiffResult = { verdict: "pass" | "fail"; findings: ParityFinding[] }`, `ParityExcludedExt = { name: string; package: string; reason: string }` (superset of `excludedExtensionsFromRegistry`'s rows — extra keys allowed by the caller), `ParityFinding = { kind: ParityFindingKind; item: string; detail: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// bun-apps/s2-agent-ext-devops/tests/parity-diff.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/s2-agent-ext-devops && bun test tests/parity-diff.test.ts )`
Expected: FAIL — module `../src/parity-diff.js` unresolved.

- [ ] **Step 3: Write the implementation**

```ts
// bun-apps/s2-agent-ext-devops/src/parity-diff.ts
/**
 * parity-diff — pure dev↔deploy fingerprint comparison.
 *
 * FAIL classes (spec 2026-08-31 §3):
 *   1. deploy-only item (dist ships something dev lacks);
 *   2. shared item with differing hashes (description/schema/skill content —
 *      includes the dirty-source-tree case: the diff speaks, no special rule);
 *   3. dev-only item NOT attributable to a registry-excluded extension
 *      (builtins are always attributable to nobody → must exist on both sides);
 *   4. __PROBE_ERROR__ sentinel on either side (probe itself failed).
 *
 * Attribution (within-side only — paths are NEVER compared across sides):
 * a dev item passes iff some excluded ext matches `/<name>/` OR `/<package>/`
 * in its source path. Fail-loud is the default: an unattributable path is a
 * conscious registry/attribution fix, not a silent pass.
 */
import type { ParityFingerprint } from "./parity-probe.js";

export interface ParityExcludedExt {
	name: string;
	package: string;
	reason: string;
}

export type ParityFindingKind =
	| "deploy-only-tool"
	| "hash-drift-tool"
	| "unattributed-dev-tool"
	| "deploy-only-skill"
	| "hash-drift-skill"
	| "unattributed-dev-skill"
	| "probe-error";

export interface ParityFinding {
	kind: ParityFindingKind;
	item: string;
	detail: string;
}

export interface ParityDiffResult {
	verdict: "pass" | "fail";
	findings: ParityFinding[];
}

const PROBE_ERROR = "__PROBE_ERROR__";

function attributed(path: string, excluded: ParityExcludedExt[]): boolean {
	return excluded.some((e) => path.includes(`/${e.package}/`) || path.includes(`/${e.name}/`));
}

export function diffFingerprints(
	dev: ParityFingerprint,
	deploy: ParityFingerprint,
	excluded: ParityExcludedExt[],
): ParityDiffResult {
	const findings: ParityFinding[] = [];

	for (const t of [...dev.tools, ...deploy.tools]) {
		if (t.n === PROBE_ERROR) {
			findings.push({ kind: "probe-error", item: t.n, detail: `probe read failed on a side: ${t.p}` });
		}
	}

	const devTools = new Map(dev.tools.map((t) => [t.n, t]));
	const depTools = new Map(deploy.tools.map((t) => [t.n, t]));
	for (const [n, dt] of depTools) {
		const vt = devTools.get(n);
		if (!vt) {
			findings.push({ kind: "deploy-only-tool", item: n, detail: `deploy registers "${n}" (${dt.p}); dev does not` });
		} else if (vt.dh !== dt.dh || vt.sh !== dt.sh) {
			findings.push({
				kind: "hash-drift-tool",
				item: n,
				detail: `description/schema hash differs — dev dh=${vt.dh} sh=${vt.sh} vs deploy dh=${dt.dh} sh=${dt.sh}`,
			});
		}
	}
	for (const [n, vt] of devTools) {
		if (!depTools.has(n) && !(vt.s !== "builtin" && attributed(vt.p, excluded))) {
			findings.push({
				kind: "unattributed-dev-tool",
				item: n,
				detail: `dev-only tool "${n}" (source=${vt.s}, path=${vt.p}) not attributable to an excluded extension`,
			});
		}
	}

	const devSkills = new Map(dev.skills.map((s) => [s.n, s]));
	const depSkills = new Map(deploy.skills.map((s) => [s.n, s]));
	for (const [n, ds] of depSkills) {
		const vs = devSkills.get(n);
		if (!vs) {
			findings.push({ kind: "deploy-only-skill", item: n, detail: `deploy ships skill "${n}" (${ds.p}); dev does not` });
		} else if (vs.ch !== ds.ch) {
			findings.push({ kind: "hash-drift-skill", item: n, detail: `skill content hash differs — dev ch=${vs.ch} vs deploy ch=${ds.ch}` });
		}
	}
	for (const [n, vs] of devSkills) {
		if (!depSkills.has(n) && !attributed(vs.p, excluded)) {
			findings.push({
				kind: "unattributed-dev-skill",
				item: n,
				detail: `dev-only skill "${n}" (${vs.p}) not attributable to an excluded extension`,
			});
		}
	}

	return { verdict: findings.length === 0 ? "pass" : "fail", findings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/s2-agent-ext-devops && bun test tests/parity-diff.test.ts )`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-devops/src/parity-diff.ts bun-apps/s2-agent-ext-devops/tests/parity-diff.test.ts
git commit -m "feat(devops): pure diffFingerprints — dev↔deploy parity semantics"
```

---

### Task 3: `captureParityFingerprint` + `parity` probe in `runDeployE2e` + deploy-cli wiring

**Files:**
- Create: `bun-apps/s2-agent-ext-devops/src/parity-capture.ts`
- Modify: `bun-apps/s2-agent-ext-devops/src/deploy-e2e-recipe.ts` (probe-id union + `DeployE2eOptions` + probe block after cwd-independence)
- Modify: `bun-apps/s2-agent-ext-devops/src/deploy-cli.ts` (both `runDeployE2e` call sites)
- Test: `bun-apps/s2-agent-ext-devops/tests/parity-e2e-probe.test.ts`

**Interfaces:**
- Consumes: `PARITY_PROBE_SOURCE`, `parseParityFpLine`, `ParityFingerprint` (Task 1); `diffFingerprints`, `ParityExcludedExt` (Task 2); `SpawnFn`, `SpawnResult` from `src/spawn.ts`; `excludedExtensionsFromRegistry` from `src/deploy/lib/config.ts`; `runDeployE2e`, `DeployE2eOptions` from `src/deploy-e2e-recipe.ts`.
- Produces: `captureParityFingerprint(launcherPath: string, mode: string, spawn: SpawnFn, capMs: number): Promise<{ ok: true; fp: ParityFingerprint } | { ok: false; error: string }>`; `PARITY_PROBE_CAP_MS = 120_000`; `DeployE2eOptions.devLauncher?: string`; probe id `"parity"`.

- [ ] **Step 1: Write the failing tests**

Follow the fake-SpawnFn pattern of `tests/verify-deploy-e2e.test.ts` (`makeTree` helper, argv-keyed fake spawn; **`-e` argv must be matched BEFORE `--list-models`** — the providers-catalog probe also runs `--list-models`):

```ts
// bun-apps/s2-agent-ext-devops/tests/parity-e2e-probe.test.ts
/**
 * parity probe wiring — capture + runDeployE2e integration, spawn-injected.
 * The real launchers are never executed; fingerprints are marker JSON fed
 * through the fake spawn's stderr, keyed on argv.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeployE2e } from "../src/deploy-e2e-recipe.js";
import { captureParityFingerprint, PARITY_PROBE_CAP_MS } from "../src/parity-capture.js";
import { PARITY_PROBE_SOURCE } from "../src/parity-probe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const root = mkdtempSync(join(tmpdir(), "parity-e2e-"));
const VERSION = "0.1.0+gfeedbeef";
const versionDir = join(root, VERSION);
const devLauncher = join(root, "dev", "s2-agent.sh");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeTree(): void {
	mkdirSync(join(versionDir, "ext"), { recursive: true });
	writeFileSync(join(versionDir, "s2-agent.sh"), "#!/usr/bin/env bash\n");
	writeFileSync(
		join(versionDir, "deploy.json"),
		JSON.stringify({ version: VERSION, sourceSha: "feedbeef", config: { extensions: [{ name: "task", enabled: true }] } }),
	);
	symlinkSync(VERSION, join(root, "current"));
	mkdirSync(join(root, "dev"), { recursive: true });
	writeFileSync(devLauncher, "#!/usr/bin/env bash\n");
}

const fpLine = (o: unknown): string => `\n[PARITY-FP-START]${JSON.stringify(o)}[PARITY-FP-END]\n`;

const DEV_FP = {
	marker: "PARITY_FP_v1", mode: "dev", sessionStartFired: true, toolCount: 2,
	tools: [
		{ n: "read", s: "builtin", p: "<builtin:read>", dh: 1, sh: 2 },
		{ n: "merge_pr_after_local_ci", s: "extension", p: "/w/bun-apps/s2-agent-ext-devops/extensions/devops.ts", dh: 3, sh: 4 },
	],
	skillCount: 1,
	skills: [{ n: "devops-workflow", p: "/w/bun-apps/s2-agent-ext-devops/skills/devops-workflow/SKILL.md", ch: 5 }],
};
const DEPLOY_FP = {
	marker: "PARITY_FP_v1", mode: "deploy", sessionStartFired: true, toolCount: 2,
	tools: [
		{ n: "read", s: "builtin", p: "<builtin:read>", dh: 1, sh: 2 },
		{ n: "merge_pr_after_local_ci", s: "extension", p: "/dist/ext/devops/ext.cjs", dh: 3, sh: 4 },
	],
	skillCount: 1,
	skills: [{ n: "devops-workflow", p: "/dist/ext/devops/skills/devops-workflow/SKILL.md", ch: 5 }],
};

const MODELS = "id\nprovider/glm-5.3\nprovider/qwen3-coder\n";

/** Fake spawn: dev launcher vs deployed launcher, keyed on argv. `-e` FIRST. */
function fakeSpawn(variants: { deployFp?: object | null; devFp?: object | null; devModels?: string } = {}): SpawnFn {
	return async (_cmd: string, args: string[]): Promise<SpawnResult> => {
		const argv = args.join(" ");
		const isDev = _cmd === devLauncher;
		if (argv.includes("-e")) {
			const fp = isDev ? (variants.devFp ?? DEV_FP) : variants.deployFp;
			if (fp === null) return { stdout: "", stderr: "no marker — probe never ran (silent skip class)", exitCode: 0 };
			return { stdout: "", stderr: fpLine(fp), exitCode: 0 };
		}
		if (argv.includes("--list-models")) {
			return { stdout: isDev ? (variants.devModels ?? MODELS) : MODELS, stderr: "", exitCode: 0 };
		}
		if (argv.includes("--ext-list")) {
			return { stdout: JSON.stringify({ loaded: ["task"], loadedCount: 1, skillPaths: [], skipped: [] }), stderr: "", exitCode: 0 };
		}
		return { stdout: "ok", stderr: "", exitCode: 0 }; // --help etc.
	};
}

describe("captureParityFingerprint", () => {
	test("captures a fingerprint through the marker contract", async () => {
		const r = await captureParityFingerprint(devLauncher, "dev", fakeSpawn(), PARITY_PROBE_CAP_MS);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.fp.tools.map((t) => t.n)).toContain("read");
	});
	test("marker missing → ok:false (FAIL, never skip)", async () => {
		const r = await captureParityFingerprint(devLauncher, "dev", fakeSpawn({ devFp: null }), PARITY_PROBE_CAP_MS);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("marker");
	});
});

describe("runDeployE2e parity probe", () => {
	test("pass when surfaces match; providers identical", async () => {
		makeTree();
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn(), devLauncher });
		const p = r.probes.find((x) => x.id === "parity")!;
		expect(p.verdict).toBe("pass");
	});
	test("fail when a shared tool hash drifts", async () => {
		makeTree();
		const drifted = { ...DEPLOY_FP, tools: DEPLOY_FP.tools.map((t) => ({ ...t, sh: t.n === "merge_pr_after_local_ci" ? 999 : t.sh })) };
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn({ deployFp: drifted }), devLauncher });
		const p = r.probes.find((x) => x.id === "parity")!;
		expect(p.verdict).toBe("fail");
		expect(p.note).toContain("hash-drift-tool");
	});
	test("fail when dev-only tool is unattributed (real registry exclusion list applies)", async () => {
		makeTree();
		const stray = { ...DEV_FP, tools: [...DEV_FP.tools, { n: "stray", s: "builtin", p: "<builtin:stray>", dh: 9, sh: 9 }] };
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn({ devFp: stray }), devLauncher });
		const p = r.probes.find((x) => x.id === "parity")!;
		expect(p.verdict).toBe("fail");
		expect(p.note).toContain("unattributed-dev-tool");
	});
	test("fail when providers lists differ", async () => {
		makeTree();
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn({ devModels: "id\nprovider/glm-5.3\n" }), devLauncher });
		const p = r.probes.find((x) => x.id === "parity")!;
		expect(p.verdict).toBe("fail");
		expect(p.note).toContain("providers");
	});
	test("skip (not fail) when devLauncher is absent", async () => {
		makeTree();
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn() });
		const p = r.probes.find((x) => x.id === "parity")!;
		expect(p.verdict).toBe("skip");
		expect(p.note).toContain("dev-launcher");
	});
});
```

Note on the "real registry exclusion list applies" test: `runDeployE2e` derives the excluded set via `excludedExtensionsFromRegistry({ bunAppsDir })` reading the REAL repo registry (`bun-apps/` exists from the package location) — deterministic in-repo, no spawn. The `stray` builtin is unattributable under any registry state.

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/s2-agent-ext-devops && bun test tests/parity-e2e-probe.test.ts )`
Expected: FAIL — `../src/parity-capture.js` unresolved; `parity` probe absent (`p` undefined).

- [ ] **Step 3: Write `src/parity-capture.ts`**

```ts
// bun-apps/s2-agent-ext-devops/src/parity-capture.ts
/**
 * parity-capture — run the fingerprint probe through ONE launcher and parse it.
 * Marker missing / unparseable / timeout → ok:false. The caller turns that
 * into a FAIL verdict (never skip): a silently-absent probe is the incident
 * class this gate exists for (host-module-map `-e` skip).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARITY_PROBE_SOURCE, parseParityFpLine } from "./parity-probe.js";
import type { SpawnFn } from "./spawn.js";

export const PARITY_PROBE_CAP_MS = 120_000;

export type CaptureParityResult =
	| { ok: true; fp: import("./parity-probe.js").ParityFingerprint }
	| { ok: false; error: string };

export async function captureParityFingerprint(
	launcherPath: string,
	mode: string,
	spawn: SpawnFn,
	capMs: number = PARITY_PROBE_CAP_MS,
): Promise<CaptureParityResult> {
	const workDir = mkdtempSync(join(tmpdir(), "parity-probe-"));
	try {
		const probePath = join(workDir, "parity-probe.ts");
		writeFileSync(probePath, PARITY_PROBE_SOURCE);
		const r = await spawn(launcherPath, ["-e", probePath, "-p", "hi", "--no-session"], {
			timeoutMs: capMs,
			env: { PARITY_MODE: mode },
		});
		if (r.timedOut) return { ok: false, error: `parity probe timed out after ${capMs}ms` };
		const p = parseParityFpLine(r.stderr);
		return p.ok ? { ok: true, fp: p.fp } : { ok: false, error: `${p.error} (exit=${r.exitCode})` };
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}
```

Check `SpawnOptions.env` semantics before finalizing: if `env` REPLACES the environment, spread `process.env` (`env: { ...process.env, PARITY_MODE: mode }`) so the launcher keeps PATH etc. Mirror exactly what `tools-probe` does (read its spawn call in `deploy-e2e-recipe.ts` around the `pinSpawnEnv` usage).

- [ ] **Step 4: Wire the probe into `runDeployE2e`**

In `src/deploy-e2e-recipe.ts`:

1. Add to the `DeployE2eProbe.id` union: `| "parity"`.
2. Add to `DeployE2eOptions`:

```ts
	/**
	 * Absolute path to the DEV tree's s2-agent.sh. Present → the parity probe
	 * fingerprints BOTH launchers and diffs (same commit by construction —
	 * deploy runs from the dev tree). Absent → parity probe SKIPS (dist-only
	 * environment, e.g. CI without the workspace).
	 */
	devLauncher?: string;
```

3. Immediately after the cwd-independence block (before tools-probe), insert the parity probe block:

```ts
	// ── parity (dev↔deploy fingerprint diff) ────────────────────────────────
	// The ONLY probe that compares the dist against the dev tree instead of
	// checking it in isolation. FAIL classes: deploy-only items, description/
	// schema/skill-content hash drift (incl. dirty-source-tree drift — the
	// diff speaks, no special rule), dev-only items not attributable to
	// registry-excluded extensions, marker-missing (silent `-e` skip class —
	// FAIL, never skip). Providers parity: sorted --list-models ids diff.
	{
		const t0 = now();
		if (!opts.devLauncher) {
			probes.push({
				id: "parity",
				verdict: "skip",
				ms: 0,
				note: "skipped: no --dev-launcher (dist-only environment — dev-tree baseline unavailable)",
			});
		} else {
			const excluded = excludedExtensionsFromRegistry({ bunAppsDir: resolve(import.meta.dir, "..", "..") });
			const devCap = await captureParityFingerprint(opts.devLauncher, "dev", opts.spawn);
			const depCap = await captureParityFingerprint(launcher.command, "deploy", opts.spawn);
			let verdict: ProbeVerdict = "pass";
			let note = "";
			const lines: string[] = [];
			if (!devCap.ok || !depCap.ok) {
				verdict = "fail";
				lines.push(`fingerprint capture failed — dev: ${devCap.ok ? "ok" : devCap.error} · deploy: ${depCap.ok ? "ok" : depCap.error}`);
			} else {
				const d = diffFingerprints(devCap.fp, depCap.fp, excluded);
				for (const f of d.findings) lines.push(`${f.kind}: ${f.item} — ${f.detail}`);
				// Providers parity: sorted non-empty --list-models rows.
				const devModels = await opts.spawn(opts.devLauncher, ["--list-models"], { timeoutMs: 60_000 });
				const depModels = await opts.spawn(launcher.command, ["--list-models"], { timeoutMs: 60_000 });
				const devIds = devModels.stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort();
				const depIds = depModels.stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort();
				if (devIds.join("\n") !== depIds.join("\n")) {
					verdict = "fail";
					const onlyDev = devIds.filter((x) => !depIds.includes(x));
					const onlyDep = depIds.filter((x) => !devIds.includes(x));
					lines.push(`providers: model id lists differ — dev-only=[${onlyDev.join(",")}] deploy-only=[${onlyDep.join(",")}]`);
				}
				if (verdict === "pass") note = `surfaces identical: ${depCap.fp.toolCount} tools, ${depCap.fp.skillCount} skills, ${depIds.length} models`;
			}
			if (verdict === "fail") {
				note = `parity FAIL (${lines.length} finding(s)):\n` + lines.slice(0, 20).join("\n") + (lines.length > 20 ? `\n… +${lines.length - 20} more` : "");
			}
			probes.push({ id: "parity", verdict, ms: now() - t0, note });
		}
	}
```

Add the imports at the top of `deploy-e2e-recipe.ts`:

```ts
import { captureParityFingerprint } from "./parity-capture.js";
import { diffFingerprints } from "./parity-diff.js";
import { excludedExtensionsFromRegistry } from "./deploy/lib/config.js";
import { resolve } from "node:path";
```

(If `resolve` is already imported, extend the existing import; follow the file's existing import grouping.)

4. In `src/deploy-cli.ts`, at BOTH `runDeployE2e({ ... })` call sites add:

```ts
				devLauncher: resolve(import.meta.dir, "..", "..", "..", "s2-agent.sh"),
```

(`src/ → s2-agent-ext-devops/ → bun-apps/ → repo root`; the repo-root `s2-agent.sh` symlink is guaranteed by `ci-deploy-gate.ts`'s allowlist entry `"s2-agent.sh"`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/s2-agent-ext-devops && bun test tests/parity-e2e-probe.test.ts tests/verify-deploy-e2e.test.ts )`
Expected: PASS — new tests green, existing verify-deploy-e2e suite unchanged (no devLauncher → parity skips; overall verdicts unchanged).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/s2-agent-ext-devops/src/parity-capture.ts bun-apps/s2-agent-ext-devops/src/deploy-e2e-recipe.ts bun-apps/s2-agent-ext-devops/src/deploy-cli.ts bun-apps/s2-agent-ext-devops/tests/parity-e2e-probe.test.ts
git commit -m "feat(devops): parity probe in verify-deploy-e2e — dev↔deploy fingerprint diff, auto-run on every deploy"
```

---

### Task 4: CLI flag `--dev-launcher` + usage + header docs

**Files:**
- Modify: `bun-apps/s2-agent-ext-devops/src/verify-deploy-e2e-cli.ts` (usage text, `parseVerifyDeployE2eArgs`, default resolution, pass-through to `runDeployE2e`)
- Test: extend `bun-apps/s2-agent-ext-devops/tests/verify-deploy-e2e.test.ts` (argv parsing cases)

**Interfaces:**
- Consumes: `DeployE2eOptions.devLauncher` (Task 3).
- Produces: `parseVerifyDeployE2eArgs` accepting `--dev-launcher <path>`; auto-default when the repo-root launcher exists.

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe` for `parseVerifyDeployE2eArgs` in `tests/verify-deploy-e2e.test.ts`)

```ts
	test("--dev-launcher <path> parses to devLauncher", () => {
		const r = parseVerifyDeployE2eArgs(["--dev-launcher", "/w/s2-agent.sh", "--deploy-root", "/d"]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.flags.devLauncher).toBe("/w/s2-agent.sh");
	});
	test("--dev-launcher without a value is a usage error", () => {
		const r = parseVerifyDeployE2eArgs(["--dev-launcher"]);
		expect(r.ok).toBe(false);
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/s2-agent-ext-devops && bun test tests/verify-deploy-e2e.test.ts )`
Expected: FAIL — unknown flag / missing `devLauncher` on the flags shape.

- [ ] **Step 3: Implement**

In `src/verify-deploy-e2e-cli.ts`:

1. Usage text: add the line `"  --dev-launcher <path>  dev tree's s2-agent.sh for the parity probe (default: <repo>/s2-agent.sh when present; absent → parity skips)"` and extend the first usage line.
2. `VerifyDeployE2eFlags` interface: add `devLauncher?: string;`.
3. `parseVerifyDeployE2eArgs`: add the `--dev-launcher` branch mirroring `--deploy-root` (value-required, usage error when missing).
4. In the CLI body where `runDeployE2e` is called: default `flags.devLauncher ?? (existsSync(resolve(import.meta.dir, "..", "..", "..", "s2-agent.sh")) ? resolve(...) : undefined)` and pass it through as `devLauncher`.

- [ ] **Step 4: Run the full package gates**

Run: `( cd bun-apps/s2-agent-ext-devops && bun run check && bun test )`
Expected: tsc clean, full suite PASS (including the pre-existing suites — `ci-gates`, `deploy-run`, `config-parity`, …).

- [ ] **Step 5: Live smoke (optional but recommended, this machine only)**

Run from the repo root:
`bun bun-apps/s2-agent-ext-devops/src/verify-deploy-e2e-cli.ts --dev-launcher "$PWD/s2-agent.sh"`
Expected: JSON on stdout with `probes[]` containing `{ id: "parity", verdict: "pass", note: "surfaces identical: 64 tools, N skills, 84 models" }` — the survey's measured numbers. A FAIL here against the current dist means the gate already caught real drift — investigate before merging, do not relax the gate.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/s2-agent-ext-devops/src/verify-deploy-e2e-cli.ts bun-apps/s2-agent-ext-devops/tests/verify-deploy-e2e.test.ts
git commit -m "feat(devops): verify-deploy-e2e-cli --dev-launcher flag with repo-root default"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** probe + parser (Task 1), pure diff with the four FAIL classes + attribution via registry (Task 2), capture + probe wiring + deploy-cli auto-run + providers parity (Task 3), CLI flag + skip semantics + default (Task 4). Spec §5 receipts = the probe result `note`/`detail` shape (existing `DeployE2eProbe`); spec "Testing" three tiers map to Tasks 1–3 unit, Task 3 integration, Task 4 Step 5 live check. Hooks parity / behavior equivalence remain non-goals per spec.
- **Placeholders:** none — every step carries executable content.
- **Type consistency:** `ParityFingerprint` fields (`n/s/p/dh/sh`, `n/p/ch`) identical across Tasks 1–3; `ParityExcludedExt` in Task 2 is a structural superset of `excludedExtensionsFromRegistry` rows (name/package/reason) so the Task 3 call typechecks; probe id string `"parity"` consistent with the union member.
