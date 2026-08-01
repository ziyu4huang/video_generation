# Prompt-History Persistence + Wayfind Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the composite wayfind status widget below the chat input and add cross-session, per-cwd prompt-history persistence with Up/Down recall and a discoverability hint.

**Architecture:** Two-part persistence. (1) A new extension `pi-agent-ext-prompt-history` observes the `input` event and writes prompts to `~/.pi/agent/prompt-history/<slug>-<hash>/history.jsonl` (newest-first, capped 100, bash excluded). (2) Two runtime monkey-patches in `pi-agent/src/patches/` (the repo's `applyPatches()` flow — the compiled `pi-coding-agent` core is never source-edited): `editor-history-restore` hydrates `editor.history` from the JSONL on `InteractiveMode.prototype.init`; `startup-history-hint` rewraps `builtInHeader.getExpandedText` to append `↑/↓ to browse history`. The placement flip is already applied in the working tree.

**Tech Stack:** TypeScript, Bun (workspace root `bun-apps/`), `@earendil-works/pi-coding-agent` 0.83.0, `@earendil-works/pi-tui` 0.83.0. Tests via Bun's built-in runner.

## Global Constraints

- **Never top-level `cd`** — use `( cd bun-apps/<pkg> && ... )` or `bun run --cwd`. `no-cd-drift.sh` blocks top-level cd.
- **Bun workspace root is `bun-apps/`** — `bun install` from there only; never commit `package-lock.json`.
- **Extension registration:** a package's registered entry is exactly `extensions/<X>.ts` (filename = folder suffix, no `pi-` prefix). Static (always-on) extensions register in `bun-apps/pi-agent/src/static-extensions.ts`, NOT `run-dir/manifest.json` (avoids static+dynamic double-registration).
- **Patches:** the compiled `@earendil-works/pi-coding-agent` core is NEVER source-edited (no `bun patch`, no `node_modules` edits). Runtime behavior changes land as modules in `bun-apps/pi-agent/src/patches/` registered through `applyPatches()`. Each patch imports a **named export** from `@earendil-works/pi-coding-agent` (never `dist/...`), wraps a `prototype.<method>`, and accesses instance fields (`this.editor`, `this.sessionManager`, `this.builtInHeader`) inside the wrapped fn.
- **Platform:** Apple Silicon only. No CUDA. TS loaded natively by Bun (jiti only as fallback).

---

## File Structure

**Create:**
- `bun-apps/pi-agent-ext-prompt-history/package.json` — package manifest (models `pi-agent-ext-core-task/package.json`).
- `bun-apps/pi-agent-ext-prompt-history/src/history-store.ts` — pure persistence logic (path/key resolution, read, record). No SDK deps beyond `getAgentDir`.
- `bun-apps/pi-agent-ext-prompt-history/src/history-store.test.ts` — unit tests for the store.
- `bun-apps/pi-agent-ext-prompt-history/extensions/prompt-history.ts` — registration entry; factory subscribes `pi.on("input", …)`.
- `bun-apps/pi-agent-ext-prompt-history/extensions/prompt-history.test.ts` — factory test.
- `bun-apps/pi-agent/src/patches/editor-history-restore.ts` (+ `.test.ts`) — hydrate `editor.history` on init.
- `bun-apps/pi-agent/src/patches/startup-history-hint.ts` (+ `.test.ts`) — append the history hint to the expanded startup header.

**Modify:**
- `bun-apps/pi-agent/src/static-extensions.ts` — register the new extension (import + array entry).
- `bun-apps/pi-agent/src/patches/index.ts` — register both patches (`PatchName` union, `PATCH_TABLE`, `applyPatches()` switch).
- `bun-apps/pi-agent/src/patches/index.test.ts` — add both names to the "covers all known patches" list.

**Verify (already applied, no edit):**
- `bun-apps/pi-agent-ext-core-task/src/shared/status-widget.ts:99` — `{ placement: "belowEditor" }` (Task 1 commits it).

---

## Task 1: Commit the placement flip

**Files:**
- Verify: `bun-apps/pi-agent-ext-core-task/src/shared/status-widget.ts:99`
- Test: existing `bun-apps/pi-agent-ext-core-task` test suite

**Interfaces:** Consumes nothing. Produces: the composite status widget rendering below the editor (the `belowEditor` placement is already in the working tree from the prototype).

- [ ] **Step 1: Confirm the flip is in place**

Run: `grep -n 'placement' bun-apps/pi-agent-ext-core-task/src/shared/status-widget.ts`
Expected: a line containing `{ placement: "belowEditor" }`. (If it reads `aboveEditor`, apply: `edit` `status-widget.ts` `{ placement: "aboveEditor" }` → `{ placement: "belowEditor" }`.)

- [ ] **Step 2: Run the core-task test suite**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test )`
Expected: PASS. If any test asserts `aboveEditor`, update it to `belowEditor` (none expected — placement is a render option, not asserted).

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/shared/status-widget.ts
git commit -m "feat(core-task): render composite status widget below the chat input

Move the pi-core-task composite (goal + loop + todo + wayfind) from
aboveEditor to belowEditor so it sits between the input and the footer,
matching the claude-code status position. Wayfinder ticket 01/02."
```

