# Gate-Recall Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standing regression guard that measures every non-core keyword gate's adversarial recall each `bun run qa`, failing on regression.

**Architecture:** Each gated extension exports a QA-only `__GATE_PROBES__` object (adversarial + control prompts + a per-gate `recallFloor`). A new `qa/collect-probes.ts` statically imports them into a `Map`. `qa/gate-recall.ts` groups `CORPUS_GATES` by gating-signature (so one probe set covers a whole co-fire group, including cross-package ones like workflow+subagent), scores each group with the existing pure `gateFires`, and exits non-zero on any FAIL or broken control. It replaces the dead `qa/miss-rate-ab.ts` and becomes the 4th conjunct of `qa/run.ts`.

**Tech Stack:** TypeScript, Bun, `bun:test`. Pure functions — no LLM, no telemetry, no agent run.

## Global Constraints

- Probe sets are QA-DATA, not runtime gating. Never add fields to the runtime `Gating` type (`pi-tool-gating-contract`).
- Extensions export `__GATE_PROBES__` as a PLAIN object (no type import) to avoid a circular dependency on tool-gate. Shape is enforced by a drift-guard test in tool-gate.
- Reuse the REAL `gateFires(gate, promptLower)` from `extensions/tool-gate.ts` — never reimplement keyword matching.
- A control that fails to fire is ALWAYS fatal (the keyword set is broken), independent of `recallFloor`.
- Deliberate-dispatch gates (`workflow`, `inspect_context`, `pi_deploy`, `memory_supersede`, the 7 devops gates) ship `recallFloor: 0` (controls-only); crisp-intent gates (image/video/doc/research/web) ship `recallFloor: 0.9`, recalibrated in Task 8.
- All commands run from `bun-apps/pi-agent-ext-tool-gate` unless noted. Tests: `bun test`. Gate: `bun run qa`.
- TDD: write the failing test first, watch it fail, implement, watch it pass, commit.

## File Structure

- `qa/collect-probes.ts` (NEW) — `GateProbeSet` type + `PROBES_BY_GATE: Map<string, GateProbeSet>` + `ALL_PROBE_SETS` (for the drift guard). Statically imports every `__GATE_PROBES__`.
- `qa/gate-recall.ts` (NEW) — pure `scoreGate` + `evaluateGateRecall` + `main()`. Replaces `miss-rate-ab.ts`.
- `qa/gate-recall.test.ts` (NEW) — synthetic PASS/FAIL/FATAL/UNCOVERED + a weaken-keyword regression test.
- `qa/collect-probes.test.ts` (NEW) — drift guard: every probe `gate` is a `CORPUS_GATES` canonical name; no two probe sets share a signature.
- `qa/run.ts` (MODIFY) — add gate-recall as a pass conjunct + report.
- `package.json` (MODIFY) — add `qa:gate-recall`; repoint `qa:miss-ab` to `gate-recall.ts`.
- `qa/miss-rate-ab.ts` (DELETE).
- Extension entry files (MODIFY) — add `__GATE_PROBES__` exports (Tasks 5–7).

---

### Task 1: Pure `scoreGate` + `GateProbeSet` type

**Files:**
- Create: `bun-apps/pi-agent-ext-tool-gate/qa/collect-probes.ts` (type only, for now)
- Create: `bun-apps/pi-agent-ext-tool-gate/qa/gate-recall.ts` (pure scorer + types)
- Test: `bun-apps/pi-agent-ext-tool-gate/qa/gate-recall.test.ts`

**Interfaces:**
- Produces: `GateProbeSet` (collect-probes.ts), `GateScore`/`scoreGate(gate, probes)` (gate-recall.ts). Later tasks consume these.

