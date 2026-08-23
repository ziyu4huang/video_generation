# cc-parity-task-ext Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align `ask_user_question`, `/loop`, `/goal`, and the wizard skill to Claude Code's behavior (schema + prompt + TUI; command surface; Bun template), replacing the process-improvement `/loop` with a CC-style recurring scheduler.

**Architecture:** Four independent tickets (spec D7): 01 edits `src/ask-user/` in place (schema → description → view layer, each step test-gated); 02 swaps `template.sh` for a Bun `template.ts` inside the wizard skill; 03 deletes the six-module process loop and builds a 3-module timer scheduler, then removes goal's four coupling sites; 04 is a surgical `/goal` command-parser change. No ticket depends on another.

**Tech Stack:** Bun + TypeScript, typebox schemas, `@earendil-works/pi-tui` / `pi-coding-agent` extension API, `bun:test`.

**Spec:** `.planning/2026-08-23-cc-parity-task-ext/spec.md` (decisions D1–D7, parity ledger §6).

## Global Constraints

- Run bun from repo root or with `--cwd`; never top-level `cd` — use `( cd <dir> && … )`.
- Ticket 01 gate: `( cd bun-apps/s2-agent-ext-task && bun run typecheck && bun test )`.
- Ticket 02 gate: `( cd bun-apps/s2-agent-ext-wayfind && bun run check && bun run test:unit && bun run test:probe )`.
- Written artifacts (code, comments, commits, docs) always English; repo communication zh_TW only in chat.
- Planning ticket files live in `.planning/2026-08-23-cc-parity-task-ext/tickets/`; flip `status:` to `closed` and append a `## Result` section when a ticket lands.
- The CC reference behavior is quoted verbatim in spec §6.1 / this plan; where research was UNVERIFIED, the first-hand CC harness tool description (spec §6.1) is authoritative.
- After each ticket: dispatch the requesting-code-review reviewer subagent (Standards/Spec axes) before moving on.
- s2-agent version bump at PR finish via `version-bump-cli.ts --package s2-agent --patch` (nudged by merge tool if skipped).

---

## Task 1 (ticket 01): schema + validation parity

**Files:**
- Modify: `bun-apps/s2-agent-ext-task/src/ask-user/tool/types.ts`
- Modify: `bun-apps/s2-agent-ext-task/src/ask-user/tool/validate-questionnaire.ts`
- Test: `bun-apps/s2-agent-ext-task/src/ask-user/__tests__/cc-parity-schema.test.ts` (new)

**Interfaces:**
- Produces: `MAX_HEADER_LENGTH = 12`, `RECOMMENDED_SUFFIX = " (Recommended)"`, `hasRecommendedSuffix(label): boolean`, error kind `"preview_on_multiselect"`; `recommended` field REMOVED from `OptionSchema`; label `maxLength` REMOVED. Tasks 2–3 consume `RECOMMENDED_SUFFIX` / `hasRecommendedSuffix`.

- [ ] **Step 1: Write the failing tests**

Create `src/ask-user/__tests__/cc-parity-schema.test.ts`:

```typescript
/** CC-parity schema — header 12, suffix-based recommended, preview single-select. */
import { test, expect, describe } from "bun:test";
import { validateQuestionnaire } from "../tool/validate-questionnaire.js";
import {
	MAX_HEADER_LENGTH,
	RECOMMENDED_SUFFIX,
	hasRecommendedSuffix,
	type QuestionParams,
} from "../tool/types.js";

function params(questions: unknown[]): QuestionParams {
	return { questions } as unknown as QuestionParams;
}

describe("CC parity schema", () => {
	test("header over 12 chars is rejected", () => {
		const r = validateQuestionnaire(
			params([{ question: "q?", header: "13-char header", options: [{ label: "a", description: "d" }, { label: "b", description: "d" }] }]),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("12");
	});

	test("header of exactly 12 chars passes", () => {
		const r = validateQuestionnaire(
			params([{ question: "q?", header: "12 characters", options: [{ label: "a", description: "d" }, { label: "b", description: "d" }] }]),
		);
		expect(r.ok).toBe(true);
	});

	test("label longer than 60 chars is accepted (no hard limit)", () => {
		const long = `${"word ".repeat(20)}end`;
		const r = validateQuestionnaire(
			params([{ question: "q?", header: "hdr", options: [{ label: long, description: "d" }, { label: "b", description: "d" }] }]),
		);
		expect(r.ok).toBe(true);
	});

	test("preview on a multiSelect question is rejected", () => {
		const r = validateQuestionnaire(
			params([{
				question: "q?", header: "hdr", multiSelect: true,
				options: [
					{ label: "a", description: "d", preview: "x" },
					{ label: "b", description: "d" },
				],
			}]),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("preview_on_multiselect");
	});

	test("preview on a single-select question still passes", () => {
		const r = validateQuestionnaire(
			params([{
				question: "q?", header: "hdr",
				options: [
					{ label: "a", description: "d", preview: "x" },
					{ label: "b", description: "d" },
				],
			}]),
		);
		expect(r.ok).toBe(true);
	});

	test("more than one (Recommended)-suffixed label is rejected", () => {
		const r = validateQuestionnaire(
			params([{
				question: "q?", header: "hdr",
				options: [
					{ label: `Alpha${RECOMMENDED_SUFFIX}`, description: "d" },
					{ label: `Beta${RECOMMENDED_SUFFIX}`, description: "d" },
				],
			}]),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("too_many_recommended");
	});

	test("hasRecommendedSuffix matches only the exact CC suffix", () => {
		expect(hasRecommendedSuffix(`A${RECOMMENDED_SUFFIX}`)).toBe(true);
		expect(hasRecommendedSuffix("A (recommended)")).toBe(false);
		expect(hasRecommendedSuffix("A (Recommended) ")).toBe(false);
		expect(hasRecommendedSuffix("A")).toBe(false);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/s2-agent-ext-task && bun test src/ask-user/__tests__/cc-parity-schema.test.ts )`
Expected: FAIL — `MAX_HEADER_LENGTH` is 16 (13-char header passes), `RECOMMENDED_SUFFIX`/`hasRecommendedSuffix` not exported, no `preview_on_multiselect` error.

- [ ] **Step 3: Implement schema changes**

In `tool/types.ts`:

1. `export const MAX_HEADER_LENGTH = 12;` (was 16). Update its two description strings that interpolate it — they stay correct automatically.
2. Delete `export const MAX_LABEL_LENGTH = 60;` and the `maxLength: MAX_LABEL_LENGTH` + hard-limit sentence from `OptionSchema.label`; new description: `"The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice."` (CC wording).
3. Add after `MAX_OPTIONS`:

```typescript
/** CC convention: the recommended option carries this label suffix and sits first. */
export const RECOMMENDED_SUFFIX = " (Recommended)";

export function hasRecommendedSuffix(label: string): boolean {
	return label.endsWith(RECOMMENDED_SUFFIX);
}
```

4. DELETE the whole `recommended` field from `OptionSchema`.
5. `preview` description → `"Optional preview content, rendered as markdown in a monospace box next to the options (side-by-side layout). Use for ASCII mockups of UI layouts or components, code snippets, diagrams, graphs, or configuration examples. Only supported for single-select questions."` (CC wording).
6. `QuestionSchema.header` description → `` `Very short label displayed as a chip/tag next to the question. Max ${MAX_HEADER_LENGTH} characters.` `` (examples line CC keeps: `Examples: "Auth method", "Library".`).
7. `QuestionSchema.multiSelect` description → `"Set to true to allow the user to select multiple options instead of just one. Use for questions where multiple answers are valid; phrase the question accordingly. Do not use for mutually exclusive choices."` (CC wording).
8. `QuestionnaireError` union: replace nothing, ADD `"preview_on_multiselect"`.

In `tool/validate-questionnaire.ts`:

1. Remove `MAX_LABEL_LENGTH` from the import; add `hasRecommendedSuffix`.
2. Replace the `recommendedCount` block:

```typescript
const recommendedCount = opts.filter((o) => hasRecommendedSuffix(o.label)).length;
if (recommendedCount > 1) {
	return {
		ok: false,
		message: `Error: question ${qi + 1} has ${recommendedCount} options labeled "(Recommended)" (at most one allowed).`,
		error: "too_many_recommended",
	};
}
```