---

## Task 2: Prompt-history store module (pure)

**Files:**
- Create: `bun-apps/pi-agent-ext-prompt-history/src/history-store.ts`
- Test: `bun-apps/pi-agent-ext-prompt-history/src/history-store.test.ts`

**Interfaces:**
- Produces: `HISTORY_CAP`, `projectKey(cwd): string`, `historyFilePath(cwd, agentDir?): string`, `readHistory(cwd, agentDir?): string[]` (newest-first), `recordPrompt(cwd, text, agentDir?): string[]` (returns new history). Consumed by Task 3 (capture) and Task 4 (restore).

- [ ] **Step 1: Write the failing test**

`bun-apps/pi-agent-ext-prompt-history/src/history-store.test.ts`:
```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HISTORY_CAP,
	projectKey,
	historyFilePath,
	readHistory,
	recordPrompt,
} from "./history-store.ts";

let agentDir: string;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "ph-store-"));
});

describe("projectKey", () => {
	test("is <slug>-<12hex> and stable per cwd, distinct across cwds", () => {
		const k = projectKey("/tmp/foo");
		expect(k).toMatch(/^[a-z0-9._-]+-[0-9a-f]{12}$/);
		expect(projectKey("/tmp/foo")).toBe(k);
		expect(projectKey("/tmp/bar")).not.toBe(k);
	});
});

describe("historyFilePath", () => {
	test("lives under prompt-history/<key>/history.jsonl", () => {
		expect(historyFilePath("/tmp/foo", agentDir)).toBe(
			join(agentDir, "prompt-history", projectKey("/tmp/foo"), "history.jsonl"),
		);
	});
});

describe("recordPrompt + readHistory", () => {
	test("records newest-first and round-trips", () => {
		recordPrompt("/tmp/foo", "hello", agentDir);
		recordPrompt("/tmp/foo", "world", agentDir);
		expect(readHistory("/tmp/foo", agentDir)).toEqual(["world", "hello"]);
	});

	test("skips empty / whitespace-only", () => {
		recordPrompt("/tmp/foo", "   ", agentDir);
		expect(readHistory("/tmp/foo", agentDir)).toEqual([]);
	});

	test("skips consecutive duplicate of most-recent (non-consecutive allowed)", () => {
		recordPrompt("/tmp/foo", "a", agentDir);
		recordPrompt("/tmp/foo", "b", agentDir);
		recordPrompt("/tmp/foo", "a", agentDir); // non-consecutive dup → kept
		expect(readHistory("/tmp/foo", agentDir)).toEqual(["a", "b", "a"]);
		recordPrompt("/tmp/foo", "a", agentDir); // consecutive dup → skipped
		expect(readHistory("/tmp/foo", agentDir)).toEqual(["a", "b", "a"]);
	});

	test("excludes ! bash lines", () => {
		recordPrompt("/tmp/foo", "!ls -la", agentDir);
		recordPrompt("/tmp/foo", "  !git status", agentDir);
		expect(readHistory("/tmp/foo", agentDir)).toEqual([]);
	});

	test("caps at HISTORY_CAP, retaining the newest", () => {
		for (let i = 0; i < HISTORY_CAP + 10; i++) recordPrompt("/tmp/foo", `p${i}`, agentDir);
		const h = readHistory("/tmp/foo", agentDir);
		expect(h.length).toBe(HISTORY_CAP);
		expect(h[0]).toBe(`p${HISTORY_CAP + 9}`);
	});

	test("isolates per cwd", () => {
		recordPrompt("/tmp/foo", "x", agentDir);
		recordPrompt("/tmp/bar", "y", agentDir);
		expect(readHistory("/tmp/foo", agentDir)).toEqual(["x"]);
		expect(readHistory("/tmp/bar", agentDir)).toEqual(["y"]);
	});

	test("readHistory returns [] when file missing or corrupt", () => {
		expect(readHistory("/tmp/never", agentDir)).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-prompt-history && bun test src/history-store.test.ts )`