- [ ] **Step 1: Write the failing test** — `qa/gate-recall.test.ts`:
```ts
import { test, expect } from "bun:test";
import { scoreGate } from "./gate-recall.ts";
import type { ToolGate } from "../extensions/tool-gate.ts";

const g = (keywords: string[], requires?: { nouns: string[]; verbs: string[] }): ToolGate => ({
  names: ["t"], keywords, description: "", requires,
});

test("PASS: recall ≥ floor and controls fire", () => {
  const gate = g(["flux"], { nouns: ["image"], verbs: ["render"] });
  const r = scoreGate(gate, { gate: "t", recallFloor: 0.5, adversarial: ["render an image", "render an image too"], controls: ["flux"] });
  expect(r.recall).toBe(1); expect(r.controlsPass).toBe(true); expect(r.verdict).toBe("PASS");
});

test("FAIL: recall below floor", () => {
  const gate = g(["flux"], { nouns: ["image"], verbs: ["render"] });
  const r = scoreGate(gate, { gate: "t", recallFloor: 0.9, adversarial: ["render an image", "draw a picture no noun verb match here oops"], controls: ["flux"] });
  // "draw a picture..." has noun picture but no listed verb → misses
  expect(r.verdict).toBe("FAIL"); expect(r.misses.length).toBe(1);
});

test("FATAL: a control that does not fire is always FAIL", () => {
  const gate = g(["flux"], { nouns: ["image"], verbs: ["render"] });
  const r = scoreGate(gate, { gate: "t", recallFloor: 0, adversarial: [], controls: ["this-has-no-keyword-or-nounverb"] });
  expect(r.controlsPass).toBe(false); expect(r.verdict).toBe("FAIL"); expect(r.controlFailures.length).toBe(1);
});

test("controls-only gate (empty adversarial) → recall 1, verdict = controlsPass", () => {
  const gate = g(["workflow"]);
  const r = scoreGate(gate, { gate: "t", recallFloor: 0, adversarial: [], controls: ["workflow"] });
  expect(r.recall).toBe(1); expect(r.verdict).toBe("PASS");
});
```
- [ ] **Step 2: Run test to verify it fails** — `bun test qa/gate-recall.test.ts` → FAIL (module not found / `scoreGate` not exported).
- [ ] **Step 3: Write minimal implementation** — `qa/collect-probes.ts`:
```ts
/** QA-only probe set for a keyword gate. Exported as a PLAIN object by each gated
 *  extension (`__GATE_PROBES__`); extensions must NOT import this type (circular dep
 *  on tool-gate). Shape is enforced by qa/collect-probes.test.ts. */
export interface GateProbeSet {
  /** Canonical gate name — must equal names[0] of some CORPUS_GATES member. */
  gate: string;
  /** Min adversarial-recall fraction to PASS. Default 0.9. 0 = controls-only. */
  recallFloor?: number;
  /** Realistic "I need this tool" phrasings using NO current keyword — should fire. */
  adversarial: string[];
  /** Phrasings carrying a current keyword / satisfying requires — MUST fire (100%). */
  controls: string[];
}
// ALL_PROBES + PROBES_BY_GATE are populated in Task 2 (after extensions export probes).
export const ALL_PROBE_SETS: GateProbeSet[] = [];
export const PROBES_BY_GATE: Map<string, GateProbeSet> = new Map();
```
`qa/gate-recall.ts`:
```ts
import { gateFires, type ToolGate } from "../extensions/tool-gate.ts";
import type { GateProbeSet } from "./collect-probes.ts";

export const DEFAULT_FLOOR = 0.9;

export interface GateScore {
  recall: number;
  controlsPass: boolean;
  misses: string[];
  controlFailures: string[];
  floor: number;
  verdict: "PASS" | "FAIL";
}

export function scoreGate(gate: ToolGate, p: GateProbeSet): GateScore {
  const floor = p.recallFloor ?? DEFAULT_FLOOR;
  const misses: string[] = [];
  let fired = 0;
  for (const prompt of p.adversarial) {
    if (gateFires(gate, prompt.toLowerCase())) fired++;
    else misses.push(prompt);
  }
  const controlFailures: string[] = [];
  for (const c of p.controls) {
    if (!gateFires(gate, c.toLowerCase())) controlFailures.push(c);
  }
  const recall = p.adversarial.length === 0 ? 1 : fired / p.adversarial.length;
  const controlsPass = controlFailures.length === 0;
  return { recall, controlsPass, misses, controlFailures, floor, verdict: controlsPass && recall >= floor ? "PASS" : "FAIL" };
}
```
- [ ] **Step 4: Run test to verify it passes** — `bun test qa/gate-recall.test.ts` → PASS (4/4).
- [ ] **Step 5: Commit** — `git add qa/collect-probes.ts qa/gate-recall.ts qa/gate-recall.test.ts && git commit -m "feat(tool-gate): pure scoreGate + GateProbeSet type (gate-recall guard)"`.

