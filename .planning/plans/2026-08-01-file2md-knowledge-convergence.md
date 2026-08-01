# file2md → knowledge-card convergence (wired `pi:knowledge` bus) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire file2md's opt-in conversions into the knowledge-card convergence sink via the `pi:knowledge` event bus — closing the `file2md → knowledge card → obsidian` gap so converted documents land as cards in the shared graph, deterministically and idempotently, with no manual `zk_ingest`.

**Architecture:** file2md gains a `knowledge` flag (default off). When set, after writing `./vlm-out/<slug>/`, it emits `{source:"generic", sourceLabel:"file2md:<slug>", dir:<abs path>}` on the `pi:knowledge` bus via a **direct `pi.events.emit`** (no hub import — ADR-0001). knowledge-card de-orphans the bus: it extends the `KnowledgeEmission` contract + `onKnowledge` gate to accept `dir`, registers a best-effort sink subscriber that routes the payload to the **existing** directory-expansion generic ingest path (`collectInputFiles` → `adaptGenericMarkdown` → `ingestRecords`), landing cards in the shared `Zettelkasten/knowledge-graph/` folder. Deterministic, no LLM, idempotent (`generic:<slug>` dedup).

**Tech Stack:** TypeScript, Bun, `@earendil-works/pi-coding-agent` (`ExtensionAPI`), TypeBox (`@sinclair/typebox` → `Type.*`), `bun:test`.

**Spec source:** wayfinder map `.planning/2026-08-01-continue-improve-the-pipeline-between-extension-/` — closed tickets 01–04 (decisions) + open tickets 05 (sink) & 06 (file2md emit). This plan implements 05 + 06 against the contract resolved in 04.

## Global Constraints