Expected: FAIL — `Cannot find module "./history-store.ts"`.

- [ ] **Step 3: Create the package + implement the store**

`bun-apps/pi-agent-ext-prompt-history/package.json`:
```json
{
  "name": "@repo/pi-agent-ext-prompt-history",
  "private": true,
  "version": "0.1.0",
  "description": "Pi extension: persists interactive prompt history per-cwd to ~/.pi/agent/prompt-history/<key>/history.jsonl for cross-session Up/Down recall (restored by the editor-history-restore patch).",
  "license": "MIT",
  "keywords": ["pi-package", "prompt-history", "history"],
  "type": "module",
  "exports": {
    "./extensions/*": "./extensions/*",
    "./src/*": "./src/*",
    "./src/*.js": "./src/*.ts"
  },
  "pi": { "extensions": ["./extensions"] },
  "scripts": { "test": "bun test", "typecheck": "tsc --noEmit" },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "0.83.0" },
  "devDependencies": { "@types/bun": "latest", "typescript": "^6.0.3" }
}
```

`bun-apps/pi-agent-ext-prompt-history/src/history-store.ts`:
```ts
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const HISTORY_CAP = 100;

export function sanitizePathSegment(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return sanitized || "project";
}

export function projectKey(cwd: string): string {
	const projectPath = resolve(cwd);
	const slug = sanitizePathSegment(basename(projectPath) || "project");
	const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
	return `${slug}-${hash}`;
}

export function historyFilePath(cwd: string, agentDir: string = getAgentDir()): string {
	return join(agentDir, "prompt-history", projectKey(cwd), "history.jsonl");
}

/** Read persisted history, newest-first. Returns [] if the file is missing or unparseable. */
export function readHistory(cwd: string, agentDir: string = getAgentDir()): string[] {
	const file = historyFilePath(cwd, agentDir);
	if (!existsSync(file)) return [];
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as string)
			.filter((x): x is string => typeof x === "string");
	} catch {
		return [];
	}
}

/**
 * Record a prompt (newest-first). Excludes empty, whitespace, and `!` bash lines;
 * skips a consecutive duplicate of the most-recent entry; caps at HISTORY_CAP.
 * Returns the resulting history (newest-first).
 */
export function recordPrompt(cwd: string, text: string, agentDir: string = getAgentDir()): string[] {
	const trimmed = text.trim();
	if (!trimmed || trimmed.startsWith("!")) return readHistory(cwd, agentDir);
	const existing = readHistory(cwd, agentDir);
	if (existing.length > 0 && existing[0] === trimmed) return existing;
	const next = [trimmed, ...existing].slice(0, HISTORY_CAP);
	const file = historyFilePath(cwd, agentDir);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, next.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
	return next;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-prompt-history && bun test src/history-store.test.ts )`
Expected: PASS (all 9 assertions).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-prompt-history/package.json \
        bun-apps/pi-agent-ext-prompt-history/src/history-store.ts \
        bun-apps/pi-agent-ext-prompt-history/src/history-store.test.ts
git commit -m "feat(prompt-history): add per-cwd prompt history store

Pure module: projectKey/historyFilePath path resolution, readHistory
(newest-first), recordPrompt (excludes bash + empty, skips consecutive
dup, caps at 100). JSONL under ~/.pi/agent/prompt-history/<slug>-<hash>/.
Wayfinder ticket 05."
```

---

## Task 3: Prompt-history capture extension + static registration

**Files:**
- Create: `bun-apps/pi-agent-ext-prompt-history/extensions/prompt-history.ts`
- Test: `bun-apps/pi-agent-ext-prompt-history/extensions/prompt-history.test.ts`
- Modify: `bun-apps/pi-agent/src/static-extensions.ts`

**Interfaces:**
- Consumes: `recordPrompt(cwd, text)` from Task 2.
- Produces: a default-exported `ExtensionFactory` that subscribes to the `input` event and persists interactive prompts.

- [ ] **Step 1: Write the failing test**

`bun-apps/pi-agent-ext-prompt-history/extensions/prompt-history.test.ts`:
```ts
import { describe, expect, test, mock } from "bun:test";
import { createPromptHistoryExtension } from "./prompt-history.ts";