---

### Task 2: `collect-probes.ts` collector + drift guard

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/qa/collect-probes.ts`
- Test: `bun-apps/pi-agent-ext-tool-gate/qa/collect-probes.test.ts`

**Interfaces:**
- Consumes: `CORPUS_GATES` from `./evaluate.ts` (drift guard only).
- Produces: `PROBES_BY_GATE` populated from real extension exports (after Tasks 5–7 add them). Until then the map is empty and the drift guard asserts structure only.

- [ ] **Step 1: Write the failing test** — `qa/collect-probes.test.ts`:
```ts
import { test, expect } from "bun:test";
import { CORPUS_GATES } from "./evaluate.ts";
import { ALL_PROBE_SETS } from "./collect-probes.ts";

test("every probe targets a real CORPUS_GATES canonical name", () => {
  const canonical = new Set(CORPUS_GATES.map((g) => g.names[0]));
  for (const p of ALL_PROBE_SETS) {
    expect(canonical.has(p.gate), `probe gate '${p.gate}' not in CORPUS_GATES`).toBe(true);
  }
});

test("no two probe sets share a gating signature (one per co-fire group)", () => {
  const sig = (k: string[], r?: { nouns: string[]; verbs: string[] }) => JSON.stringify({ keywords: k, requires: r });
  const byGate = new Map(CORPUS_GATES.map((g) => [g.names[0], g]));
  const seen = new Set<string>();
  for (const p of ALL_PROBE_SETS) {
    const gate = byGate.get(p.gate)!;
    const s = sig(gate.keywords, gate.requires);
    expect(seen.has(s), `duplicate probe set for signature of '${p.gate}'`).toBe(false);
    seen.add(s);
  }
});

test("every probe set is well-formed", () => {
  for (const p of ALL_PROBE_SETS) {
    expect(typeof p.gate).toBe("string");
    expect(Array.isArray(p.adversarial)).toBe(true);
    expect(Array.isArray(p.controls)).toBe(true);
    expect(p.controls.length).toBeGreaterThan(0);
  }
});
```
- [ ] **Step 2: Run test to verify it fails** — `bun test qa/collect-probes.test.ts` → the structural tests pass trivially while `ALL_PROBE_SETS` is empty; that's expected pre-Tasks-5–7. (This test becomes meaningful once probes exist. Keep it green now.)
- [ ] **Step 3: No implementation change needed yet** — `collect-probes.ts` already exports `ALL_PROBE_SETS = []`. Tasks 5–7 populate it.
- [ ] **Step 4: Run test** — `bun test qa/collect-probes.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add qa/collect-probes.test.ts && git commit -m "test(tool-gate): collect-probes drift guard (gate-recall guard)"`.

---

### Task 3: `evaluateGateRecall` + harness `main()`

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/qa/gate-recall.ts`
- Test: `bun-apps/pi-agent-ext-tool-gate/qa/gate-recall.test.ts` (append)

**Interfaces:**
- Consumes: `CORPUS_GATES` (`./evaluate.ts`), `PROBES_BY_GATE` (`./collect-probes.ts`), `scoreGate` (Task 1).
- Produces: `evaluateGateRecall()` → `{ rows, uncovered, pass }`; `main()` exits 0/1.