3. Delete the `opt.label.length > MAX_LABEL_LENGTH` rejection block.
4. After the `MIN_OPTIONS/MAX_OPTIONS` check, add:

```typescript
if (q.multiSelect === true && opts.some((o) => typeof o.preview === "string" && o.preview.length > 0)) {
	return {
		ok: false,
		message: `Error: question ${qi + 1} is multiSelect but has a preview — previews are only supported for single-select questions.`,
		error: "preview_on_multiselect",
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/s2-agent-ext-task && bun test src/ask-user/__tests__/cc-parity-schema.test.ts )`
Expected: PASS (7 tests).

- [ ] **Step 5: Migrate existing tests that authored the old shapes**

`( cd bun-apps/s2-agent-ext-task && bun test src/ask-user 2>&1 | grep -E "^\(fail\)|fail.*test" | head -20 )` — fix each failure:
- Anywhere `recommended: true` was authored → replace with `label: "X (Recommended)"`.
- Anywhere a header of 13–16 chars was authored → shorten to ≤12.
- `config.test.ts` / `rpc-fallback.test.ts` / `cards-ux2-roundtrip.test.ts`: check for `recommended` or >12-char headers with `grep -rn "recommended\|header:" src/ask-user/__tests__/` and fix the same way.

Leave `recommended-marker.test.ts` for Task 3 (it tests the view layer this task just orphaned).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/s2-agent-ext-task/src/ask-user
git commit -m "feat(task): ask_user_question CC-parity schema — header 12, suffix recommended, preview single-select"
```

---

## Task 2 (ticket 01): tool description CC rewrite

**Files:**
- Modify: `bun-apps/s2-agent-ext-task/src/ask-user/ask-user-question.ts:86-100` (description + snippet/guidelines)
- Test: extend `src/ask-user/__tests__/cc-parity-schema.test.ts`

**Interfaces:**
- Consumes: `RECOMMENDED_SUFFIX` from Task 1.
- Produces: `DEFAULT_PROMPT_SNIPPET` / `DEFAULT_PROMPT_GUIDELINES` strings used by `registerAskUserQuestionTool`.

- [ ] **Step 1: Write the failing test**

Append to `cc-parity-schema.test.ts`:

```typescript
import { DEFAULT_PROMPT_SNIPPET, DEFAULT_PROMPT_GUIDELINES } from "../ask-user-question.js";