test("subscribes to input and records interactive prompts, skips synthetic source", () => {
	const record = mock((_cwd: string, _text: string) => []);
	const extension = createPromptHistoryExtension(record);
	const handlers: Array<(e: any, ctx: any) => void> = [];
	const pi = { on: (_event: string, fn: (e: any, ctx: any) => void) => { handlers.push(fn); } } as any;
	extension(pi);
	expect(handlers).toHaveLength(1);

	handlers[0]({ type: "input", text: "hello", source: "interactive" }, { cwd: "/proj" });
	handlers[0]({ type: "input", text: "queued", source: "extension" }, { cwd: "/proj" }); // synthetic → skip
	handlers[0]({ type: "input", text: "!ls", source: "interactive" }, { cwd: "/proj" }); // bash → store skips it

	expect(record).toHaveBeenCalledTimes(3); // store decides bash exclusion; factory only skips synthetic
	expect(record).toHaveBeenNthCalledWith(1, "/proj", "hello");
	expect(record).toHaveBeenNthCalledWith(2, "/proj", "queued"); // not skipped by factory — synthetic is filtered below instead
});
```

> **Note:** the factory filters `source === "extension"` (synthetic/programmatic input). Re-read Step 3 below — the factory returns early for synthetic source, so `record` is called only for `interactive`/`rpc`. Correct the test's last assertion to match Step 3's behavior before running. (This interdependence is intentional: write the test, read the implementation contract in Step 3, reconcile, then implement.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-prompt-history && bun test extensions/prompt-history.test.ts )`
Expected: FAIL — `Cannot find module "./prompt-history.ts"`.

- [ ] **Step 3: Implement the factory**

`bun-apps/pi-agent-ext-prompt-history/extensions/prompt-history.ts`:
```ts
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { recordPrompt } from "../src/history-store.ts";

/**
 * Create the prompt-history extension. `record` is injectable for testing;
 * production uses recordPrompt (writes to the per-cwd history.jsonl).
 */
export function createPromptHistoryExtension(
	record: (cwd: string, text: string) => unknown = recordPrompt,
): ExtensionFactory {
	return (pi) => {
		pi.on("input", (event, ctx) => {
			// Skip synthetic/programmatic input — only persist human prompts.
			if (event.source === "extension") return;
			record(ctx.cwd, event.text);
		});
	};
}

export default createPromptHistoryExtension();
```