- [ ] **Step 1: Write the failing test** — append to `qa/gate-recall.test.ts`:
```ts
import { evaluateGateRecall } from "./gate-recall.ts";

test("evaluateGateRecall: covered group scored, uncovered group listed", () => {
  // CORPUS_GATES includes flux2 (covered once Task 5 lands) + many others.
  // Before probes exist: every group is UNCOVERED, pass is true (nothing fails).
  const r = evaluateGateRecall();
  expect(Array.isArray(r.uncovered)).toBe(true);
  expect(r.pass).toBe(true); // no rows → no failures
});
```
- [ ] **Step 2: Run test to verify it fails** — `bun test qa/gate-recall.test.ts` → FAIL (`evaluateGateRecall` not exported).
- [ ] **Step 3: Implement** — append to `qa/gate-recall.ts`:
```ts
import { CORPUS_GATES } from "./evaluate.ts";
import { PROBES_BY_GATE } from "./collect-probes.ts";

export interface GateRecallRow {
  gate: string;
  members: string[];
  recall: number;
  controlsPass: boolean;
  floor: number;
  misses: string[];
  controlFailures: string[];
  verdict: "PASS" | "FAIL";
}

export interface GateRecallReport {
  rows: GateRecallRow[];
  uncovered: string[]; // group representative names with no probe set
  pass: boolean;
}

const sigOf = (g: ToolGate) => JSON.stringify({ keywords: g.keywords, requires: g.requires });

/** Group CORPUS_GATES by gating signature (co-fire siblings share a predicate),
 *  score each group that has a probe set, list the rest as UNCOVERED. */
export function evaluateGateRecall(): GateRecallReport {
  const groupRep = new Map<string, ToolGate>();
  const members = new Map<string, string[]>();
  for (const gate of CORPUS_GATES) {
    const s = sigOf(gate);
    if (!groupRep.has(s)) groupRep.set(s, gate);
    members.set(s, [...(members.get(s) ?? []), gate.names[0]]);
  }
  const rows: GateRecallRow[] = [];
  const uncovered: string[] = [];
  for (const [s, rep] of groupRep) {
    const names = members.get(s)!;
    const probeSet = names.map((n) => PROBES_BY_GATE.get(n)).find((x) => x);
    if (!probeSet) { uncovered.push(rep.names[0]); continue; }
    const sc = scoreGate(rep, probeSet);
    rows.push({ gate: probeSet.gate, members: names, recall: sc.recall, controlsPass: sc.controlsPass, floor: sc.floor, misses: sc.misses, controlFailures: sc.controlFailures, verdict: sc.verdict });
  }
  return { rows, uncovered, pass: rows.every((r) => r.verdict === "PASS") };
}

function main() {
  const r = evaluateGateRecall();
  const pct = (n: number) => (n * 100).toFixed(0) + "%";
  const lines: string[] = [
    "═══════════════════════════════════════════════════════════════",
    " Gate-Recall Guard — adversarial recall over all non-core gates",
    "═══════════════════════════════════════════════════════════════",
  ];
  for (const row of r.rows) {
    const ctrl = row.controlsPass ? "controls ok" : "CONTROL FAIL";
    lines.push(`${row.verdict === "PASS" ? "✅" : "❌"} ${row.gate.padEnd(34)} recall ${pct(row.recall)} (floor ${pct(row.floor)}) · ${ctrl}${row.members.length > 1 ? ` · group[${row.members.length}]` : ""}`);
    for (const m of row.misses) lines.push(`     miss: "${m}"`);
    for (const c of row.controlFailures) lines.push(`     CONTROL MISS: "${c}"`);
  }
  if (r.uncovered.length) lines.push(``, `UNCOVERED (${r.uncovered.length} group(s) without probes): ${r.uncovered.join(", ")}`);
  lines.push(``, `${r.pass ? "✅ PASS" : "❌ FAIL"} — ${r.rows.filter((x) => x.verdict === "FAIL").length} failing gate(s), ${r.uncovered.length} uncovered`);
  console.log(lines.join("\n"));
  process.exit(r.pass ? 0 : 1);
}

if (import.meta.main) main();
```
- [ ] **Step 4: Run test to verify it passes** — `bun test qa/gate-recall.test.ts` → PASS.
- [ ] **Step 5: Add the regression test** — append to `qa/gate-recall.test.ts`:
```ts
test("regression: removing a keyword turns a PASS row red", () => {
  // Build a gate + probe mirroring a real crisp gate, then weaken it.
  const strong = g(["flux"], { nouns: ["image"], verbs: ["render"] });
  const weak = g(["flux"], { nouns: ["image"], verbs: ["__never__"] }); // verb removed
  const probes = { gate: "t", recallFloor: 0.9, adversarial: ["render an image"], controls: ["flux"] };
  expect(scoreGate(strong, probes).verdict).toBe("PASS");
  expect(scoreGate(weak, probes).verdict).toBe("FAIL");
});
```
Run: `bun test qa/gate-recall.test.ts` → PASS.
- [ ] **Step 6: Commit** — `git add qa/gate-recall.ts qa/gate-recall.test.ts && git commit -m "feat(tool-gate): evaluateGateRecall harness + main (gate-recall guard)"`.