- **ADR-0001 (hard):** NO upward dependency edge — `pi-agent-ext-file2md` MUST NOT import anything from `pi-agent-ext-knowledge-card`. file2md emits via direct `pi.events.emit("pi:knowledge", …)` with the channel name + payload shape hardcoded locally. Do NOT add `pi-agent-ext-knowledge-card` to file2md's `package.json` dependencies.
- **Deterministic, no LLM:** convergence uses the existing `ingestRecords` generic path only. No `obsidian_distill` / subagent in this flow.
- **Idempotent:** re-emitting the same doc is a no-op (canonical id `generic:<slug>`, dedup'd 1:1 by `ingestRecords`).
- **Shared folder invariant:** cards land in `Zettelkasten/knowledge-graph/` (the single WRITE folder so cross-source `[[edges]]` form).
- **Best-effort bus handlers:** a missing/throwing `pi.events` and any ingest/vault failure inside a sink handler MUST be swallowed — never break the emitter (file2md) or throw from a subscriber (knowledge-card). Mirror `src/emit.ts`'s swallow-on-failure contract.
- **Tool schemas** use TypeBox `Type.Object({…})`; new params are `Type.Optional(...)`.
- **Shell discipline:** never top-level `cd`; run tests as `( cd bun-apps/<pkg> && bun test )`. Commits use Conventional Commits (`feat:`/`test:`/`refactor:`).

## File Structure

**knowledge-card (`bun-apps/pi-agent-ext-knowledge-card/`)**
- `src/emit.ts` — MODIFY: add `dir?: string` to `KnowledgeEmission`; extend `onKnowledge` validation gate to accept `dir`.
- `src/converge.ts` — CREATE: pure router `convergeKnowledgeEmission(payload, opts)` → routes `dir`/`kbFile`/`records[]` to `ingestRecords`. No vault resolution (caller passes `vaultPath`); unit-testable with a temp vault.
- `extensions/knowledge-card.ts` — MODIFY: in the factory body, register an `onKnowledge` subscriber that resolves the vault + calls `convergeKnowledgeEmission`, best-effort.
- `__tests__/emit.test.ts` — MODIFY: add `dir`-gate cases.
- `__tests__/converge.test.ts` — CREATE: router tests (3 routes + idempotency + empty→null).
- `__tests__/sink.test.ts` — CREATE: subscriber end-to-end (fake bus + temp vault + file2md-shaped payload).

**file2md (`bun-apps/pi-agent-ext-file2md/`)**
- `extensions/file2md.ts` — MODIFY: add `knowledge` param; add local `buildFile2mdEmission` + `emitFile2mdKnowledge` (no hub import); call them after the pipeline writes when `knowledge:true`.
- `__tests__/knowledge-emit.test.ts` — CREATE: payload-builder purity, safe-emit (fire-and-forget + swallow), and a no-hub-import guard.

---

### Task 1: Contract — `KnowledgeEmission.dir` + `onKnowledge` gate

**Files:**
- Modify: `bun-apps/pi-agent-ext-knowledge-card/src/emit.ts` (the `KnowledgeEmission` interface + the `onKnowledge` validation gate)
- Test: `bun-apps/pi-agent-ext-knowledge-card/__tests__/emit.test.ts`

**Interfaces:**
- Produces: `KnowledgeEmission.dir?: string` (absolute path to a directory of source files); `onKnowledge` now forwards payloads that carry `records` OR `kbFile` OR `dir`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/emit.test.ts` (the `fakeApi` helper + imports already exist at top of file):

```ts
const dirEmission: KnowledgeEmission = {
	source: "generic",
	sourceLabel: "file2md:my-doc",
	dir: "/abs/vlm-out/my-doc",
};

describe("onKnowledge — dir payload (file2md convergence)", () => {
	test("a dir-only payload is delivered (gate accepts dir)", () => {
		const api = fakeApi();
		let received: KnowledgeEmission | null = null;
		onKnowledge(api as never, (p) => (received = p));
		emitKnowledge(api as never, dirEmission);
		expect(received).not.toBeNull();
		expect(received!.dir).toBe("/abs/vlm-out/my-doc");
		expect(received!.source).toBe("generic");
	});

	test("gate skips a payload with none of records/kbFile/dir", () => {
		const api = fakeApi();
		let seen = 0;
		onKnowledge(api as never, () => seen++);
		// well-typed except it carries no records/kbFile/dir → must be skipped
		(api.events as { emit: (c: string, d: unknown) => void }).emit(KNOWLEDGE_CHANNEL, {
			source: "generic",
			sourceLabel: "x",
			note: "nothing to ingest",
		});
		expect(seen).toBe(0);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/emit.test.ts )`
Expected: FAIL — the dir-only case fails because the current gate (`if (!p.records && !p.kbFile) return;`) drops it.

- [ ] **Step 3: Add `dir` to `KnowledgeEmission`**

In `src/emit.ts`, add the field to the interface (after `kbFile?: string;`):

```ts
	/** Absolute path to a directory of source files to ingest (e.g. file2md's
	 *  ./vlm-out/<slug>/ output). The sink expands it via the source family's
	 *  adapter (generic → adaptGenericMarkdown per .md). Preferred when an
	 *  emitter writes a folder rather than a .knowledge.jsonl. */
	dir?: string;
```

- [ ] **Step 4: Extend the `onKnowledge` validation gate**

In `src/emit.ts`, inside `onKnowledge`, change the gate line from:

```ts
			if (!p.records && !p.kbFile) return;
```

to:

```ts
			if (!p.records && !p.kbFile && !p.dir) return;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/emit.test.ts )`
Expected: PASS — all emit tests (existing + the two new dir cases) green.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-knowledge-card/src/emit.ts bun-apps/pi-agent-ext-knowledge-card/__tests__/emit.test.ts
git commit -m "feat(knowledge-card): accept dir in KnowledgeEmission + onKnowledge gate"
```

---

### Task 2: Converge router — `src/converge.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-knowledge-card/src/converge.ts`
- Test: `bun-apps/pi-agent-ext-knowledge-card/__tests__/converge.test.ts`

**Interfaces:**
- Consumes: `collectInputFiles`, `adaptGenericMarkdown`, `parseKnowledgeJsonl`, `ingestRecords`, `KnowledgeRecord`, `IngestSummary` (from `./ingest.ts`); `KnowledgeEmission` (from `./emit.ts`).
- Produces: `convergeKnowledgeEmission(payload: KnowledgeEmission, opts: { vaultPath: string; cwd: string; folder?: string }): Promise<IngestSummary | null>` — routes `dir`/`kbFile`/`records[]` to `ingestRecords`; returns `null` when the payload carries no records. Pure (does fs reads + writes via `ingestRecords`, but NO vault resolution — caller passes `vaultPath`).

- [ ] **Step 1: Write the failing tests**

Create `__tests__/converge.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convergeKnowledgeEmission } from "../src/converge.ts";
import type { KnowledgeEmission } from "../src/emit.ts";
import type { KnowledgeRecord } from "../src/ingest.ts";

const FOLDER = "Zettelkasten/knowledge-graph";

let vault: string;
let src: string;

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kc-vault-"));
	src = mkdtempSync(join(tmpdir(), "kc-src-"));
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
	rmSync(src, { recursive: true, force: true });
});

const sampleRecord = (): KnowledgeRecord => ({
	id: "workflow:probe-1",
	type: "pattern",
	title: "Probe pattern",
	detail: "A deterministic convergence probe.",
	tags: ["probe"],
	dimension: null,
	confidence: 0.8,
	status: "active",
	superseded_by: null,
});

describe("convergeKnowledgeEmission — dir route (file2md path)", () => {
	test("ingests every .md in the dir, idempotent on re-emit", async () => {
		writeFileSync(join(src, "page-1.md"), "# Page One\n\nbody text.\n");
		writeFileSync(join(src, "page-2.md"), "# Page Two\n\nmore body.\n");
		const payload: KnowledgeEmission = { source: "generic", sourceLabel: "file2md:doc", dir: src };

		const first = await convergeKnowledgeEmission(payload, { vaultPath: vault, cwd: src });
		expect(first).not.toBeNull();
		expect(first!.created).toBe(2);

		const second = await convergeKnowledgeEmission(payload, { vaultPath: vault, cwd: src });
		expect(second!.created).toBe(0);
		expect(second!.unchanged).toBe(2);
	});

	test("returns null for a dir with no .md files", async () => {
		const payload: KnowledgeEmission = { source: "generic", sourceLabel: "file2md:empty", dir: src };
		const out = await convergeKnowledgeEmission(payload, { vaultPath: vault, cwd: src });
		expect(out).toBeNull();
	});
});

describe("convergeKnowledgeEmission — kbFile route", () => {
	test("parses a .knowledge.jsonl and ingests", async () => {
		const kbFile = join(src, "out.knowledge.jsonl");
		writeFileSync(kbFile, `${JSON.stringify(sampleRecord())}\n`);
		const payload: KnowledgeEmission = { source: "workflow-jsonl", sourceLabel: "wf:x", kbFile };
		const out = await convergeKnowledgeEmission(payload, { vaultPath: vault, cwd: src });
		expect(out).not.toBeNull();
		expect(out!.created).toBeGreaterThanOrEqual(1);
	});
});

describe("convergeKnowledgeEmission — records route", () => {
	test("ingests inline records", async () => {
		const payload: KnowledgeEmission = {
			source: "workflow-jsonl",
			sourceLabel: "wf:inline",
			records: [sampleRecord()],
		};
		const out = await convergeKnowledgeEmission(payload, { vaultPath: vault, cwd: src });
		expect(out).not.toBeNull();
		expect(out!.created).toBeGreaterThanOrEqual(1);
	});
});

describe("convergeKnowledgeEmission — empty payload", () => {
	test("returns null when no records/kbFile/dir", async () => {
		const payload: KnowledgeEmission = { source: "generic", sourceLabel: "x", note: "nothing" };
		const out = await convergeKnowledgeEmission(payload, { vaultPath: vault, cwd: src });
		expect(out).toBeNull();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/converge.test.ts )`
Expected: FAIL — `Cannot resolve module "../src/converge.ts"`.

- [ ] **Step 3: Create `src/converge.ts`**

```ts
/**
 * src/converge.ts — route a `pi:knowledge` bus emission to the deterministic
 * ingest sink. Owned by the HUB (ADR-0001): foundation extensions emit on the
 * bus without importing the hub; this module + the subscriber in
 * extensions/knowledge-card.ts are the sink side.
 *
 * Pure w.r.t. vault resolution — the caller passes `vaultPath` (resolved by the
 * subscriber via `resolveVault`), so this module is unit-testable with a temp
 * vault and no env coupling.
 */
import { readFileSync } from "node:fs";
import {
	collectInputFiles,
	adaptGenericMarkdown,
	parseKnowledgeJsonl,
	ingestRecords,
	type KnowledgeRecord,
	type IngestSummary,
} from "./ingest.ts";
import type { KnowledgeEmission } from "./emit.ts";

export interface ConvergeOptions {
	/** Absolute vault path (the convergence sink — single shared vault). */
	vaultPath: string;
	/** cwd used to resolve relative dir/kbFile paths in the payload. */
	cwd: string;
	/** Convergence folder inside the vault (default: Zettelkasten/knowledge-graph). */
	folder?: string;
}

/**
 * Route a {@link KnowledgeEmission} to `ingestRecords`:
 *  - `dir`     → directory-expansion generic ingest (file2md's path): recurse
 *               the dir, `adaptGenericMarkdown` per `.md`, ingest as `generic`.
 *  - `kbFile`  → `parseKnowledgeJsonl` the file, ingest.
 *  - `records` → ingest the inline records as-is.
 * Returns the ingest summary, or `null` if the payload carried no records.
 * Does NOT vault-resolve (caller does) and does NOT swallow — the subscriber
 * wraps this in its own try/catch.
 */
export async function convergeKnowledgeEmission(
	payload: KnowledgeEmission,
	opts: ConvergeOptions,
): Promise<IngestSummary | null> {
	const records: KnowledgeRecord[] = [];

	if (payload.dir) {
		const { files } = collectInputFiles([payload.dir], { source: "generic", cwd: opts.cwd });
		for (const abs of files) {
			const rec = adaptGenericMarkdown(readFileSync(abs, "utf8"), abs);
			if (rec) records.push(rec);
		}
	} else if (payload.kbFile) {
		records.push(...parseKnowledgeJsonl(readFileSync(payload.kbFile, "utf8")).records);
	} else if (payload.records?.length) {
		records.push(...payload.records);
	}

	if (records.length === 0) return null;

	return ingestRecords(records, {
		vaultPath: opts.vaultPath,
		source: payload.source,
		sourceLabel: payload.sourceLabel,
		folder: opts.folder,
		wikiAware: true,
	});
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/converge.test.ts )`
Expected: PASS — all four describe blocks green (dir idempotent, dir-empty→null, kbFile, records, empty→null).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-knowledge-card/src/converge.ts bun-apps/pi-agent-ext-knowledge-card/__tests__/converge.test.ts
git commit -m "feat(knowledge-card): convergeKnowledgeEmission router (dir/kbFile/records → ingestRecords)"
```

---

### Task 3: Sink subscriber wiring (de-orphan the bus)

**Files:**
- Modify: `bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts` (factory body — add imports + register the subscriber)
- Test: `bun-apps/pi-agent-ext-knowledge-card/__tests__/sink.test.ts` (CREATE)

**Interfaces:**
- Consumes: `onKnowledge` (from `../src/emit.ts`), `convergeKnowledgeEmission` (from `../src/converge.ts`), `resolveVault` (already in scope in the factory).
- Produces: a registered `pi:knowledge` subscriber on every extension load that best-effort converges emissions into the shared vault folder.

- [ ] **Step 1: Write the failing test**

Create `__tests__/sink.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import knowledgeCard from "../extensions/knowledge-card.ts";

/** Permissive fake pi: no-ops for on/registerTool, captures the pi:knowledge
 *  subscriber registered via onKnowledge → pi.events.on. */
function fakePi(capture: { handler?: (d: unknown) => void }) {
	return new Proxy(
		{},
		{
			get: (_t, prop) => {
				if (prop === "events")
					return {
						on: (_c: string, h: (d: unknown) => void) => {
							capture.handler = h;
							return () => {};
						},
						emit: () => {},
					};
				return () => {}; // pi.on("session_start"|"shutdown"), pi.registerTool(...)
			},
		},
	) as never;
}

const FOLDER = "Zettelkasten/knowledge-graph";

describe("pi:knowledge sink subscriber", () => {
	let vault: string;
	let src: string;
	const prevVault = process.env.OB_VAULT_PATH;

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "kc-sink-vault-"));
		src = mkdtempSync(join(tmpdir(), "kc-sink-src-"));
		process.env.OB_VAULT_PATH = vault;
	});
	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
		rmSync(src, { recursive: true, force: true });
		if (prevVault === undefined) delete process.env.OB_VAULT_PATH;
		else process.env.OB_VAULT_PATH = prevVault;
	});

	test("a file2md-shaped dir emission converges into the shared folder", async () => {
		writeFileSync(join(src, "page-1.md"), "# Page One\n\nbody.\n");
		const capture: { handler?: (d: unknown) => void } = {};
		// @ts-expect-error: fake pi is a Proxy stand-in for ExtensionAPI
		knowledgeCard(fakePi(capture));
		expect(capture.handler).toBeDefined();

		// drive the subscriber with a file2md-shaped payload
		await capture.handler!({ source: "generic", sourceLabel: "file2md:doc", dir: src });

		const folder = join(vault, FOLDER);
		const cards = readdirSync(folder).filter((f) => f.endsWith(".md"));
		expect(cards.length).toBeGreaterThanOrEqual(1);
	});

	test("best-effort: a bad dir never throws from the handler", async () => {
		const capture: { handler?: (d: unknown) => void } = {};
		// @ts-expect-error: fake pi is a Proxy stand-in for ExtensionAPI
		knowledgeCard(fakePi(capture));
		await expect(
			capture.handler!({ source: "generic", sourceLabel: "file2md:x", dir: "/no/such/dir" }),
		).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/sink.test.ts )`
Expected: FAIL — no `pi:knowledge` subscriber is registered today, so `capture.handler` is `undefined`.

- [ ] **Step 3: Add imports to the extension**

In `extensions/knowledge-card.ts`, alongside the existing `../src/*.ts` imports (near the `runConverge` import around line 78), add:

```ts
import { onKnowledge } from "../src/emit.ts";
import { convergeKnowledgeEmission } from "../src/converge.ts";
```

- [ ] **Step 4: Register the subscriber in the factory body**

In `extensions/knowledge-card.ts`, inside `piKnowledgeCardExtension(pi)`, immediately after the `session_shutdown` auto-converge block (the block ending around the `// Silent fail — best-effort; never blocks shutdown.` comment), add:

```ts
	// ── pi:knowledge sink — de-orphan the bus (file2md opt-in convergence) ──
	// ADR-0001: the HUB owns convergence. Foundation extensions (file2md) emit
	// on the bus without importing the hub; this subscriber converges them.
	// Best-effort: resolveVault/ingest failures are swallowed — a bus handler
	// must never throw (mirrors src/emit.ts's swallow-on-failure contract).
	onKnowledge(pi, async (payload) => {
		try {
			const cwd = process.cwd();
			const vaultPath = (await resolveVault(cwd)).path;
			await convergeKnowledgeEmission(payload, { vaultPath, cwd });
		} catch {
			// best-effort: never throw from a bus handler
		}
	});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/sink.test.ts )`
Expected: PASS — the dir emission converges into `Zettelkasten/knowledge-graph/`; the bad-dir case resolves undefined (swallowed).

- [ ] **Step 6: Run the full knowledge-card suite (regression guard)**

Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test )`
Expected: PASS — existing tests (emit, ingest, converge, retrieve, etc.) still green; hermes shutdown-pull convergence unaffected.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts bun-apps/pi-agent-ext-knowledge-card/__tests__/sink.test.ts
git commit -m "feat(knowledge-card): wire pi:knowledge sink subscriber (de-orphan the bus)"
```

---

### Task 4: file2md opt-in `knowledge` flag + direct emit

**Files:**
- Modify: `bun-apps/pi-agent-ext-file2md/extensions/file2md.ts` (add `knowledge` param to the `file2md` tool schema; add local `buildFile2mdEmission` + `emitFile2mdKnowledge`; call them after the pipeline writes)
- Test: `bun-apps/pi-agent-ext-file2md/__tests__/knowledge-emit.test.ts` (CREATE)

**Interfaces:**
- Produces: exported `buildFile2mdEmission(slug: string, dirAbs: string): File2mdKnowledgeEmission` (pure) and `emitFile2mdKnowledge(pi: ExtensionAPI, payload: File2mdKnowledgeEmission): void` (fire-and-forget, non-throwing). The `file2md` tool gains an optional `knowledge: boolean` param.
- Constraint: NO import from `@repo/pi-agent-ext-knowledge-card` anywhere in this file.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/knowledge-emit.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { buildFile2mdEmission, emitFile2mdKnowledge } from "../extensions/file2md.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

describe("buildFile2mdEmission", () => {
	test("produces the file2md knowledge payload shape", () => {
		const p = buildFile2mdEmission("my-doc", "/abs/vlm-out/my-doc");
		expect(p).toEqual({
			source: "generic",
			sourceLabel: "file2md:my-doc",
			dir: "/abs/vlm-out/my-doc",
		});
	});
});

describe("emitFile2mdKnowledge", () => {
	test("fires pi.events.emit on the pi:knowledge channel", () => {
		let called: { channel: string; data: unknown } | null = null;
		const pi = { events: { emit: (c: string, d: unknown) => (called = { channel: c, data: d }) } } as never;
		emitFile2mdKnowledge(pi, buildFile2mdEmission("d", "/x"));
		expect(called).not.toBeNull();
		expect(called!.channel).toBe("pi:knowledge");
		expect((called!.data as { dir: string }).dir).toBe("/x");
	});

	test("missing events bus → no-op, no throw", () => {
		const pi = { events: undefined } as never;
		expect(() => emitFile2mdKnowledge(pi, buildFile2mdEmission("d", "/x"))).not.toThrow();
	});

	test("throwing emit → swallowed, no throw", () => {
		const pi = { events: { emit: () => { throw new Error("boom"); } } } as never;
		expect(() => emitFile2mdKnowledge(pi, buildFile2mdEmission("d", "/x"))).not.toThrow();
	});
});

describe("ADR-0001 — no upward hub import", () => {
	test("file2md extension does not import knowledge-card", () => {
		const src = readFileSync(require("node:path").join(__dirname, "..", "extensions", "file2md.ts"), "utf8");
		expect(src).not.toContain("pi-agent-ext-knowledge-card");
	});
});
```

> Note: replace `require("node:path")` with an `import { join } from "node:path";` at the top of the test file if the linter flags `require` (Bun supports both; prefer the import).

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-file2md && bun test __tests__/knowledge-emit.test.ts )`
Expected: FAIL — `buildFile2mdEmission` / `emitFile2mdKnowledge` are not exported.

- [ ] **Step 3: Add the payload builder + safe-emit helper**

In `extensions/file2md.ts`, before the default-export factory (`export default function (pi: ExtensionAPI): void {`), add:

```ts
// ── pi:knowledge opt-in emit (ADR-0001: NO hub import) ────────────────────
// When `knowledge:true`, file2md emits on the "pi:knowledge" bus so the
// knowledge-card hub can converge the conversion into the shared graph. The
// channel name + payload shape are hardcoded HERE (not imported from the hub)
// to preserve the TIER-0 no-upward-edge invariant.
const KNOWLEDGE_CHANNEL = "pi:knowledge";

export interface File2mdKnowledgeEmission {
	source: "generic";
	sourceLabel: string;
	dir: string;
}

/** Build the bus payload for a conversion's output directory. Pure. */
export function buildFile2mdEmission(slug: string, dirAbs: string): File2mdKnowledgeEmission {
	return { source: "generic", sourceLabel: `file2md:${slug}`, dir: dirAbs };
}

/** Fire-and-forget emit on pi:knowledge. Best-effort: a missing/throwing bus
 *  MUST never break the conversion. */
export function emitFile2mdKnowledge(pi: ExtensionAPI, payload: File2mdKnowledgeEmission): void {
	try {
		(pi as { events?: { emit?: (c: string, d: unknown) => void } })
			.events?.emit?.(KNOWLEDGE_CHANNEL, payload);
	} catch {
		// swallow — never break the conversion over a knowledge emission
	}
}
```

- [ ] **Step 4: Add the `knowledge` param to the `file2md` tool schema**

In the `parameters: Type.Object({ … })` of the `file2md` tool (after the `mode:` param), add:

```ts
			knowledge: Type.Optional(
				Type.Boolean({
					description:
						"When true, emit this conversion on the pi:knowledge bus for the knowledge-card " +
						"hub to converge into the shared graph (deterministic generic ingest). Default false " +
						"(opt-in; protects graph quality).",
				}),
			),
```

- [ ] **Step 5: Emit after the pipeline writes, when `knowledge:true`**

In the `file2md` tool's `execute`, immediately after the `await runVlmDescribePipeline({ … });` call (and before `const { relative } = await import("node:path");`), add:

```ts
			if (params.knowledge) {
				emitFile2mdKnowledge(pi, buildFile2mdEmission(slug, resolve(outRootAbs, slug)));
			}
```

(`pi` is the factory parameter, in closure scope; `slug` and `outRootAbs` are already in scope; `resolve` is already imported from `node:path` at the top of `execute`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-file2md && bun test __tests__/knowledge-emit.test.ts )`
Expected: PASS — payload shape, all three safe-emit cases, and the no-hub-import guard all green.

- [ ] **Step 7: Run the full file2md suite (regression guard)**

Run: `( cd bun-apps/pi-agent-ext-file2md && bun test )`
Expected: PASS — existing file2md tests unchanged (the new param defaults to off → no behavior change).

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-file2md/extensions/file2md.ts bun-apps/pi-agent-ext-file2md/__tests__/knowledge-emit.test.ts
git commit -m "feat(file2md): opt-in knowledge flag + direct pi:knowledge emit (no hub import)"
```

---

## Verification (whole-feature)

After all four tasks land, confirm the two packages together and the schema-cost canary are clean:

- [ ] **Both packages green**
  ```bash
  ( cd bun-apps/pi-agent-ext-knowledge-card && bun test )
  ( cd bun-apps/pi-agent-ext-file2md && bun test )
  ```
- [ ] **No accidental upward dependency**
  ```bash
  grep -R "pi-agent-ext-knowledge-card" bun-apps/pi-agent-ext-file2md/src bun-apps/pi-agent-ext-file2md/extensions bun-apps/pi-agent-ext-file2md/package.json
  ```
  Expected: no matches (file2md never references the hub).
- [ ] **Biome lint both packages**
  ```bash
  ( cd bun-apps/pi-agent-ext-knowledge-card && bun run check 2>/dev/null || bunx biome check src extensions __tests__ )
  ( cd bun-apps/pi-agent-ext-file2md && bunx biome check src extensions __tests__ )
  ```

## Self-Review (run before handoff)

- **Spec coverage:** Ticket 05 (sink) → Tasks 1–3 (contract + router + subscriber). Ticket 06 (file2md emit) → Task 4. Decision 04-A (direct emit) honored by `emitFile2mdKnowledge` + the no-import guard. Decision 04-B (`dir` payload) honored by `KnowledgeEmission.dir` + the router's dir branch. Decisions 01 (deterministic generic) + 02 (opt-in default off) + 03 (wire the bus) all reflected. ✔
- **Placeholder scan:** every code step contains real code; test steps contain real assertions. No TBD/TODO/"add error handling". ✔
- **Type consistency:** `convergeKnowledgeEmission(payload, opts)` signature is identical in Task 2 (definition), Task 3 (call). `buildFile2mdEmission` / `emitFile2mdKnowledge` identical in Task 4 test + impl. `KnowledgeEmission.dir` added once (Task 1), read by the gate (Task 1) + router (Task 2). `File2mdKnowledgeEmission` shape matches the sink's expected `{source, sourceLabel, dir}`. ✔

## Execution Handoff

Plan complete and saved to `.planning/plans/2026-08-01-file2md-knowledge-convergence.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