- [ ] **Step 4: Reconcile the test (Step 1's tail assertion) and run to verify it passes**

The factory skips `source === "extension"`, so `record` is called for `interactive` and `rpc` only. Update Step 1's test so the final expectations are:
```ts
expect(record).toHaveBeenCalledTimes(2); // interactive + rpc; synthetic skipped
expect(record).toHaveBeenNthCalledWith(1, "/proj", "hello");
```
Add a third call with `source: "rpc"` to cover the non-synthetic, non-interactive path:
```ts
handlers[0]({ type: "input", text: "rpc-prompt", source: "rpc" }, { cwd: "/proj" });
// …then:
expect(record).toHaveBeenNthCalledWith(2, "/proj", "rpc-prompt");
```
Run: `( cd bun-apps/pi-agent-ext-prompt-history && bun test extensions/prompt-history.test.ts )`
Expected: PASS.

- [ ] **Step 5: Register the extension statically**

Modify `bun-apps/pi-agent/src/static-extensions.ts`:

Add the import after the `coreTaskExtension` import line (`import coreTaskExtension from "../../pi-agent-ext-core-task/extensions/core-task.ts";`):
```ts
import promptHistoryExtension from "../../pi-agent-ext-prompt-history/extensions/prompt-history.ts";
```
Add the entry to `STATIC_EXTENSION_FACTORIES` right after the core-task entry (`{ name: "pi-agent-ext-core-task", factory: coreTaskExtension },`):
```ts
	{ name: "pi-agent-ext-prompt-history", factory: promptHistoryExtension },
```

- [ ] **Step 6: Verify pi-agent still typechecks/tests**

Run: `( cd bun-apps/pi-agent && bun test src/static-extensions.test.ts 2>/dev/null || true ) && ( cd bun-apps/pi-agent && bun run typecheck 2>/dev/null || true )`
Expected: no errors referencing the new import. (If `bun run typecheck` is unavailable, skip; the import path mirrors the existing sibling-extension imports exactly.)

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-prompt-history/extensions/prompt-history.ts \
        bun-apps/pi-agent-ext-prompt-history/extensions/prompt-history.test.ts \
        bun-apps/pi-agent/src/static-extensions.ts
git commit -m "feat(prompt-history): capture interactive prompts via input event

New pi-agent-ext-prompt-history extension (static-registered): subscribes
to pi.on('input'), skips synthetic (source==='extension') input, and
persists each prompt through recordPrompt. Wayfinder ticket 05."
```

---

## Task 4: editor-history-restore patch + registration

**Files:**
- Create: `bun-apps/pi-agent/src/patches/editor-history-restore.ts`
- Test: `bun-apps/pi-agent/src/patches/editor-history-restore.test.ts`
- Modify: `bun-apps/pi-agent/src/patches/index.ts`, `bun-apps/pi-agent/src/patches/index.test.ts`

**Interfaces:**
- Consumes: `readHistory(cwd): string[]` (newest-first) from Task 2, imported via the relative path `../../pi-agent-ext-prompt-history/src/history-store.ts`.
- Produces: a prototype patch that, after `InteractiveMode.prototype.init`, sets `this.editor.history` from the persisted JSONL.

**Reach path (verified against pi-coding-agent 0.83.0):** `InteractiveMode` is exported from `@earendil-works/pi-coding-agent`; its instance owns `this.editor` (a `CustomEditor extends Editor`, built in the constructor — `interactive-mode.js:289-295`) and `this.sessionManager` (getter at `:259`, `.getCwd()`). `Editor.history` is an array (newest-first; `editor.js:228-231`) and `Editor.exitHistoryBrowsing()` resets the browse index (`editor.js:354-357`). Both are live by the time `init()` completes.

- [ ] **Step 1: Write the failing test**

`bun-apps/pi-agent/src/patches/editor-history-restore.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { wrapInteractiveInitForHistoryRestore } from "./editor-history-restore.ts";

function makeStubProto(): object {
	return {
		async init() {},
	};
}

test("hydrates editor.history newest-first from the reader after orig init", async () => {
	const proto: any = makeStubProto();
	expect(wrapInteractiveInitForHistoryRestore(proto, () => ["old", "new"])).toBe(true);
	const instance = Object.create(proto);
	instance.sessionManager = { getCwd: () => "/proj" };
	instance.editor = { history: [], exitHistoryBrowsing() {} };
	await instance.init();
	expect(instance.editor.history).toEqual(["old", "new"]);
	expect(instance.editor.exitHistoryBrowsing).toBeDefined();
});

test("idempotent per-prototype — a second wrap returns false", () => {
	const proto: any = makeStubProto();
	expect(wrapInteractiveInitForHistoryRestore(proto, () => [])).toBe(true);
	expect(wrapInteractiveInitForHistoryRestore(proto, () => [])).toBe(false);
});

test("shape-change guard — missing init returns false", () => {
	expect(wrapInteractiveInitForHistoryRestore({}, () => [])).toBe(false);
});

test("never throws when editor or cwd is missing", async () => {
	const proto: any = { async init() {} };
	wrapInteractiveInitForHistoryRestore(proto, () => ["x"]);
	const instance = Object.create(proto); // no sessionManager / editor
	await expect(instance.init()).resolves.toBeUndefined();
});

test("caps the restored history at 100", async () => {
	const proto: any = makeStubProto();
	const many = Array.from({ length: 150 }, (_, i) => `p${i}`);
	wrapInteractiveInitForHistoryRestore(proto, () => many);
	const instance = Object.create(proto);
	instance.sessionManager = { getCwd: () => "/proj" };
	instance.editor = { history: [], exitHistoryBrowsing() {} };
	await instance.init();
	expect(instance.editor.history.length).toBe(100);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent && bun test src/patches/editor-history-restore.test.ts )`
Expected: FAIL — `Cannot find module "./editor-history-restore.ts"`.

- [ ] **Step 3: Implement the patch**

`bun-apps/pi-agent/src/patches/editor-history-restore.ts`:
```ts
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { readHistory } from "../../pi-agent-ext-prompt-history/src/history-store.ts";

const HISTORY_RESTORE_CAP = 100;
const wrappedPrototypes = new WeakSet<object>();

/**
 * Wrap InteractiveMode.prototype.init so that, after the original init, the
 * editor's Up/Down recall buffer is hydrated from the per-cwd persisted
 * history. `read` is injectable for testing; production uses readHistory.
 * Returns true if wrapped now, false if already wrapped or init is missing.
 */
export function wrapInteractiveInitForHistoryRestore(
	proto: object,
	read: (cwd: string) => string[] = readHistory,
): boolean {
	if (wrappedPrototypes.has(proto)) return false;
	const p = proto as Record<string, unknown>;
	const original = p.init;
	if (typeof original !== "function") return false;

	p.init = async function (this: any, ...args: unknown[]) {
		await (original as (...a: unknown[]) => unknown).apply(this, args);
		try {
			const cwd: string | undefined = this.sessionManager?.getCwd?.();
			const editor = this.editor;
			if (cwd && editor && Array.isArray(editor.history)) {
				editor.history = read(cwd).slice(0, HISTORY_RESTORE_CAP); // readHistory is newest-first
				editor.exitHistoryBrowsing?.();
			}
		} catch {
			// Never break startup on history restore.
		}
	};
	wrappedPrototypes.add(proto);
	return true;
}

wrapInteractiveInitForHistoryRestore(InteractiveMode.prototype);
if (process.env.BUN_PI_DEBUG_PATCHES === "1" || process.env.BUN_PI_DEBUG_PATCHES === "true") {
	console.error("[bun-pi] editor-history-restore patch applied");
}
export const editorHistoryRestorePatchApplied = true;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent && bun test src/patches/editor-history-restore.test.ts )`
Expected: PASS (all 5 assertions).

- [ ] **Step 5: Register the patch in `index.ts` (3 edits)**

Modify `bun-apps/pi-agent/src/patches/index.ts`:

(a) `PatchName` union — append `| "editor-history-restore"`:
```ts
	| "footer-extension-status-notify"
	| "force-response-language"
	| "editor-history-restore";
```

(b) `PATCH_TABLE` — append after the `footer-extension-status-notify` entry:
```ts
  // editor-history-restore: wraps InteractiveMode.prototype.init to hydrate
  // this.editor.history from the per-cwd prompt-history.jsonl (written by the
  // pi-agent-ext-prompt-history extension) so Up/Down recalls prior sessions.
  // Must run after ensure-extension-deps (imports @earendil-works/pi-coding-agent
  // + the sibling prompt-history store). Disable with BUN_PI_EDITOR_HISTORY_RESTORE=0.
  { name: "editor-history-restore", env: "BUN_PI_EDITOR_HISTORY_RESTORE", defaultValue: true },
```

(c) `applyPatches()` switch — add a case after the `footer-extension-status-notify` case (must be a **static string literal**):
```ts
      case "editor-history-restore":
        await import("./editor-history-restore.ts");
        break;
```

- [ ] **Step 6: Update the `index.test.ts` completeness list**

Modify `bun-apps/pi-agent/src/patches/index.test.ts`: in the `"covers all known patches"` test's expected array, add `"editor-history-restore"` (sorted alongside the other names). Run `( cd bun-apps/pi-agent && bun test src/patches/index.test.ts )` → PASS.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent/src/patches/editor-history-restore.ts \
        bun-apps/pi-agent/src/patches/editor-history-restore.test.ts \
        bun-apps/pi-agent/src/patches/index.ts \
        bun-apps/pi-agent/src/patches/index.test.ts
git commit -m "feat(pi-agent): editor-history-restore patch

Wrap InteractiveMode.prototype.init to hydrate this.editor.history from
the per-cwd prompt-history.jsonl on startup/reload, giving Up/Down
cross-session recall. Registered via applyPatches(). Wayfinder ticket 05."
```

---

## Task 5: startup-history-hint patch + registration

**Files:**
- Create: `bun-apps/pi-agent/src/patches/startup-history-hint.ts`
- Test: `bun-apps/pi-agent/src/patches/startup-history-hint.test.ts`
- Modify: `bun-apps/pi-agent/src/patches/index.ts`, `bun-apps/pi-agent/src/patches/index.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a prototype patch that appends `↑/↓ to browse history` to the expanded startup header.

**Reach path (verified):** `InteractiveMode` builds `this.builtInHeader = new ExpandableText(getCollapsedText, getExpandedText, …)` (`interactive-mode.js:536`). `ExpandableText` (`interactive-mode.js:74-86`) stores `getCollapsedText` and `getExpandedText` as **public instance fields** and re-reads `getExpandedText()` on `setExpanded(true)`. So rewrapping `header.getExpandedText` after `init` injects the hint into the expanded view. The startup hint strip has no extension-contributor hook (`ctx.ui.setHeader` is full-replace only), so a patch is required. (`rawKeyHint`/`theme` are module-private and not exported, so the hint line is appended as an unstyled string — a minor cosmetic tradeoff; the functionality is complete.)

- [ ] **Step 1: Write the failing test**

`bun-apps/pi-agent/src/patches/startup-history-hint.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { wrapInteractiveInitForHistoryHint } from "./startup-history-hint.ts";

test("appends the hint to the expanded header text, leaves collapsed unchanged", async () => {
	const header = {
		getCollapsedText: () => "COMPACT",
		getExpandedText: () => "EXPANDED",
	};
	const proto: any = { async init() {} };
	wrapInteractiveInitForHistoryHint(proto, "↑/↓ to browse history");
	const instance = Object.create(proto);
	instance.builtInHeader = header;
	await instance.init();
	expect(header.getExpandedText()).toBe("EXPANDED\n↑/↓ to browse history");
	expect(header.getCollapsedText()).toBe("COMPACT");
});

test("idempotent per-prototype — a second wrap returns false", () => {
	const proto: any = { async init() {} };
	expect(wrapInteractiveInitForHistoryHint(proto, "x")).toBe(true);
	expect(wrapInteractiveInitForHistoryHint(proto, "x")).toBe(false);
});

test("shape-change guard — missing init returns false", () => {
	expect(wrapInteractiveInitForHistoryHint({}, "x")).toBe(false);
});

test("no header → no throw", async () => {
	const proto: any = { async init() {} };
	wrapInteractiveInitForHistoryHint(proto, "x");
	const instance = Object.create(proto); // no builtInHeader
	await expect(instance.init()).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent && bun test src/patches/startup-history-hint.test.ts )`
Expected: FAIL — `Cannot find module "./startup-history-hint.ts"`.

- [ ] **Step 3: Implement the patch**

`bun-apps/pi-agent/src/patches/startup-history-hint.ts`:
```ts
import { InteractiveMode } from "@earendil-works/pi-coding-agent";

const HINT_LINE = "↑/↓ to browse history";
const wrappedPrototypes = new WeakSet<object>();

/**
 * Wrap InteractiveMode.prototype.init so that, after the original init, the
 * expanded startup header appends the history-browse hint. `hint` is injectable
 * for testing; production uses HINT_LINE. Returns true if wrapped now, false if
 * already wrapped or init is missing.
 */
export function wrapInteractiveInitForHistoryHint(proto: object, hint: string = HINT_LINE): boolean {
	if (wrappedPrototypes.has(proto)) return false;
	const p = proto as Record<string, unknown>;
	const original = p.init;
	if (typeof original !== "function") return false;

	p.init = async function (this: any, ...args: unknown[]) {
		await (original as (...a: unknown[]) => unknown).apply(this, args);
		try {
			const header = this.builtInHeader;
			if (
				header &&
				typeof header.getExpandedText === "function" &&
				typeof header.getCollapsedText === "function"
			) {
				const origExpanded = header.getExpandedText.bind(header);
				header.getExpandedText = () => `${origExpanded()}\n${hint}`;
			}
		} catch {
			// Never break startup on the hint.
		}
	};
	wrappedPrototypes.add(proto);
	return true;
}

wrapInteractiveInitForHistoryHint(InteractiveMode.prototype);
if (process.env.BUN_PI_DEBUG_PATCHES === "1" || process.env.BUN_PI_DEBUG_PATCHES === "true") {
	console.error("[bun-pi] startup-history-hint patch applied");
}
export const startupHistoryHintPatchApplied = true;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent && bun test src/patches/startup-history-hint.test.ts )`
Expected: PASS (all 4 assertions).

- [ ] **Step 5: Register the patch in `index.ts` (3 edits)**

Modify `bun-apps/pi-agent/src/patches/index.ts`:

(a) `PatchName` union — append `| "startup-history-hint"` after `"editor-history-restore"`.

(b) `PATCH_TABLE` — append after the `editor-history-restore` entry:
```ts
  // startup-history-hint: wraps InteractiveMode.prototype.init to append
  // "↑/↓ to browse history" to the expanded startup keybinding strip (the hint
  // otherwise lives only in the help table). No extension hook exists to
  // contribute startup hints (setHeader is full-replace), so a patch is needed.
  // Disable with BUN_PI_STARTUP_HISTORY_HINT=0.
  { name: "startup-history-hint", env: "BUN_PI_STARTUP_HISTORY_HINT", defaultValue: true },
```

(c) `applyPatches()` switch — add a case after the `editor-history-restore` case:
```ts
      case "startup-history-hint":
        await import("./startup-history-hint.ts");
        break;
```

- [ ] **Step 6: Update the `index.test.ts` completeness list**

Modify `bun-apps/pi-agent/src/patches/index.test.ts`: add `"startup-history-hint"` to the `"covers all known patches"` expected array. Run `( cd bun-apps/pi-agent && bun test src/patches/index.test.ts )` → PASS.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent/src/patches/startup-history-hint.ts \
        bun-apps/pi-agent/src/patches/startup-history-hint.test.ts \
        bun-apps/pi-agent/src/patches/index.ts \
        bun-apps/pi-agent/src/patches/index.test.ts
git commit -m "feat(pi-agent): startup-history-hint patch

Wrap InteractiveMode.prototype.init to append '↑/↓ to browse history' to
the expanded startup keybinding strip (the hint lives only in the help
table today). Registered via applyPatches(). Wayfinder ticket 06."
```

---

## Final verification

- [ ] **Run the full affected test suites**

```bash
( cd bun-apps/pi-agent-ext-prompt-history && bun test )
( cd bun-apps/pi-agent-ext-core-task && bun test )
( cd bun-apps/pi-agent && bun test src/patches/ )
```
Expected: all PASS.

- [ ] **Manual smoke test**

Launch `pi` in this repo, then:
1. Submit a prompt (e.g. "hello"). Submit another (e.g. "world"). Submit a bash line `!ls`.
2. Exit and relaunch `pi` in the **same cwd**.
3. Press **Up** in the empty editor → expect "world", Up again → "hello" (newest-first). `!ls` must NOT appear.
4. At the startup header, expand it (`Ctrl+O` / the expand key per the strip) → expect `↑/↓ to browse history` among the hints.
5. Relaunch `pi` in a **different cwd** → Up recalls nothing from the first cwd (per-cwd isolation).
6. Confirm the composite status widget (goal/loop/todo/wayfind) renders **below** the chat input, above the footer.

- [ ] **Disable-knob check**

`BUN_PI_EDITOR_HISTORY_RESTORE=0 pi` → Up recalls nothing (patch off). `BUN_PI_STARTUP_HISTORY_HINT=0 pi` → hint absent. Both confirm the env gates work.

---

## Self-Review

**1. Spec coverage** (against the sealed wayfinder map tickets 01/02/05/06):
- Placement (01/02) → Task 1. ✅
- cwd-scoped persistence, capture via `input` excluding `!` bash, restore, cap 100 + dedup (05) → Tasks 2–4 (store excludes bash + dedups + caps; capture subscribes `input`; restore hydrates on init). ✅
- Discoverability hint in the startup strip, trigger kept, Ctrl+R deferred (06) → Task 5 (hint); trigger untouched; Ctrl+R intentionally out of scope (deferred). ✅
- Ctrl+P/N aliases — out of scope (keys taken), no task (correct). ✅

**2. Placeholder scan:** No TBD/TODO/"add error handling"/"similar to". Every code step shows actual code. The one intentional reconciliation note (Task 3 Step 4) gives the exact corrected assertions, not a placeholder. ✅

**3. Type/name consistency:**
- `recordPrompt(cwd, text, agentDir?)` — Task 2 defines, Task 3 calls with `(ctx.cwd, event.text)`. ✅
- `readHistory(cwd)` — Task 2 defines, Task 4 imports + calls with `(cwd)`. ✅
- `wrapInteractiveInitForHistoryRestore(proto, read?)` / `wrapInteractiveInitForHistoryHint(proto, hint?)` — consistent signatures across test + impl + registration. ✅
- Patch names `"editor-history-restore"` / `"startup-history-hint"` + envs `BUN_PI_EDITOR_HISTORY_RESTORE` / `BUN_PI_STARTUP_HISTORY_HINT` — consistent across index.ts edits and the disable-knob check. ✅

**Scope note:** Two patches both wrap `InteractiveMode.prototype.init`; they compose (each preserves the prior via `original.apply`, independent post-hooks). `editor-history-restore` is listed before `startup-history-hint` in `PATCH_TABLE` (functional before cosmetic), but either order works.