---

### Task 4: Wire into `qa/run.ts` + scripts; delete `miss-rate-ab.ts`

**Files:**
- Modify: `bun-apps/pi-agent-ext-tool-gate/qa/run.ts`
- Modify: `bun-apps/pi-agent-ext-tool-gate/package.json`
- Delete: `bun-apps/pi-agent-ext-tool-gate/qa/miss-rate-ab.ts`

**Interfaces:**
- Consumes: `evaluateGateRecall()` (Task 3).
- Produces: `bun run qa` includes gate-recall; `bun run qa:gate-recall` runs it standalone.

- [ ] **Step 1: Edit `qa/run.ts`** — (a) add import near the other qa imports:
```ts
import { evaluateGateRecall, type GateRecallReport } from "./gate-recall.ts";
```
(b) add a field to `QaResult`: `gateRecall: GateRecallReport;`
(c) inside `runQa()`, after `const corpus = evaluateCorpus();` add:
```ts
	const gateRecall = evaluateGateRecall();
```
(d) change the `pass` computation to include `&& gateRecall.pass`:
```ts
	const pass =
		(opts.strict ? intendedOk && strictOk && strictCoverageOk : intendedOk) && savingsFloorMet && gateRecall.pass;
```
(e) add a `reason` branch before the final `else` (insert above the savings-floor reason is fine — order: check gateRecall after savingsFloorMet/intendedOk). Simplest: append to the returned object `gateRecall,` and add to the ternary reason chain a new arm:
```ts
		: !gateRecall.pass
			? `gate-recall: ${gateRecall.rows.filter((r) => r.verdict === "FAIL").length} gate(s) below recall floor or with broken controls`
```
(insert this arm into the existing `reason` ternary, right after the `!sane` arm and before the `opts.strict && !strictOk` arm.)
(f) add `gateRecall,` to the returned object literal in `runQa()`.
(g) in `main()`'s `summary` array, append:
```ts
		`gate-recall: ${r.gateRecall.rows.filter((x) => x.verdict === "PASS").length}/${r.gateRecall.rows.length} gates pass · ${r.gateRecall.uncovered.length} uncovered`,
```
- [ ] **Step 2: Edit `package.json` `scripts`** — replace the `qa:miss-ab` line and add `qa:gate-recall`:
```json
    "qa:gate-recall": "bun run qa/gate-recall.ts",
    "qa:miss-ab": "bun run qa/gate-recall.ts",
```
- [ ] **Step 3: Delete the dead file** — `git rm qa/miss-rate-ab.ts`.
- [ ] **Step 4: Run the gate** — `bun run qa` → PASS (all rows green or uncovered; no failures yet since probes land in Tasks 5–7). Then `bun run qa:gate-recall` → prints the table, exits 0.
- [ ] **Step 5: Commit** — `git add qa/run.ts package.json && git commit -m "feat(tool-gate): wire gate-recall into qa + qa:gate-recall; drop miss-rate-ab"` (the deletion stages via `git rm`).

---

### Task 5: Crisp-intent probes — image/video generation

**Files (add a top-level `__GATE_PROBES__` export to each):**
- `bun-apps/pi-agent-ext-flux2/extensions/flux2.ts`
- `bun-apps/pi-agent-ext-ltx/extensions/ltx.ts`
- `bun-apps/pi-agent-ext-movie-director/extensions/movie-director.ts`
- `bun-apps/pi-agent-ext-krea2/extensions/krea2.ts`
- Modify: `bun-apps/pi-agent-ext-tool-gate/qa/collect-probes.ts` (import the 4 + populate `ALL_PROBE_SETS`/`PROBES_BY_GATE`)