describe("CC-parity tool description", () => {
	test("guidelines teach the CC recommended convention and plan-mode rule", () => {
		const all = DEFAULT_PROMPT_GUIDELINES.join("\n");
		expect(all).toContain("(Recommended)");
		expect(all).toContain("first");
		expect(DEFAULT_PROMPT_GUIDELINES.some((g) => g.toLowerCase().includes("plan"))).toBe(true);
		expect(all).not.toContain("recommended: true");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/s2-agent-ext-task && bun test src/ask-user/__tests__/cc-parity-schema.test.ts )`
Expected: FAIL — current guidelines say `recommended: true` and mention no plan rule.

- [ ] **Step 3: Rewrite description, snippet, guidelines**

Replace the `description` string in `registerAskUserQuestionTool` with (CC structure, adapted plan-mode paragraph):

```
Ask the user 1-4 structured questions to clarify requirements or get decisions. Each question has a short header, 2-4 options (label + description), and the user can always type a custom answer or press Esc to abandon.

Usage notes:
- Users will always be able to type a custom answer ("Type something." row is appended automatically to every question). Do NOT author "Other" / "Type something." labels yourself — duplicates are rejected at runtime.
- If you recommend a specific option, add "(Recommended)" to the end of its label and place it first in the list. At most one per question.
- Use multiSelect: true ONLY when multiple answers are valid; phrase the question accordingly. Do not use it for mutually exclusive choices.
- Preview feature: use the optional `preview` field on options when presenting concrete artifacts the user needs to visually compare — mockups, code snippets, diagram variations, config examples. Previews render as markdown in a monospace box with a side-by-side layout, and are only supported for single-select questions.
- Clarify requirements BEFORE finalizing a plan; when a plan-approval flow exists, ask clarifying questions before presenting the plan, and never use this tool to ask "is the plan ready" — that is the plan-approval flow's job.
```

Replace the two constants:

```typescript
export const DEFAULT_PROMPT_SNIPPET = `Ask the user 1-4 structured questions (2-4 options each) when requirements are ambiguous or a decision is needed`;

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Use when ambiguous (up to ${MAX_QUESTIONS} questions, ${MIN_OPTIONS}-${MAX_OPTIONS} options each). Each option needs a concise label + description. User can type a custom answer or Esc to quit.`,
	"Mark your recommended option by suffixing its label with \"(Recommended)\" and placing it first — at most one per question. Never add any other recommended marker.",
	"multiSelect only when several answers are valid; preview only on single-select questions (markdown, monospace box, side-by-side).",
	"Batch all questions in one call (don't stack). In planning work, clarify BEFORE presenting a plan; never ask \"is the plan ready\" with this tool.",
];
```

- [ ] **Step 4: Run tests, then the full ask-user suite**

Run: `( cd bun-apps/s2-agent-ext-task && bun test src/ask-user )`
Expected: PASS except `recommended-marker.test.ts` (Task 3 migrates it).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-task/src/ask-user
git commit -m "feat(task): ask_user_question tool description rewritten to CC semantics"
```

---

## Task 3 (ticket 01): view layer — suffix-driven ⭐ + preview monospace box

**Files:**
- Modify: `bun-apps/s2-agent-ext-task/src/ask-user/ask-user-question.ts` (`buildItemsForQuestion`)
- Modify: `bun-apps/s2-agent-ext-task/src/ask-user/view/components/wrapping-select.ts:160-170`
- Modify: `bun-apps/s2-agent-ext-task/src/ask-user/view/components/preview/preview-block-renderer.ts`
- Test: rewrite `src/ask-user/__tests__/recommended-marker.test.ts`

**Interfaces:**
- Consumes: `hasRecommendedSuffix`, `RECOMMENDED_SUFFIX` (Task 1).
- Produces: `buildItemsForQuestion` sets `recommended` from the label suffix; the answer string keeps the authored label (suffix included) — CC parity.

- [ ] **Step 1: Rewrite the failing tests**

Replace `recommended-marker.test.ts` content with:

```typescript
/**
 * recommended marker, CC convention — the model suffixes the label with
 * "(Recommended)"; the view renders ⭐ and strips the suffix from DISPLAY only.
 * The stored label (and therefore the answer string) keeps the suffix, matching
 * Claude Code, where the answer carries the label as authored.
 */
import { test, expect, describe } from "bun:test";
import { validateQuestionnaire } from "../tool/validate-questionnaire.js";
import { buildItemsForQuestion } from "../ask-user-question.js";
import { WrappingSelect } from "../view/components/wrapping-select.js";
import { RECOMMENDED_SUFFIX, type QuestionData, type QuestionParams } from "../tool/types.js";

const theme = new Proxy(
	{},
	{
		get:
			() =>
			(...args: unknown[]) =>
				args.map((a) => (typeof a === "string" ? a : "")).join(""),
	},
) as never;

function q(labels: string[]): QuestionData {
	return { question: "q?", header: "hdr", options: labels.map((l) => ({ label: l, description: "d" })) } as never;
}
function params(data: QuestionData): QuestionParams {
	return { questions: [data] } as unknown as QuestionParams;
}

describe("recommended marker (CC suffix convention)", () => {
	test("validation rejects two suffixed labels", () => {
		const r = validateQuestionnaire(params(q([`A${RECOMMENDED_SUFFIX}`, `B${RECOMMENDED_SUFFIX}`])));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("too_many_recommended");
	});

	test("buildItemsForQuestion derives recommended from the suffix", () => {
		const items = buildItemsForQuestion(q([`Alpha${RECOMMENDED_SUFFIX}`, "Beta"]));
		expect((items[0] as { recommended?: boolean }).recommended).toBe(true);
		expect((items[1] as { recommended?: boolean }).recommended).toBeUndefined();
	});

	test("WrappingSelect renders ⭐ and strips the suffix from display", () => {
		const items = buildItemsForQuestion(q([`Alpha${RECOMMENDED_SUFFIX}`, "Beta"]));
		const ws = new WrappingSelect(items, 8, theme);
		ws.setSelectedIndex(0);
		const out = ws.render(80).join("\n");
		expect(out).toContain("⭐");
		expect(out).toContain("Alpha");
		expect(out).not.toContain("(Recommended)");
		// stored label keeps the suffix → answer parity with CC
		expect(items[0].label).toBe(`Alpha${RECOMMENDED_SUFFIX}`);
	});

	test("unsuffixed options render no star", () => {
		const items = buildItemsForQuestion(q(["Alpha", "Beta"]));
		const ws = new WrappingSelect(items, 8, theme);
		ws.setSelectedIndex(0);
		expect(ws.render(80).join("\n")).not.toContain("⭐");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/s2-agent-ext-task && bun test src/ask-user/__tests__/recommended-marker.test.ts )`
Expected: FAIL — `buildItemsForQuestion` still reads `o.recommended` (now always undefined), display still shows the raw label.

- [ ] **Step 3: Implement**

`ask-user-question.ts` `buildItemsForQuestion`:

```typescript
export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
		recommended: hasRecommendedSuffix(o.label),
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}
```

(Add `hasRecommendedSuffix` to the existing `./tool/types.js` import.)

`wrapping-select.ts` — the render line at ~166 currently:

```typescript
const star = item.kind === "option" && item.recommended ? "⭐ " : "";
```

Replace with suffix-aware display (import `RECOMMENDED_SUFFIX` from `../../../tool/types.js`):

```typescript
const isRec = item.kind === "option" && item.recommended === true;
const star = isRec ? "⭐ " : "";
```

and where the option label is rendered, use:

```typescript
const displayLabel =
	isRec && item.label.endsWith(RECOMMENDED_SUFFIX)
		? item.label.slice(0, item.label.length - RECOMMENDED_SUFFIX.length)
		: item.label;
```

(Keep every other use of `item.label` in that render path on `displayLabel` so the visible row is suffix-free; wrapping math already runs on the display string.)

`preview-block-renderer.ts` `render()`: replace the soft-wrap loop

```typescript
const previewLines = option.preview.split("\n");
for (const line of previewLines) {
	const wrapped = wrapTextWithAnsi(line, width);
	lines.push(...wrapped);
}
```

with monospace-verbatim rendering (CC: "rendered as markdown in a monospace box"; we keep verbatim lines — hard-clip, no re-wrap — and note in the ticket Result that full markdown rendering is deliberately not built):

```typescript
// Monospace-verbatim preview (CC parity): code and ASCII mockups must not
// re-wrap. Full markdown rendering is deliberately out of scope.
const clip = (line: string): string => (line.length > width ? line.slice(0, width) : line);
for (const line of option.preview.split("\n")) {
	lines.push(clip(line));
}
```

Remove the now-unused `wrapTextWithAnsi` import if nothing else in the file uses it.

- [ ] **Step 4: Run the full ask-user suite + typecheck**

Run: `( cd bun-apps/s2-agent-ext-task && bun run typecheck && bun test src/ask-user )`
Expected: PASS. If `cards-ux2-roundtrip.test.ts` or preview tests assert wrapped preview text, update the expectation to the verbatim form (they migrated in Task 1 Step 5 only for schema; preview-text assertions migrate here).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-task/src/ask-user
git commit -m "feat(task): ask_user_question view — suffix-driven star, monospace preview box"
```

- [ ] **Step 6: Close ticket 01 + review**

Flip `tickets/01-ask-user-cc-parity.md` `status: closed`, append `## Result`; commit `docs(planning): close ticket 01 …`. Dispatch the requesting-code-review reviewer (BASE = commit before Task 1, HEAD = this commit).

---

## Task 4 (ticket 02): wizard template.sh → template.ts

**Files:**
- Create: `bun-apps/s2-agent-ext-wayfind/skills/wizard/template.ts`
- Modify: `bun-apps/s2-agent-ext-wayfind/skills/wizard/SKILL.md`
- Delete: `bun-apps/s2-agent-ext-wayfind/skills/wizard/template.sh`
- Modify (if it says bash): `bun-apps/s2-agent-ext-wayfind/skills/ask-matt/SKILL.md:105`

**Interfaces:**
- Produces: a self-contained Bun wizard template whose STAGES section is the only authored part. No package imports — plain `Bun.*` APIs + `node:child_process` so the file runs from any cwd via `bun <file>`.

- [ ] **Step 1: Author template.ts**

Create `skills/wizard/template.ts` with this exact content:

```typescript
#!/usr/bin/env bun
//
// A wizard — walks a human through a manual procedure step by step.
// Generated by the wizard skill.
//
// Everything above the "STAGES" marker is the wizard library: do not hand-edit
// it. Author the per-step stages below the marker.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as readline from "node:readline";

// ──────────────────────────────────────────────────────────────────────────
// Wizard library — delightful, consistent UX. Identical across every wizard.
// ──────────────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY === true;
const C = {
	bold: (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
	dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
	blue: (s: string) => (isTTY ? `\x1b[34m${s}\x1b[0m` : s),
	green: (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
	yellow: (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
};

// Author sets this at the top of the stages section.
let TOTAL_STAGES = 0;

let stageIndex = 0;
const ENV_FILE = process.env.ENV_FILE ?? ".env";
const writtenEnv: string[] = [];
const writtenSecret: string[] = [];
const skipped: string[] = [];

function clear(): void {
	if (!isTTY) return;
	process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

function rl(): readline.Interface {
	return readline.createInterface({ input: process.stdin, output: process.stdout });
}

async function readLine(prompt: string): Promise<string> {
	const it = rl();
	const answer = await new Promise<string>((resolve) => it.question(prompt, resolve));
	it.close();
	return answer.trim();
}

/** Hidden entry — echo off while reading. */
async function readSecret(prompt: string): Promise<string> {
	process.stdout.write(prompt);
	const buf: string[] = [];
	process.stdin.setRawMode(true);
	process.stdin.resume();
	await new Promise<void>((resolve) => {
		process.stdin.on("data", (chunk: Buffer) => {
			for (const ch of chunk.toString("utf8")) {
				if (ch === "\r" || ch === "\n") {
					process.stdin.setRawMode(false);
					process.stdin.pause();
					process.stdin.removeAllListeners("data");
					resolve();
					return;
				}
				if (ch === "") process.exit(130);
				if (ch === "" || ch === "\b") buf.pop();
				else if (ch >= " ") buf.push(ch);
			}
		});
	});
	process.stdout.write("\n");
	return buf.join("");
}

/** banner "Title" — opening frame: what this wizard does. */
async function banner(title: string): Promise<void> {
	clear();
	process.stdout.write(`\n${C.bold(C.blue(`  ${title}`))}\n`);
	process.stdout.write(`${C.dim(`  ${TOTAL_STAGES} stages`)}\n\n`);
	process.stdout.write(
		`${C.dim("  You drive the browser; this wizard tells you exactly what to do and\n  captures the values you copy back. Stop any time with Ctrl-C and re-run\n  later — it remembers values already saved.")}\n`,
	);
	await pause("Ready to start?");
}

/** stage "Name" — clear the screen, then announce a stage and show progress. */
function stage(name: string): void {
	clear();
	stageIndex += 1;
	process.stdout.write(`\n${C.bold(C.blue(`▸ Stage ${stageIndex}/${TOTAL_STAGES} · ${name}`))}\n`);
}

/** say "..." — a plain instruction line. */
function say(text: string): void {
	process.stdout.write(`  ${text}\n`);
}
/** step "..." — a numbered-feeling action the human takes in the browser. */
function step(text: string): void {
	process.stdout.write(`  ${C.blue("•")} ${text}\n`);
}
function note(text: string): void {
	process.stdout.write(`  ${C.dim(text)}\n`);
}
function warn(text: string): void {
	process.stdout.write(`  ${C.yellow(`⚠ ${text}`)}\n`);
}

/** openUrl — open in the human's browser, cross-platform incl. WSL. */
function openUrl(url: string): void {
	process.stdout.write(`  ${C.green("↗ opening")} ${url}\n`);
	const tryCmds: Array<[string, string[]]> = process.platform === "win32"
		? [["cmd", ["/c", "start", "", url]]]
		: [["open", [url]], ["xdg-open", [url]], ["wslview", [url]], ["explorer.exe", [url]]];
	for (const [cmd, args] of tryCmds) {
		const r = spawnSync(cmd, args, { stdio: "ignore" });
		if (!r.error) return;
	}
	warn(`couldn't open a browser — visit it manually: ${url}`);
}

/** pause "msg" — wait for the human to confirm they've done the manual part. */
async function pause(msg = "Press Enter to continue"): Promise<void> {
	await readLine(`  ${C.dim(msg)} `);
}

/** confirm "question" — y/N gate; true on yes. */
async function confirm(question: string): Promise<boolean> {
	const reply = await readLine(`  ${C.yellow("?")} ${question} [y/N] `);
	return /^[Yy]/.test(reply);
}

/** existing value of KEY in ENV_FILE, if any. */
function existing(key: string): string | undefined {
	if (!existsSync(ENV_FILE)) return undefined;
	const line = readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => l.startsWith(`${key}=`)).pop();
	return line?.slice(key.length + 1);
}

/** ask KEY "Prompt" — read a value into a returned string. Enter keeps current. */
async function ask(key: string, prompt: string): Promise<string> {
	const current = existing(key);
	const suffix = current ? ` ${C.dim("[Enter keeps current]")}` : "";
	const input = await readLine(`  ${C.bold(prompt)}${suffix} `);
	return input === "" && current !== undefined ? current : input;
}

/** askSecret KEY "Prompt" — like ask, but input is hidden. */
async function askSecret(key: string, prompt: string): Promise<string> {
	const current = existing(key);
	const suffix = current ? ` ${C.dim("[Enter keeps current]")}` : "";
	const input = await readSecret(`  ${C.bold(prompt)}${suffix} `);
	return input === "" && current !== undefined ? current : input;
}

/** writeEnv KEY VALUE — idempotent upsert into ENV_FILE. */
function writeEnv(key: string, value: string): void {
	const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
	const kept = lines.filter((l) => l !== "" && !l.startsWith(`${key}=`));
	kept.push(`${key}=${value}`);
	writeFileSync(`${ENV_FILE}.tmp`, `${kept.join("\n")}\n`);
	renameSync(`${ENV_FILE}.tmp`, ENV_FILE);
	writtenEnv.push(key);
	process.stdout.write(`  ${C.green("✓ wrote")} ${key} → ${ENV_FILE}\n`);
}

function ghReady(): boolean {
	return !spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).error;
}

/** setSecret NAME VALUE — GitHub Actions repo secret via gh; warn-skip on failure. */
function setSecret(name: string, value: string): void {
	if (ghReady() && !spawnSync("gh", ["secret", "set", name], { input: value, stdio: "ignore" }).error) {
		writtenSecret.push(name);
		process.stdout.write(`  ${C.green("✓ set")} GitHub secret ${name}\n`);
		return;
	}
	skipped.push(`GitHub secret ${name} (set it manually: gh secret set ${name})`);
	warn(`skipped GitHub secret ${name} — gh not ready; set it later`);
}

/** setVar NAME VALUE — GitHub Actions repo variable (non-secret). */
function setVar(name: string, value: string): void {
	if (ghReady() && !spawnSync("gh", ["variable", "set", name, "--body", value], { stdio: "ignore" }).error) {
		process.stdout.write(`  ${C.green("✓ set")} GitHub variable ${name}\n`);
		return;
	}
	skipped.push(`GitHub variable ${name}`);
	warn(`skipped GitHub variable ${name} — gh not ready; set it later`);
}

/** finish — clear, then a closing summary of everything configured. */
function finish(): void {
	clear();
	process.stdout.write(`\n${C.bold(C.green("  ✓ Setup complete"))}\n`);
	if (writtenEnv.length) note(`wrote ${writtenEnv.length} value(s) to ${ENV_FILE}: ${writtenEnv.join(" ")}`);
	if (writtenSecret.length) note(`set ${writtenSecret.length} GitHub secret(s): ${writtenSecret.join(" ")}`);
	if (skipped.length) {
		process.stdout.write("\n");
		warn("still to do by hand:");
		for (const s of skipped) note(`  - ${s}`);
	}
	process.stdout.write("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// STAGES — author this section. One stage() per step the human takes.
// Replace the example below. Set TOTAL_STAGES to match the stages you write.
// ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES = 1;

await banner("Stripe setup");

// ── Example stage: replace with your real steps ───────────────────────────
stage("Stripe — API keys");
say("We'll grab your Stripe test keys and store them for local dev + CI.");
openUrl("https://dashboard.stripe.com/test/apikeys");
step("On the API keys page, copy the Publishable key (starts pk_test_).");
const STRIPE_PUBLISHABLE_KEY = await ask("STRIPE_PUBLISHABLE_KEY", "Paste the publishable key:");
step("Click 'Reveal test key' on the Secret key row, then copy it.");
const STRIPE_SECRET_KEY = await askSecret("STRIPE_SECRET_KEY", "Paste the secret key:");
writeEnv("STRIPE_PUBLISHABLE_KEY", STRIPE_PUBLISHABLE_KEY);
writeEnv("STRIPE_SECRET_KEY", STRIPE_SECRET_KEY);
setSecret("STRIPE_SECRET_KEY", STRIPE_SECRET_KEY); // CI needs this one
// ──────────────────────────────────────────────────────────────────────────

finish();
```

- [ ] **Step 2: Verify the template parses and a one-stage copy runs non-interactively**

Run:
```bash
bun build --target=bun bun-apps/s2-agent-ext-wayfind/skills/wizard/template.ts --outfile /tmp/wizard-probe.js
printf '\n\n\n\n' | ENV_FILE=/tmp/wizard-env.probe bun bun-apps/s2-agent-ext-wayfind/skills/wizard/template.ts
cat /tmp/wizard-env.probe
```
Expected: build exits 0; the run writes both keys (empty strings) to `/tmp/wizard-env.probe` and prints the ⚠ gh-skip lines (gh unauthenticated or absent). Delete the probe files afterwards.

- [ ] **Step 3: Rewrite SKILL.md**

Rewrite `skills/wizard/SKILL.md` — same structure and stage-scoping process as today, with every bash mention replaced:
- frontmatter description → `Use when a manual procedure needs a human in the loop — provisioning infra, credentials, CI secrets, or an unfamiliar third-party dashboard. Generates a Bun wizard script that walks them through each step; skip steps the agent can do itself.`
- §body first line → "A **wizard** is a Bun script (`bun <file>` to run) that walks a human, step by step, …"; link `[template.ts](template.ts)`.
- §3 Author: copy `template.ts`; helpers are now async (`await ask(...)`, `await askSecret(...)`, `await pause(...)`, `await confirm(...)`) and values land in `const KEY = await ask("KEY", "…")` rather than dynamic shell vars; `writeEnv("KEY", VALUE)` / `setSecret("NAME", VALUE)` take string args; `openUrl(url)`. `TOTAL_STAGES = <n>` assignment. STAGES-marker invariant sentence unchanged.
- §4 Verify: replace `bash -n` / `shellcheck` / `chmod +x` with `bun build --target=bun <file> --outfile /tmp/wizard-check.js` (must exit 0); static trace bullet unchanged; hand-off says "run `bun <file>`".
- Keep the ephemeral-by-default paragraph as-is.

- [ ] **Step 4: Sweep sibling references + delete the old template**

```bash
grep -rn "template.sh\|bash -n\|shellcheck" bun-apps/s2-agent-ext-wayfind/skills/
git rm bun-apps/s2-agent-ext-wayfind/skills/wizard/template.sh
```
Fix `ask-matt/SKILL.md:105` ("interactive bash script" → "interactive Bun wizard script"). Expected: grep clean after fixes.

- [ ] **Step 5: Gate + commit**

Run: `( cd bun-apps/s2-agent-ext-wayfind && bun run check && bun run test:unit && bun run test:probe )`
Expected: PASS (SKILL.md/template changes don't touch src; probe unchanged).

```bash
git add bun-apps/s2-agent-ext-wayfind/skills
git commit -m "feat(wayfind): wizard skill generates Bun wizards — template.ts replaces template.sh"
```

- [ ] **Step 6: Close ticket 02 + review**

Flip `tickets/02-wizard-bun-template.md` to closed with `## Result` (record the Step-2 probe receipts: hidden-entry? env upsert idempotent? confirm gate? — probe what Step 2 exercised; for hidden-entry, verify `readSecret` by running once with a typed value and confirming nothing echoes). Dispatch the code reviewer.

---

## Task 5 (ticket 03): /loop command parser + scheduler modules

**Files:**
- Create: `bun-apps/s2-agent-ext-task/src/loop/loop-commands.ts` (REWRITE)
- Create: `bun-apps/s2-agent-ext-task/src/loop/loop-scheduler.ts` (new)
- Create: `bun-apps/s2-agent-ext-task/src/loop/loop-persistence.ts` (REWRITE)
- Create: `bun-apps/s2-agent-ext-task/src/loop/loop-state.ts` (REWRITE — shrunk)
- Delete: `bun-apps/s2-agent-ext-task/src/loop/loop-metric.ts`
- Test: rewrite `src/loop/__tests__/{loop-commands,loop-persistence}.test.ts`, add `loop-scheduler.test.ts`; delete `loop-metric.test.ts`, `loop-state.test.ts` (superseded), rewrite `integration.test.ts` in Task 6.

**Interfaces:**
- Produces (consumed by Task 6's `loop.ts` rewrite + `overlay.ts` rewrite):
  - `parseLoopCommand(args: string): LoopCommandResult | string` where

```typescript
export interface ActiveLoop {
	id: string;
	prompt: string;
	intervalMs: number;
	startedAt: number;
	nextFireAt: number;
	iteration: number;
}
export type LoopCommandResult =
	| { kind: "show" }
	| { kind: "stop" }
	| { kind: "start"; intervalMs: number; prompt: string };
```

  - `parseInterval(token: string): number | undefined` — `s|m|h|d`, seconds round UP to a whole minute (CC), min 60s, no upper cap.
  - `class LoopScheduler { constructor(opts: { fire: (prompt: string) => Promise<void> | void; isIdle: () => boolean }); start(loop: ActiveLoop): void; stop(): void; active(): ActiveLoop | undefined; }` — timer chain, idle-gated, postpone-on-busy, 7-day max-age from `startedAt` (fires one last time, then self-stops), injectable clock/timer for tests via optional `{ setTimer, clearTimer, now }` overrides.
  - `persistLoop(api, loop | undefined)` / `loadLoopFromSession(sm): ActiveLoop | undefined` mirroring today's entry-type pattern.

- [ ] **Step 1: Write failing parser tests**

Rewrite `src/loop/__tests__/loop-commands.test.ts`:

```typescript
/** /loop CC-syntax parsing — [interval] <prompt…>, default 10m, s rounds up. */
import { test, expect, describe } from "bun:test";
import { parseLoopCommand, parseInterval } from "../loop-commands.js";

describe("parseInterval", () => {
	test("units s/m/h/d", () => {
		expect(parseInterval("90s")).toBe(90_000);
		expect(parseInterval("5m")).toBe(300_000);
		expect(parseInterval("1h")).toBe(3_600_000);
		expect(parseInterval("1d")).toBe(86_400_000);
	});
	test("seconds round UP to a whole minute (CC)", () => {
		expect(parseInterval("1s")).toBe(60_000);
		expect(parseInterval("45s")).toBe(60_000);
		expect(parseInterval("61s")).toBe(120_000);
	});
	test("junk rejected", () => {
		expect(parseInterval("5x")).toBeUndefined();
		expect(parseInterval("m5")).toBeUndefined();
		expect(parseInterval("")).toBeUndefined();
	});
});

describe("parseLoopCommand", () => {
	test("interval + prompt", () => {
		const r = parseLoopCommand("5m check the deploy");
		expect(r).toEqual({ kind: "start", intervalMs: 300_000, prompt: "check the deploy" });
	});
	test("prompt only defaults to 10m", () => {
		const r = parseLoopCommand("babysit the PR queue");
		expect(r).toEqual({ kind: "start", intervalMs: 600_000, prompt: "babysit the PR queue" });
	});
	test("d-unit prompt target", () => {
		const r = parseLoopCommand("1d /daily-summary");
		expect(r).toEqual({ kind: "start", intervalMs: 86_400_000, prompt: "/daily-summary" });
	});
	test("stop / status / empty", () => {
		expect(parseLoopCommand("stop")).toEqual({ kind: "stop" });
		expect(parseLoopCommand("status")).toEqual({ kind: "show" });
		expect(parseLoopCommand("")).toEqual({ kind: "show" });
		expect(parseLoopCommand("stop extra")).toBeInstanceOf(String);
	});
	test("old process-loop syntax gets a usage pointer", () => {
		const r = parseLoopCommand('start "improve x" measure="echo 1"');
		expect(typeof r).toBe("string");
		expect(r).toContain("/loop <interval> <prompt>");
	});
	test("interval token without prompt is a usage error", () => {
		const r = parseLoopCommand("5m");
		expect(typeof r).toBe("string");
	});
});
```

- [ ] **Step 2: Verify failure**

Run: `( cd bun-apps/s2-agent-ext-task && bun test src/loop/__tests__/loop-commands.test.ts )`
Expected: FAIL — old parser expects `start`/`stop`/`status` subcommands and `parseInterval` doesn't exist.

- [ ] **Step 3: Implement loop-commands.ts**

```typescript
/** /loop command parsing — CC syntax: [interval] <prompt…>. */
export interface ActiveLoop {
	id: string;
	prompt: string;
	intervalMs: number;
	startedAt: number;
	nextFireAt: number;
	iteration: number;
}

export type LoopCommandResult =
	| { kind: "show" }
	| { kind: "stop" }
	| { kind: "start"; intervalMs: number; prompt: string };

export const DEFAULT_LOOP_INTERVAL_MS = 600_000; // CC default: 10m

export interface LoopArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

export const LOOP_ARGUMENT_COMPLETIONS: readonly LoopArgumentCompletion[] = [
	{ value: "5m ", label: "5m", description: "Run every 5 minutes" },
	{ value: "30m ", label: "30m", description: "Run every 30 minutes" },
	{ value: "1h ", label: "1h", description: "Run every hour" },
	{ value: "stop", label: "stop", description: "Stop the active loop" },
	{ value: "status", label: "status", description: "Show the active loop" },
];

export function completeLoopArguments(prefix: string): LoopArgumentCompletion[] | null {
	const p = prefix.trimStart();
	if (/\s/.test(p)) return null;
	const m = LOOP_ARGUMENT_COMPLETIONS.filter((c) => c.value.startsWith(p) || c.label.startsWith(p));
	return m.length ? [...m] : null;
}

/** Parse "90s" / "5m" / "1h" / "1d" -> ms; seconds round UP to a whole minute (CC). */
export function parseInterval(token: string): number | undefined {
	const m = /^(\d+)(s|m|h|d)$/i.exec(token.trim());
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = m[2].toLowerCase();
	const mult = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
	const ms = n * mult;
	return unit === "s" ? Math.max(60_000, Math.ceil(ms / 60_000) * 60_000) : ms;
}

const USAGE = 'Usage: /loop <interval> <prompt…> (e.g. /loop 5m check the deploy) — see /loop status';

export function parseLoopCommand(args: string): LoopCommandResult | string {
	const trimmed = args.trim();
	if (trimmed === "") return { kind: "show" };
	const first = trimmed.split(/\s+/)[0];
	if (first === "stop") {
		const rest = trimmed.slice(first.length).trim();
		return rest.length === 0 ? { kind: "stop" } : "Usage: /loop stop";
	}
	if (first === "status" || first === "show") {
		const rest = trimmed.slice(first.length).trim();
		return rest.length === 0 ? { kind: "show" } : "Usage: /loop status";
	}
	// Old process-loop syntax: point at the new surface instead of silently mislooping.
	if (first === "start" || /^measure=/.test(first)) {
		return `The process-improvement loop was replaced by a recurring-prompt loop. ${USAGE}`;
	}
	const intervalMs = parseInterval(first);
	if (intervalMs !== undefined) {
		const prompt = trimmed.slice(first.length).trim();
		return prompt.length > 0 ? { kind: "start", intervalMs, prompt } : USAGE;
	}
	return { kind: "start", intervalMs: DEFAULT_LOOP_INTERVAL_MS, prompt: trimmed };
}
```

- [ ] **Step 4: Verify parser tests pass**

Run: `( cd bun-apps/s2-agent-ext-task && bun test src/loop/__tests__/loop-commands.test.ts )` — Expected: PASS.

- [ ] **Step 5: Write failing scheduler + persistence tests**

Create `src/loop/__tests__/loop-scheduler.test.ts`:

```typescript
/** LoopScheduler — timer chain, idle-gated, postpone-on-busy, 7-day max-age. */
import { test, expect, describe } from "bun:test";
import { LoopScheduler, SEVEN_DAYS_MS } from "../loop-scheduler.js";
import type { ActiveLoop } from "../loop-commands.js";

function makeLoop(intervalMs = 1000): ActiveLoop {
	return { id: "L1", prompt: "p", intervalMs, startedAt: 0, nextFireAt: intervalMs, iteration: 0 };
}

function harness() {
	let now = 0;
	const fired: string[] = [];
	let idle = true;
	const timers: Array<{ at: number; fn: () => void }> = [];
	const s = new LoopScheduler({
		fire: (prompt) => {
			fired.push(prompt);
		},
		isIdle: () => idle,
		now: () => now,
		setTimer: (ms, fn) => {
			timers.push({ at: now + ms, fn });
			return timers.length - 1;
		},
		clearTimer: (h) => {
			timers[h as number] = undefined as never;
		},
	});
	const tick = () => {
		now += 1;
		const due = timers.filter((t) => t && t.at <= now);
		for (const t of due) (timers[timers.indexOf(t)] = undefined as never), t.fn();
	};
	return { s, fired, tick, setIdle: (v: boolean) => (idle = v), get now() { return now; } };
}

describe("LoopScheduler", () => {
	test("fires the prompt while idle and re-arms", () => {
		const h = harness();
		h.s.start(makeLoop(10));
		h.tick(); // t=10: timer due
		expect(h.fired).toEqual(["p"]);
		h.tick(); // t=20: re-armed timer due
		expect(h.fired).toEqual(["p", "p"]);
	});

	test("busy tick postpones, never drops", () => {
		const h = harness();
		h.s.start(makeLoop(10));
		h.setIdle(false);
		h.tick(); // due but busy
		expect(h.fired).toEqual([]);
		h.setIdle(true);
		h.tick(); // next opportunity fires
		expect(h.fired).toEqual(["p"]);
	});

	test("stop() cancels pending fires", () => {
		const h = harness();
		h.s.start(makeLoop(10));
		h.s.stop();
		h.tick();
		h.tick();
		expect(h.fired).toEqual([]);
		expect(h.s.active()).toBeUndefined();
	});

	test("7-day max-age: fires one last time then self-stops", () => {
		const h = harness();
		h.s.start(makeLoop(SEVEN_DAYS_MS)); // next fire == max age boundary
		h.tick();
		expect(h.fired.length).toBe(1);
		expect(h.s.active()).toBeUndefined();
	});

	test("iteration counts fires", () => {
		const h = harness();
		h.s.start(makeLoop(5));
		h.tick();
		h.tick();
		expect(h.s.active()?.iteration).toBe(2);
	});
});
```

And rewrite `src/loop/__tests__/loop-persistence.test.ts`:

```typescript
/** Loop persistence — session-store round-trip of ActiveLoop. */
import { test, expect, describe } from "bun:test";
import { persistLoop, clearPersistedLoop, loadLoopFromSession, LOOP_STATE_ENTRY_TYPE } from "../loop-persistence.js";
import type { ActiveLoop } from "../loop-commands.js";

const loop: ActiveLoop = { id: "L1", prompt: "p", intervalMs: 300_000, startedAt: 1, nextFireAt: 2, iteration: 3 };

function fakeSession(entries: unknown[] = []) {
	return {
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		getBranch: () => entries,
	};
}

describe("loop persistence", () => {
	test("round-trip", () => {
		const sm = fakeSession();
		persistLoop(sm as never, loop);
		expect(loadLoopFromSession(sm)).toEqual(loop);
	});
	test("clear writes a null tombstone that loads as undefined", () => {
		const sm = fakeSession();
		persistLoop(sm as never, loop);
		clearPersistedLoop(sm as never);
		expect(loadLoopFromSession(sm)).toBeUndefined();
	});
	test("non-loop entries are ignored", () => {
		const sm = fakeSession([{ customType: "other", data: { loop: "x" } }]);
		expect(loadLoopFromSession(sm)).toBeUndefined();
	});
	test("entry type name unchanged from the old loop", () => {
		expect(LOOP_STATE_ENTRY_TYPE).toBe("loop-state");
	});
});
```

- [ ] **Step 6: Verify failure, then implement**

Run both test files — expected FAIL (modules missing). Then create:

`src/loop/loop-scheduler.ts`:

```typescript
/** LoopScheduler — CC-style recurring prompt: timer chain, idle-gated. */
import type { ActiveLoop } from "./loop-commands.js";

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // CC recurring auto-expiry

export interface SchedulerHooks {
	fire: (prompt: string) => Promise<void> | void;
	isIdle: () => boolean;
}

export interface SchedulerClock {
	now?: () => number;
	setTimer?: (ms: number, fn: () => void) => unknown;
	clearTimer?: (handle: unknown) => void;
}

export class LoopScheduler {
	private loop: ActiveLoop | undefined;
	private handle: unknown;
	private readonly hooks: SchedulerHooks;
	private readonly now: () => number;
	private readonly setTimer: (ms: number, fn: () => void) => unknown;
	private readonly clearTimer: (handle: unknown) => void;

	constructor(hooks: SchedulerHooks, clock: SchedulerClock = {}) {
		this.hooks = hooks;
		this.now = clock.now ?? Date.now;
		this.setTimer = clock.setTimer ?? ((ms, fn) => setTimeout(fn, ms));
		this.clearTimer = clock.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	active(): ActiveLoop | undefined {
		return this.loop;
	}

	start(loop: ActiveLoop): void {
		this.stop();
		this.loop = { ...loop, nextFireAt: this.now() + loop.intervalMs };
		this.arm(loop.intervalMs);
	}

	stop(): void {
		if (this.handle !== undefined) this.clearTimer(this.handle);
		this.handle = undefined;
		this.loop = undefined;
	}

	private arm(ms: number): void {
		this.handle = this.setTimer(ms, () => void this.tick());
	}

	/** One timer fire: fire if idle (else postpone a minute), stop past max age. */
	private async tick(): Promise<void> {
		const loop = this.loop;
		if (!loop) return;
		const now = this.now();
		if (now - loop.startedAt >= SEVEN_DAYS_MS) {
			// CC recurring auto-expiry: this fire is the last one.
			await this.hooks.fire(loop.prompt);
			this.stop();
			return;
		}
		if (!this.hooks.isIdle()) {
			// Postpone-on-busy: re-check every minute; never drop a due fire.
			this.arm(60_000);
			return;
		}
		this.loop = { ...loop, iteration: loop.iteration + 1, nextFireAt: now + loop.intervalMs };
		await this.hooks.fire(loop.prompt);
		if (this.loop) this.arm(this.loop.intervalMs);
	}
}
```

`src/loop/loop-persistence.ts` (rewrite — entry type unchanged so old sessions' loop-state entries simply fail `isActiveLoop` and load as undefined):

```typescript
/** Loop persistence — session-store only. */
import type { ActiveLoop } from "./loop-commands.js";

export const LOOP_STATE_ENTRY_TYPE = "loop-state";

export interface LoopPersistenceApi {
	appendEntry: (customType: string, data: unknown) => void;
}

function isActiveLoop(v: unknown): v is ActiveLoop {
	const l = v as ActiveLoop | undefined;
	return (
		!!l &&
		typeof l.id === "string" &&
		typeof l.prompt === "string" &&
		typeof l.intervalMs === "number" &&
		typeof l.startedAt === "number" &&
		typeof l.nextFireAt === "number" &&
		typeof l.iteration === "number"
	);
}

export function persistLoop(api: LoopPersistenceApi | undefined, loop: ActiveLoop | undefined): void {
	api?.appendEntry(LOOP_STATE_ENTRY_TYPE, { loop: loop ? { ...loop } : null });
}

export function clearPersistedLoop(api: LoopPersistenceApi | undefined): void {
	persistLoop(api, undefined);
}

export function loadLoopFromSession(sessionManager: unknown): ActiveLoop | undefined {
	const sm = sessionManager as
		| { getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>; getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }> }
		| undefined;
	const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
	const entry = entries.filter((e) => e.type === "custom" && e.customType === LOOP_STATE_ENTRY_TYPE).pop();
	const data = entry?.data as { loop?: unknown } | undefined;
	return isActiveLoop(data?.loop) ? { ...(data!.loop as ActiveLoop) } : undefined;
}
```

Delete `loop-metric.ts`, `loop-state.ts` and their test files (their coverage is superseded; the old `loop.ts` still imports them until Task 6 — so in THIS task, delete only `loop-metric.ts` + `loop-state.ts` **tests**, and do the source deletions in Task 6 Step 4 together with the `loop.ts` rewrite. If typecheck breaks because `loop.ts` imports the deleted modules, keep the two source files until Task 6 and note it in the commit message.)

- [ ] **Step 7: Verify + commit**

Run: `( cd bun-apps/s2-agent-ext-task && bun test src/loop/__tests__/loop-commands.test.ts src/loop/__tests__/loop-scheduler.test.ts src/loop/__tests__/loop-persistence.test.ts )` — Expected: PASS. Full-package typecheck may defer to Task 6 (old `loop.ts` references) — if so, say so in the commit.

```bash
git add bun-apps/s2-agent-ext-task/src/loop
git commit -m "feat(task): CC-style /loop parser + idle-gated scheduler + persistence"
```

---

## Task 6 (ticket 03): /loop registration rewrite + goal decoupling

**Files:**
- Rewrite: `bun-apps/s2-agent-ext-task/src/loop/loop.ts`
- Rewrite: `bun-apps/s2-agent-ext-task/src/loop/overlay.ts`
- Delete: `bun-apps/s2-agent-ext-task/src/loop/loop-state.ts`, `src/loop/loop-metric.ts` (if still present)
- Modify: `bun-apps/s2-agent-ext-task/src/goal/hooks.ts:253-258`, `src/goal/lifecycle.ts:53-57`, `src/goal/status.ts:116,129-131`
- Modify: `bun-apps/s2-agent-ext-task/extensions/task.ts:32-34,98-105` (wiring)
- Test: rewrite `src/loop/__tests__/loop.test.ts` + `integration.test.ts`; update goal tests touching loop branches

**Interfaces:**
- Consumes: `LoopScheduler`, `ActiveLoop`, `parseLoopCommand`, `completeLoopArguments`, `persistLoop`/`loadLoopFromSession`/`clearPersistedLoop` (Task 5).
- Produces: `registerLoop(pi): void` (no overlay arg — overlay updates via return), `restoreLoopFromSession(sessionManager, overlay): void`.

- [ ] **Step 1: Write failing registration tests**

Rewrite `src/loop/__tests__/loop.test.ts`:

```typescript
/** registerLoop — command surface + scheduler wiring + persistence calls. */
import { test, expect, describe } from "bun:test";

describe("registerLoop", () => {
	test.todo("wired in integration.test.ts — /loop handler paths covered there");
});
```

Rewrite `src/loop/__tests__/integration.test.ts` around a fake `ExtensionAPI` (follow the existing file's fake-pi harness — reuse its `makeFakePi()` pattern if present; otherwise build one that records `registerCommand` handlers, `sendUserMessage` calls, and exposes `events.on/emit`):

```typescript
/** /loop integration — start fires via scheduler, stop clears, restore round-trips. */
import { test, expect, describe } from "bun:test";
// Build/adopt the fake-pi harness per the file's current harness, then:

describe("/loop integration", () => {
	test("/loop 5m <prompt> registers a scheduler that fires when idle", async () => {
		// fake pi + LoopScheduler with injected clock advanced past 5m; assert
		// sendUserMessage received the prompt exactly once and only while isIdle()=true.
	});
	test("/loop stop clears persistence and the overlay", async () => {
		// start, then stop; assert appendEntry tombstone + overlay.update(undefined).
	});
	test("restoreLoopFromSession re-arms a persisted loop", async () => {
		// sessionManager with a loop-state entry → overlay.update(loop) + scheduler.active().
	});
	test("old syntax yields the usage pointer, no scheduler", async () => {
		// handler('start "x" measure="echo 1"') → notify contains "/loop <interval> <prompt>".
	});
});
```

(Fill each body against the fake-pi harness you adopted — assertions are specified in the comments; keep them exactly.)

- [ ] **Step 2: Verify failure** — `( cd bun-apps/s2-agent-ext-task && bun test src/loop )` — Expected: FAIL.

- [ ] **Step 3: Rewrite loop.ts**

```typescript
/** /loop — CC-style recurring prompt execution (replaces the process loop). */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseLoopCommand, completeLoopArguments, type ActiveLoop } from "./loop-commands.js";
import { LoopScheduler } from "./loop-scheduler.js";
import { persistLoop, clearPersistedLoop, loadLoopFromSession } from "./loop-persistence.js";
import type { LoopOverlayLike } from "./overlay.js";

export function isLoopActive(): boolean {
	return schedulerRef?.active() !== undefined;
}

let schedulerRef: LoopScheduler | undefined;
let extensionApiRef: ExtensionAPI | undefined;

function newScheduler(pi: ExtensionAPI, ctx: { isIdle?: () => boolean; ui: { notify?: (m: string, k?: string) => void } }): LoopScheduler {
	return new LoopScheduler({
		fire: (prompt) => pi.sendUserMessage(prompt),
		isIdle: () => ctx.isIdle?.() ?? true,
	});
}

export function registerLoop(pi: ExtensionAPI, overlay: LoopOverlayLike): void {
	extensionApiRef = pi;
	pi.registerCommand("loop", {
		description: "Run a prompt on a recurring interval: /loop [interval] <prompt…> (default 10m) | stop | status",
		getArgumentCompletions: completeLoopArguments,
		handler: async (args: string, ctx: { isIdle?: () => boolean; sessionManager?: unknown; ui: { notify?: (m: string, k?: string) => void } }) => {
			const parsed = parseLoopCommand(args ?? "");
			if (typeof parsed === "string") {
				ctx.ui.notify?.(parsed, "warning");
				return;
			}
			if (parsed.kind === "show") {
				const loop = schedulerRef?.active();
				ctx.ui.notify?.(loop ? loopStatus(loop) : "No active loop.", "info");
				return;
			}
			if (parsed.kind === "stop") {
				if (!schedulerRef?.active()) {
					ctx.ui.notify?.("No active loop.", "info");
					return;
				}
				schedulerRef.stop();
				overlay.update(undefined);
				clearPersistedLoop(extensionApiRef);
				ctx.ui.notify?.("Loop stopped.", "info");
				return;
			}
			if (schedulerRef?.active()) {
				ctx.ui.notify?.("A loop is already active. Run /loop stop first.", "warning");
				return;
			}
			const loop: ActiveLoop = {
				id: crypto.randomUUID(),
				prompt: parsed.prompt,
				intervalMs: parsed.intervalMs,
				startedAt: Date.now(),
				nextFireAt: Date.now() + parsed.intervalMs,
				iteration: 0,
			};
			schedulerRef = newScheduler(pi, ctx);
			schedulerRef.start(loop);
			persistLoop(extensionApiRef, loop);
			overlay.update(loop);
			ctx.ui.notify?.(loopStatus(loop), "info");
		},
	});
}

function loopStatus(loop: ActiveLoop): string {
	const nextIn = Math.max(0, Math.round((loop.nextFireAt - Date.now()) / 1000));
	return `⟳ /loop every ${Math.round(loop.intervalMs / 60000)}m · fired ${loop.iteration}× · next in ${nextIn}s · "${loop.prompt}"`;
}

/** Called from extensions/task.ts session_start to recover an active loop. */
export function restoreLoopFromSession(sessionManager: unknown, overlay: LoopOverlayLike): void {
	const loop = loadLoopFromSession(sessionManager);
	if (!loop || !extensionApiRef) return;
	schedulerRef = newScheduler(extensionApiRef, { isIdle: () => true, ui: {} });
	schedulerRef.start(loop);
	overlay.update(loop);
}
```

Rewrite `overlay.ts` to render `ActiveLoop` (interval minutes, prompt, iteration, next-fire) — keep the existing class name/export shape (`LoopOverlay`, `update(loop | undefined)`) so `task.ts`'s wiring keeps compiling.

`extensions/task.ts`: remove `setLoopRenderSid` / `__resetLoopState` imports (loop-state deleted); keep `registerLoop`, `restoreLoopFromSession`, `LoopOverlay` imports; remove the goal⇄loop mutual-exclusion globalThis seam comments/reads that referenced the old loop (goal's side is removed in Step 4).

- [ ] **Step 4: Remove goal coupling**

- `goal/hooks.ts:253-258` — delete the block:

```typescript
// Loop 3 dispatch: a live loop drives the continuation, not a goal.
if (isLoopActive()) {
	await runLoopTick(pi, ctx as StatusContext, event);
	return;
}
```

and drop `isLoopActive`/`runLoopTick` from that file's loop imports (the import disappears entirely if nothing else in hooks.ts uses it).

- `goal/lifecycle.ts:53-57` — delete:

```typescript
if (isLoopActive()) {
	ctx.ui.notify("A loop is active. Run /loop stop before starting a goal.", "warning");
	return;
}
```

(CC runs /goal and /loop concurrently; the old XOR gate dies with the process loop.)

- `goal/status.ts:116` — `const shouldRun = goalState.activeGoal?.status === "active";` (drop `|| isLoopActive()`).
- `goal/status.ts:129-131` — delete the `if (isLoopActive()) { void refireLoopContinuation(...); } else` branch, leaving only the goal body.
- Grep after: `grep -rn "runLoopTick\|refireLoopContinuation\|isLoopActive" src/goal src/loop extensions` — remaining `isLoopActive` may live only in `src/loop/loop.ts`.

Delete `src/loop/loop-state.ts` + `src/loop/loop-metric.ts` (+ their test files) if Step 5 of Task 5 deferred them.

- [ ] **Step 5: Full gate + commit**

Run: `( cd bun-apps/s2-agent-ext-task && bun run typecheck && bun test )`
Expected: PASS — including goal tests; fix any that asserted the XOR gate (they now assert goal proceeds regardless).

```bash
git add bun-apps/s2-agent-ext-task
git commit -m "feat(task): /loop becomes CC-style recurring prompt execution; goal decoupled"
```

- [ ] **Step 6: Slash-command target probe (spec §5 risk / Fog of war)**

Probe whether `pi.sendUserMessage("/foo")` (or a commands registry API on `ExtensionAPI`) executes the registered `/foo` command. Record the finding in the ticket Result either way; if it works, `fire` may pass prompts starting with `/` straight through (it already does — sendUserMessage receives the string verbatim), and note that slash targets are thereby supported.

- [ ] **Step 7: Close ticket 03 + review**

Flip ticket status, append Result (include the Step-6 probe finding), commit, dispatch the reviewer.

---

## Task 7 (ticket 04): /goal surface parity

**Files:**
- Modify: `bun-apps/s2-agent-ext-task/src/goal/commands.ts:49-58,92-96,185-190`
- Test: `bun-apps/s2-agent-ext-task/src/goal/__tests__/` (find the existing commands test file with `ls src/goal/__tests__`; extend it — do not create a parallel file)

**Interfaces:**
- Consumes/extends: `parseGoalCommand`, `GOAL_ARGUMENT_COMPLETIONS` (existing names unchanged).
- Produces: no-arg → `{ kind: "show" }`; aliases `off|reset|none|cancel` → `{ kind: "clear" }`.

- [ ] **Step 1: Write failing tests**

In the existing goal commands test file, add:

```typescript
describe("CC surface parity", () => {
	test("no args shows status instead of usage", () => {
		expect(parseGoalCommand("")).toEqual({ kind: "show" });
	});
	test("CC clear aliases all clear", () => {
		for (const alias of ["clear", "stop", "off", "reset", "none", "cancel"]) {
			expect(parseGoalCommand(alias)).toEqual({ kind: "clear" }, `alias: ${alias}`);
		}
	});
	test("alias with trailing args is a usage error", () => {
		expect(typeof parseGoalCommand("cancel now")).toBe("string");
	});
	test("condition still capped at 4000", () => {
		const r = parseGoalCommand("x".repeat(4001));
		expect(typeof r).toBe("string");
	});
});
```

(Adapt the import/assert style to the file's existing harness — e.g. it may call the parser through the command handler; keep the assertions identical.)

- [ ] **Step 2: Verify failure** — the no-arg case currently returns a usage string; `off`/`reset`/`none`/`cancel` currently parse as goal OBJECTIVES (they fall through to `edit`/`start`).

- [ ] **Step 3: Implement**

In `commands.ts`:
1. Line ~94: `if (first === "clear" || first === "stop" || first === "off" || first === "reset" || first === "none" || first === "cancel") return rest.length === 0 ? { kind: "clear" } : "Usage: /goal clear";`
2. Line ~189 (`if (!trimmed) return "Usage: /goal <goal_to_complete>";`): replace with `if (!trimmed) return { kind: "show" };`
3. `GOAL_ARGUMENT_COMPLETIONS`: add `{ value: "clear", label: "clear", description: "Clear the current goal (stop|off|reset|none|cancel also work)" }` — replacing the existing `clear` row's description.
4. Verdict display naming: check `grep -n "approved\|disapproved" src/goal/status.ts src/goal/overlay.ts` — IF those strings are pure display (formatting only), map them to `Met` / `Not yet met` / `Impossible` in the display sites only; if they are protocol values crossing into prompts or persistence, SKIP the rename and record why in the ticket Result (auditor protocol is protected by D5).

- [ ] **Step 4: Gate + commit + close + review**

Run: `( cd bun-apps/s2-agent-ext-task && bun run typecheck && bun test )` — PASS.

```bash
git add bun-apps/s2-agent-ext-task/src/goal
git commit -m "feat(task): /goal CC surface parity — clear aliases, no-arg status"
```

Flip `tickets/04-goal-surface-parity.md` to closed + Result; commit; dispatch the reviewer.

---

## Final step: push, PR, CI, merge

1. `bun bun-apps/s2-agent-ext-devops/src/prepare-feature-branch-cli.ts --branch cc-parity-task-ext --rebase` (sync onto origin/main if main moved).
2. `git push -u origin cc-parity-task-ext` (force-with-lease via the CLI `--force-push` only after a rebase).
3. `GH_PAGER=cat gh pr create --title "feat(task): CC parity — ask_user_question, /loop, /goal, wizard Bun" --body-file <file>` (body lists the four tickets + parity ledger).
4. `bun bun-apps/s2-agent-ext-devops/src/local-ci-cli.ts` → then `merge-pr-after-ci-cli.ts` per the devops skill.
5. `bun bun-apps/s2-agent-ext-devops/src/version-bump-cli.ts --package s2-agent --patch`.
6. Update map.md `status: complete`, Frontier cleared, Decisions link results; final commit on main via the devops flow.

## Self-Review (done 2026-08-23, re-run if the plan changes)

1. **Spec coverage:** §4.1 → Tasks 1–3; §4.2 → Task 4; §4.3 → Tasks 5–6 (+ probe Step 6); §4.3 goal-decoupling → Task 6 Step 4; ticket 04 → Task 7; D6 7-day cap → scheduler test; risks (idle-gating) → postpone-on-busy test. No gaps.
2. **Placeholders:** Task 6 Step 1's integration test bodies are comment-specified rather than coded because the fake-pi harness is adopted from the existing file at implementation time — the assertions are fully specified; this is the plan's only such spot and it is deliberate.
3. **Type consistency:** `ActiveLoop` fields identical across loop-commands/scheduler/persistence/loop.ts; `LoopScheduler` constructor signature identical in Task 5 spec and Task 6 use; `RECOMMENDED_SUFFIX`/`hasRecommendedSuffix` defined Task 1, consumed Tasks 2–3.