**Interfaces:**
- Produces: 4 probe sets keyed `flux2`, `ltx`, `movie`, `krea2` (all `recallFloor: 0.9`).

- [ ] **Step 1: Add exports.** In `flux2.ts` (top-level, alongside `coerceOptions`):
```ts
export const __GATE_PROBES__ = {
  gate: "flux2",
  recallFloor: 0.9,
  adversarial: [
    "render the scene you described as a picture",
    "draw what you just outlined for me",
    "produce a visual of that concept",
    "把這段描述做成一張照片",
  ],
  controls: ["generate an image of a cat", "txt2img a landscape", "用 flux2 產圖"],
};
```
In `ltx.ts`:
```ts
export const __GATE_PROBES__ = {
  gate: "ltx",
  recallFloor: 0.9,
  adversarial: ["animate the sequence into a video", "produce a video clip of that transition", "把這段做成影片"],
  controls: ["generate a video", "t2v the prompt", "用 ltx 生成影片"],
};
```
In `movie-director.ts`:
```ts
export const __GATE_PROBES__ = {
  gate: "movie",
  recallFloor: 0.9,
  adversarial: [
    "assemble these clips into a short piece",
    "turn the footage into a narrative cut",
    "direct a sequence from these scenes",
    "把這些片段剪成一支作品",
  ],
  controls: ["make a movie from these scenes", "compose video from the clips", "做一個分鏡"],
};
```
In `krea2.ts`:
```ts
export const __GATE_PROBES__ = {
  gate: "krea2",
  recallFloor: 0.9,
  adversarial: ["doodle a quick concept", "live-draw a fast mockup", "快速畫一個草稿"],
  controls: ["sketch the idea", "用 krea2 快速生成", "real-time draw"],
};
```
- [ ] **Step 2: Wire into the collector** — in `collect-probes.ts`, replace the empty arrays:
```ts
import { __GATE_PROBES__ as flux2Probes } from "@repo/pi-agent-ext-flux2/extensions/flux2.ts";
import { __GATE_PROBES__ as ltxProbes } from "@repo/pi-agent-ext-ltx/extensions/ltx.ts";
import { __GATE_PROBES__ as movieProbes } from "@repo/pi-agent-ext-movie-director/extensions/movie-director.ts";
import { __GATE_PROBES__ as krea2Probes } from "@repo/pi-agent-ext-krea2/extensions/krea2.ts";

export const ALL_PROBE_SETS: GateProbeSet[] = [flux2Probes, ltxProbes, movieProbes, krea2Probes];
export const PROBES_BY_GATE: Map<string, GateProbeSet> = new Map(ALL_PROBE_SETS.map((p) => [p.gate, p]));
```
- [ ] **Step 3: Run + verify** — `bun run qa:gate-recall` → flux2/ltx/movie/krea2 now appear as scored rows; `bun test qa/collect-probes.test.ts` → drift guard PASS. `bun run qa` → PASS.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(tool-gate): gate-recall probes — flux2/ltx/movie/krea2"`.

---

### Task 6: Crisp-intent probes — doc / research / web

**Files:**
- `bun-apps/pi-agent-ext-file2md/extensions/file2md.ts`
- `bun-apps/pi-agent-ext-research-tool/extensions/research-tool.ts` (TWO exports: collect_videos, arxiv_search)
- `bun-apps/pi-agent-ext-zai-mcp/extensions/zai-mcp.ts`
- Modify: `bun-apps/pi-agent-ext-tool-gate/qa/collect-probes.ts`

- [ ] **Step 1: Add exports.** In `file2md.ts`:
```ts
export const __GATE_PROBES__ = {
  gate: "file2md",
  recallFloor: 0.9,
  adversarial: ["extract the text from this PDF", "parse the scanned document", "把這份文件讀成文字"],
  controls: ["ocr this image", "convert the pdf to markdown", "用 file2md 分析圖片"],
};
```
In `research-tool.ts` (two named exports):
```ts
export const COLLECT_VIDEOS_PROBES = {
  gate: "collect_videos",
  recallFloor: 0.9,
  adversarial: ["gather clips from video platforms", "pull trending footage for research", "把 vault 的筆記排一下"],
  controls: ["collect videos from bilibili", "organize vault notes", "收集影片"],
};
export const ARXIV_SEARCH_PROBES = {
  gate: "arxiv_search",
  recallFloor: 0.9,
  adversarial: ["look up papers on diffusion models", "find recent literature on this topic", "查一下相關論文"],
  controls: ["search arxiv for transformers", "find papers on rlhf", "找論文"],
};
```
In `zai-mcp.ts`:
```ts
export const __GATE_PROBES__ = {
  gate: "zai_web_search_web_search_prime",
  recallFloor: 0.9,
  adversarial: ["search the web for this", "look this up online", "網路搜尋一下"],
  controls: ["use z.ai search", "zai web search for news", "用 z.ai reader 讀這頁"],
};
```
- [ ] **Step 2: Wire into the collector** — add imports + append to `ALL_PROBE_SETS`:
```ts
import { __GATE_PROBES__ as file2mdProbes } from "@repo/pi-agent-ext-file2md/extensions/file2md.ts";
import { COLLECT_VIDEOS_PROBES, ARXIV_SEARCH_PROBES } from "@repo/pi-agent-ext-research-tool/extensions/research-tool.ts";
import { __GATE_PROBES__ as zaiProbes } from "@repo/pi-agent-ext-zai-mcp/extensions/zai-mcp.ts";
```
…and add `file2mdProbes, COLLECT_VIDEOS_PROBES, ARXIV_SEARCH_PROBES, zaiProbes` into the `ALL_PROBE_SETS` array.
- [ ] **Step 3: Run + verify** — `bun run qa:gate-recall` (8 gates now scored) + `bun run qa` → PASS.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(tool-gate): gate-recall probes — file2md/collect_videos/arxiv_search/zai"`.

---

### Task 7: Dispatch / utility probes — controls-only

**Files:**
- `bun-apps/pi-agent-ext-workflow/extensions/workflow.ts` (covers the workflow+subagent co-fire group)
- `bun-apps/pi-agent-ext-power-tool/extensions/power-tool.ts` (inspect_context group)
- `bun-apps/pi-agent-ext-devops/extensions/devops.ts` (pi_deploy group + 7 single-name gates = 8 exports)
- `bun-apps/pi-agent-ext-hermes-memory/src/tools/memory-supersede-tool.ts`
- Modify: `bun-apps/pi-agent-ext-tool-gate/qa/collect-probes.ts`

- [ ] **Step 1: Add exports** (all `recallFloor: 0`, `adversarial: []`, controls-only). In `workflow.ts`:
```ts
export const __GATE_PROBES__ = { gate: "workflow", recallFloor: 0, adversarial: [], controls: ["orchestrate a fan-out of tasks", "run a multi-step pipeline", "用 workflow 編排"] };
```
In `power-tool.ts`:
```ts
export const __GATE_PROBES__ = { gate: "inspect_context", recallFloor: 0, adversarial: [], controls: ["inspect the agent context", "show token usage", "diagnose extension pathology"] };
```
In `memory-supersede-tool.ts`:
```ts
export const __GATE_PROBES__ = { gate: "memory_supersede", recallFloor: 0, adversarial: [], controls: ["supersede the old memory", "retire that outdated note", "replace the memory entry"] };
```
In `devops.ts` (eight exports):
```ts
export const PI_DEPLOY_PROBES = { gate: "pi_deploy", recallFloor: 0, adversarial: [], controls: ["build the pi-agent bundle", "deploy the extension", "打包 pi-agent"] };
export const AWAIT_PR_MERGE_PROBES = { gate: "await_pr_merge", recallFloor: 0, adversarial: [], controls: ["merge the pr", "ship the pull-request", "wait for pr merge"] };
export const SWEEP_BRANCHES_PROBES = { gate: "sweep_branches", recallFloor: 0, adversarial: [], controls: ["sweep stale branches", "prune and cleanup branches", "delete-branch remotely"] };
export const LOCAL_CI_PROBES = { gate: "local_ci", recallFloor: 0, adversarial: [], controls: ["run local ci", "typecheck and test", "verify the gate is green"] };
export const SYNC_REPO_PROBES = { gate: "sync_repo", recallFloor: 0, adversarial: [], controls: ["sync with origin/main", "fetch and rebase", "merge --ff-only"] };
export const DEVOPS_RETROSPECT_PROBES = { gate: "devops_retrospect", recallFloor: 0, adversarial: [], controls: ["run a retrospect", "review for anomalies", "reflect on the post-run"] };
export const PREPARE_BRANCH_PROBES = { gate: "prepare_branch", recallFloor: 0, adversarial: [], controls: ["prepare the branch", "rebase before force-push", "branch is behind, prepare it"] };
export const VERIFY_MERGE_PROBES = { gate: "verify_merge", recallFloor: 0, adversarial: [], controls: ["verify the merge scope", "check for contaminated merge", "verify spent correctly"] };
```
- [ ] **Step 2: Wire into the collector** — imports:
```ts
import { __GATE_PROBES__ as workflowProbes } from "@repo/pi-agent-ext-workflow/extensions/workflow.ts";
import { __GATE_PROBES__ as inspectProbes } from "@repo/pi-agent-ext-power-tool/extensions/power-tool.ts";
import { PI_DEPLOY_PROBES, AWAIT_PR_MERGE_PROBES, SWEEP_BRANCHES_PROBES, LOCAL_CI_PROBES, SYNC_REPO_PROBES, DEVOPS_RETROSPECT_PROBES, PREPARE_BRANCH_PROBES, VERIFY_MERGE_PROBES } from "@repo/pi-agent-ext-devops/extensions/devops.ts";
import { __GATE_PROBES__ as memorySupersedeProbes } from "@repo/pi-agent-ext-hermes-memory/src/tools/memory-supersede-tool.ts";
```
…and append all 11 into `ALL_PROBE_SETS`. (workflow covers workflow+workflow_help+workflow_control+subagent+subagents via signature-grouping; pi_deploy covers pi_deploy+pi_verify.)
- [ ] **Step 3: Run + verify** — `bun run qa:gate-recall` → all 19 signature-groups now scored (UNCOVERED should be empty or near-empty). `bun run qa` → PASS. `bun test` (whole package) → green.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(tool-gate): gate-recall probes — workflow/inspect/devops/memory_supersede (controls-only)"`.

---

### Task 8: Calibration run — set per-gate `recallFloor` from observed baseline

**Files:**
- Modify: the `recallFloor` values across the probe exports (Tasks 5–7), as observed below.

**Procedure (do NOT guess floors — measure first):**

- [ ] **Step 1: Run the harness and record baseline recall per crisp-intent gate.** Run `bun run qa:gate-recall` and capture the `recall X% (floor 90%)` for flux2/ltx/movie/krea2/file2md/collect_videos/arxiv_search/zai.
- [ ] **Step 2: For each crisp gate, decide:**
  - If observed recall ≥ 90% → keep `recallFloor: 0.9` (the gate is healthy).
  - If observed recall is 60–89% → this is a REAL signal: either (a) broaden that gate's keywords/requires in its extension to raise recall, or (b) if broadening would cause false-fires, lower that gate's `recallFloor` to the observed level with a code comment naming the trade-off. Prefer (a) when the miss is an obvious intent (e.g. movie missing "assemble … into a film" → add the keyword).
  - Dispatch-gate floors stay `0` (controls-only by design).
- [ ] **Step 3: Re-run** `bun run qa:gate-recall` → every scored row green; `bun run qa` → PASS.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "chore(tool-gate): calibrate gate-recall floors from observed baseline"`.

---

## Self-Review (run after writing — already applied)

- **Spec coverage:** guard-with-threshold (Tasks 1,3,4) ✓; co-located owner-declared probes (Tasks 5–7) ✓; all non-core gates via signature-grouping (Task 3 + Tasks 5–7) ✓; per-gate threshold (recallFloor) ✓; calibration (Task 8) ✓; replaces dead miss-rate-ab.ts (Task 4) ✓.
- **Type consistency:** `GateProbeSet`/`GateScore`/`GateRecallRow` defined once, consumed consistently. `scoreGate(gate, probes)` signature stable across tasks.
- **Placeholders:** none — every step has complete code or an exact procedure.
