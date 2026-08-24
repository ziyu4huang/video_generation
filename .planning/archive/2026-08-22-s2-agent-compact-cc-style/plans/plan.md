# s2-agent-ext-compact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace s2-agent's built-in `/compact` summary content with a Claude Code-style 9-section summary (plus pi-smart-compact hints), behind a single `session_before_compact` hook that degrades to the built-in compaction on any error; ship an offline A/B replay harness that proves it against the real built-in implementation.

**Architecture:** One new extension package `bun-apps/s2-agent-ext-compact` (static load, deploy order 150). The hook returns `{ compaction: { summary, firstKeptEntryId, tokensBefore, … } }` reusing the host's cut point verbatim; every failure path returns `undefined` → host falls back to built-in `compact()`. Pure modules (config / file-ops / session-type / user-messages / prompt) are unit-tested; the single LLM call goes through `completeSimple` from `@earendil-works/pi-ai/compat` (the hermes-memory pattern). `scripts/ab.ts` replays real sessions from `~/.pi/agent/sessions` through both the host's own `generateSummaryWithUsage` (arm A) and our prompt (arm B).

**Tech Stack:** Bun + TypeScript (strict), `bun:test`, `@earendil-works/pi-coding-agent@0.84.2` + `@earendil-works/pi-ai@0.84.2` (peer deps), `@repo/s2-agent-core-runtime` (workspace, A/B harness tier resolution only).

**Spec:** `.planning/s2-agent-compact-cc-style/spec.md`

## Global Constraints

- Scripts MUST be named exactly `test` (`bun test`) and `typecheck` (`tsc --noEmit`) — local_ci resolves gates by script NAME.
- Package tsconfig `include` MUST cover `extensions/**/*.ts` (guard: `bun-apps/tests/extension-entry-typechecked.test.ts`).
- `load: static` means the entry is literally imported by `bun-apps/s2-agent/src/static-extensions.ts` → the whole package must ALSO typecheck under s2-agent's tsconfig (run `bun run --cwd bun-apps/s2-agent typecheck` before finishing).
- `bun-apps/s2-agent/run-dir/manifest.json` is DERIVED — only edit `bun-apps/s2-agent/src/registry-config.ts`, then `bun run --cwd bun-apps/s2-agent regen:manifest` (scaffold does this).
- Deploy `order` values 10–140 are taken; this package uses `order: 150` (uniqueness enforced by `registry.ts:195-202`).
- Deep imports under `@earendil-works/pi-coding-agent/dist/...` are BLOCKED by its `exports` field — only root exports are importable. `completeSummarization` and `SUMMARIZATION_SYSTEM_PROMPT` are NOT root-exported; that is why this package ships its own system prompt and calls `completeSimple` directly.
- Never edit vendor code; no top-level `cd` — use `( cd <dir> && ... )` or `--cwd`.
- Deps added only via `bun add` inside `bun-apps/`; commit messages in English, Co-Authored-By Claude trailer.
- Peer dep versions pinned exactly: `"@earendil-works/pi-coding-agent": "0.84.2"`, `"@earendil-works/pi-ai": "0.84.2"`, `"@repo/s2-agent-core-runtime": "workspace:*"` (devDependencies for the workspace one — hermes-memory precedent).

## Verified host facts (all citations from installed 0.84.2, do not re-derive)

- `SessionBeforeCompactEvent` (`dist/core/extensions/types.d.ts:441-452`): `{ type, preparation: CompactionPreparation, branchEntries: SessionEntry[], customInstructions?: string, reason: "manual"|"threshold"|"overflow", willRetry: boolean, signal: AbortSignal }`.
- `CompactionPreparation` (`dist/core/compaction/compaction.d.ts:111-127`): `{ firstKeptEntryId: string, messagesToSummarize: AgentMessage[], turnPrefixMessages: AgentMessage[], isSplitTurn: boolean, tokensBefore: number, previousSummary?: string, fileOps: { read: Set<string>, written: Set<string>, edited: Set<string> }, settings: { enabled, reserveTokens, keepRecentTokens } }`.
- Handler return `SessionBeforeCompactResult` (`types.d.ts:818-821`): `{ cancel?: boolean, compaction?: { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter?, usage?, details? } }`.
- `emit()` (`dist/core/extensions/runner.js:579-607`): for session_before_* events the LAST truthy handler result wins; a handler throw is swallowed → `undefined` → host falls back to built-in `compact(preparation, …)` (`dist/core/agent-session.js:1389-1415`).
- Root exports of `@earendil-works/pi-coding-agent` we use: `convertToLlm`, `serializeConversation`, `generateSummaryWithUsage`, `findCutPoint`, `parseSessionEntries`, `sessionEntryToContextMessages`, `getLatestCompactionEntry`, `estimateTokens`, `ModelRegistry`, `createAgentSessionServices`, type `ExtensionFactory`.
- `generateSummaryWithUsage(currentMessages, model, reserveTokens, apiKey, headers?, signal?, customInstructions?, previousSummary?, …)` → `{ text, usage }`; internally `maxTokens = min(floor(0.8 × reserveTokens), model.maxTokens)`; `customInstructions` appended as `\n\nAdditional focus: ${customInstructions}`; conversation wrapped in `<conversation>` tags.
- `ctx` (`ExtensionContext`) exposes `cwd`, `model: Model<any> | undefined`, `modelRegistry: ModelRegistry` (with `find(provider, id)`, `getAll()`, `getApiKeyAndHeaders(model)`), `notify(message, type?)`.
- `completeSimple(model, { systemPrompt, messages }, options)` from `@earendil-works/pi-ai/compat` (hermes-memory precedent, `src/handlers/review-memory-ops.ts:420`); options `{ apiKey, headers, env, signal, maxTokens }`; returns `AssistantMessage` with `stopReason`, `content`, `usage`.
- ToolCall content block (`@earendil-works/pi-ai/dist/types.d.ts:246-254`): `{ type: "toolCall", id, name, arguments: Record<string, any> }` inside assistant-message `content` arrays.
- Session files: `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl`; `parseSessionEntries(content)` splits lines and JSON-parses each; first line = `SessionHeader`, message entries are `{ type: "message", message: AgentMessage, … }`.

---

### Task 1: Scaffold package + registry deploy wiring

**Files:**
- Create: `bun-apps/s2-agent-ext-compact/` (scaffold output)
- Modify: `bun-apps/s2-agent/src/registry-config.ts` (compact entry)
- Derived (regen, never hand-edit): `bun-apps/s2-agent/run-dir/manifest.json`, `bun-apps/s2-agent/src/static-extensions.ts`

**Interfaces:**
- Produces: package `@repo/s2-agent-ext-compact`, entry `extensions/compact.ts` default-exporting an `ExtensionFactory`; registry entry `name: compact`, `load: static`, `deploy: { order: 150 }`. Later tasks replace the scaffold stub entry body.

- [ ] **Step 1: Scaffold**

```bash
bun bun-apps/s2-agent/src/cli.ts ext new compact --lib --register static
```

Scaffold writes package.json, tsconfig.json, `extensions/compact.ts`, `extensions/__tests__/entry-smoke.test.ts`, README.md, appends a registry entry carrying `excludeReason: not yet curated for the portable set`, and runs `regen:manifest` + `regen:static`.

- [ ] **Step 2: Fix package.json peer deps**

The scaffold only knows pi-coding-agent. Edit `bun-apps/s2-agent-ext-compact/package.json` `peerDependencies` to exactly:

```json
"peerDependencies": {
  "@earendil-works/pi-ai": "0.84.2",
  "@earendil-works/pi-coding-agent": "0.84.2"
}
```

and add `"@repo/s2-agent-core-runtime": "workspace:*"` to `devDependencies` (needed by Task 9's harness only; `bun add -d @repo/s2-agent-core-runtime` from `bun-apps/` is the canonical way — never hand-edit `bun-apps/bun.lock`).

- [ ] **Step 3: Registry entry — replace excludeReason with deploy**

In `bun-apps/s2-agent/src/registry-config.ts`, replace the scaffold's compact entry with:

```yaml
  - name: compact
    package: s2-agent-ext-compact
    entry: extensions/compact.ts
    load: static
    # Pure code: imports only pi-coding-agent / pi-ai + node builtins.
    deploy:
      order: 150
```

- [ ] **Step 4: Regen + install**

```bash
bun run --cwd bun-apps/s2-agent regen:manifest
bun run --cwd bun-apps/s2-agent regen:static
( cd bun-apps && bun install )
```

- [ ] **Step 5: Verify scaffold gates**

```bash
bun run --cwd bun-apps/s2-agent-ext-compact test        # entry-smoke passes
bun run --cwd bun-apps/s2-agent-ext-compact typecheck
bun run --cwd bun-apps/s2-agent typecheck               # cross-package: imports our entry
```

Expected: all PASS. If cross-package typecheck fails on the stub entry, fix the entry, not s2-agent.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/s2-agent-ext-compact bun-apps/s2-agent/src/registry-config.ts bun-apps/s2-agent/run-dir/manifest.json bun-apps/s2-agent/src/static-extensions.ts bun-apps/bun.lock
git commit -m "feat(compact): scaffold s2-agent-ext-compact — static + deploy order 150"
```

---

### Task 2: src/config.ts — env-parsed runtime config

**Files:**
- Create: `bun-apps/s2-agent-ext-compact/src/config.ts`
- Test: `bun-apps/s2-agent-ext-compact/src/config.test.ts`

**Interfaces:**
- Produces: `interface CompactConfig { enabled: boolean; modelOverrideSpec: string | undefined; maxTokensFactor: number }`; `loadCompactConfig(env?: Record<string, string | undefined>): CompactConfig`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { loadCompactConfig } from "./config.ts";

describe("loadCompactConfig", () => {
  test("defaults: enabled, no override, 0.8 factor", () => {
    const c = loadCompactConfig({});
    expect(c.enabled).toBe(true);
    expect(c.modelOverrideSpec).toBeUndefined();
    expect(c.maxTokensFactor).toBe(0.8);
  });

  test("BUN_PI_COMPACT=0 disables", () => {
    expect(loadCompactConfig({ BUN_PI_COMPACT: "0" }).enabled).toBe(false);
    expect(loadCompactConfig({ BUN_PI_COMPACT: "1" }).enabled).toBe(true);
  });

  test("COMPACT_MODEL override, trimmed, empty means unset", () => {
    expect(loadCompactConfig({ COMPACT_MODEL: "zai/glm-5.3" }).modelOverrideSpec).toBe("zai/glm-5.3");
    expect(loadCompactConfig({ COMPACT_MODEL: "   " }).modelOverrideSpec).toBeUndefined();
  });

  test("COMPACT_MAX_TOKENS_FACTOR clamped to [0.1, 1]", () => {
    expect(loadCompactConfig({ COMPACT_MAX_TOKENS_FACTOR: "0.5" }).maxTokensFactor).toBe(0.5);
    expect(loadCompactConfig({ COMPACT_MAX_TOKENS_FACTOR: "9" }).maxTokensFactor).toBe(1);
    expect(loadCompactConfig({ COMPACT_MAX_TOKENS_FACTOR: "0" }).maxTokensFactor).toBe(0.1);
    expect(loadCompactConfig({ COMPACT_MAX_TOKENS_FACTOR: "junk" }).maxTokensFactor).toBe(0.8);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run --cwd bun-apps/s2-agent-ext-compact test`
Expected: FAIL — `Cannot find module './config.ts'`.

- [ ] **Step 3: Implement**

```ts
/** Runtime configuration for s2-agent-ext-compact, parsed once from env. */
export interface CompactConfig {
  /** BUN_PI_COMPACT=0 disables the extension entirely (scaffold self-gate convention). */
  enabled: boolean;
  /** "provider/model-id[:thinking]" overriding the session model for summarization. */
  modelOverrideSpec: string | undefined;
  /** Fraction of reserveTokens usable for the summary (host built-in uses 0.8). */
  maxTokensFactor: number;
}

export function loadCompactConfig(
  env: Record<string, string | undefined> = process.env,
): CompactConfig {
  const raw = Number.parseFloat(env.COMPACT_MAX_TOKENS_FACTOR ?? "");
  const factor = Number.isFinite(raw) ? Math.min(1, Math.max(0.1, raw)) : 0.8;
  return {
    enabled: env.BUN_PI_COMPACT !== "0",
    modelOverrideSpec: env.COMPACT_MODEL?.trim() || undefined,
    maxTokensFactor: factor,
  };
}
```

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `git add bun-apps/s2-agent-ext-compact/src/config.ts bun-apps/s2-agent-ext-compact/src/config.test.ts && git commit -m "feat(compact): env-parsed config — enable gate, model override, token factor"`

---

### Task 3: src/file-ops.ts — deterministic file-operation extraction

**Files:**
- Create: `bun-apps/s2-agent-ext-compact/src/file-ops.ts`
- Test: `bun-apps/s2-agent-ext-compact/src/file-ops.test.ts`

**Interfaces:**
- Consumes: `Message` from `@earendil-works/pi-ai` (assistant `content` may contain `{ type: "toolCall", name, arguments }` blocks); host `preparation.fileOps` (`{ read: Set<string>, written: Set<string>, edited: Set<string> }`).
- Produces:
  - `interface FileOpsSummary { read: string[]; written: string[]; edited: string[] }` (each sorted, deduped)
  - `extractFileOps(messages: readonly Message[], hostFileOps?: HostFileOps): FileOpsSummary`
  - `verifiedFilesBlock(ops: FileOpsSummary): string` — the `<verified-files>` ground-truth block
  - `allFiles(ops: FileOpsSummary): string[]`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { extractFileOps, verifiedFilesBlock, allFiles } from "./file-ops.ts";

const msg = (calls: Array<{ name: string; arguments: Record<string, unknown> }>) => ({
  role: "assistant" as const,
  content: calls.map((c, i) => ({ type: "toolCall" as const, id: `t${i}`, ...c })),
});

describe("extractFileOps", () => {
  test("buckets by tool name, dedupes and sorts", () => {
    const ops = extractFileOps([
      msg([{ name: "read", arguments: { path: "b.ts" } }, { name: "read", arguments: path: "a.ts" } }]),
      msg([{ name: "edit", arguments: { file_path: "c.ts" } }]),
      msg([{ name: "write", arguments: { path: "d.ts" } }]),
      msg([{ name: "multi_edit", arguments: { edits: [{ path: "e.ts" }, { path: "c.ts" }] } }]),
    ]);
    expect(ops).toEqual({ read: ["a.ts", "b.ts"], edited: ["c.ts", "e.ts"], written: ["d.ts"] });
  });

  test("unknown tool names ignored; user messages ignored", () => {
    const ops = extractFileOps([
      { role: "user", content: [{ type: "text", text: "edit foo" }] } as never,
      msg([{ name: "bash", arguments: { command: "rm -rf" } }]),
    ]);
    expect(allFiles(ops)).toEqual([]);
  });

  test("merges host fileOps sets", () => {
    const ops = extractFileOps([msg([{ name: "read", arguments: { path: "x.ts" } }])], {
      read: new Set(["host.ts"]),
      written: new Set(),
      edited: new Set(),
    });
    expect(ops.read).toEqual(["host.ts", "x.ts"]);
  });
});

describe("verifiedFilesBlock", () => {
  test("renders sections with (none) placeholders", () => {
    expect(verifiedFilesBlock({ read: [], written: [], edited: ["a.ts"] })).toBe(
      "<verified-files>\nEdited: a.ts\nRead: (none)\nWritten: (none)\n</verified-files>",
    );
  });
});
```

(Note: fix the deliberate `path: "a.ts"` shorthand above into proper `{ path: "a.ts" }` object syntax when writing the real file.)

- [ ] **Step 2: Run to verify failure** — `bun run --cwd bun-apps/s2-agent-ext-compact test` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
import type { Message } from "@earendil-works/pi-ai";

/** Host preparation.fileOps shape (Set-backed). */
export interface HostFileOps {
  read: Iterable<string>;
  written: Iterable<string>;
  edited: Iterable<string>;
}

export interface FileOpsSummary {
  readonly read: string[];
  readonly written: string[];
  readonly edited: string[];
}

const WRITE_TOOLS = new Set(["write", "write_file", "create_file"]);
const EDIT_TOOLS = new Set(["edit", "edit_file", "multi_edit", "patch", "apply_patch"]);
const READ_TOOLS = new Set(["read", "read_file", "glob", "grep", "ls"]);

/** Path-like argument keys across the tool families used in this repo. */
const PATH_KEYS = ["path", "file_path", "filePath", "filename", "notebook_path"] as const;

function collectPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v) out.push(v);
  }
  if (Array.isArray(args.edits)) {
    for (const e of args.edits) {
      const p = (e as Record<string, unknown> | null)?.path ?? (e as Record<string, unknown> | null)?.file_path;
      if (typeof p === "string") out.push(p);
    }
  }
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (typeof f === "string") out.push(f);
      else {
        const p = (f as Record<string, unknown> | null)?.path;
        if (typeof p === "string") out.push(p);
      }
    }
  }
  return out;
}

type ToolCallBlock = { type: "toolCall"; name: string; arguments: Record<string, unknown> };

export function extractFileOps(messages: readonly Message[], hostFileOps?: HostFileOps): FileOpsSummary {
  const read = new Set<string>(hostFileOps?.read ?? []);
  const written = new Set<string>(hostFileOps?.written ?? []);
  const edited = new Set<string>(hostFileOps?.edited ?? []);
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const call = block as unknown as ToolCallBlock | null;
      if (!call || call.type !== "toolCall" || typeof call.name !== "string") continue;
      const bucket = WRITE_TOOLS.has(call.name)
        ? written
        : EDIT_TOOLS.has(call.name)
          ? edited
          : READ_TOOLS.has(call.name)
            ? read
            : undefined;
      if (!bucket) continue;
      for (const p of collectPaths(call.arguments ?? {})) bucket.add(p);
    }
  }
  return { read: [...read].sort(), written: [...written].sort(), edited: [...edited].sort() };
}

export function allFiles(ops: FileOpsSummary): string[] {
  return [...new Set([...ops.read, ...ops.edited, ...ops.written])].sort();
}

export function verifiedFilesBlock(ops: FileOpsSummary): string {
  const line = (label: string, files: readonly string[]) => `${label}: ${files.length ? files.join(", ") : "(none)"}`;
  return `<verified-files>\n${line("Edited", ops.edited)}\n${line("Read", ops.read)}\n${line("Written", ops.written)}\n</verified-files>`;
}
```

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(compact): deterministic file-op extraction + verified-files block`

---

### Task 4: src/session-type.ts — session-type inference

**Files:**
- Create: `bun-apps/s2-agent-ext-compact/src/session-type.ts`
- Test: `bun-apps/s2-agent-ext-compact/src/session-type.test.ts`

**Interfaces:**
- Consumes: tool names (from Task 3 traversal — pass the same `messages` and reuse `extractFileOps`-style scanning, or simply accept `toolNames: string[]`); error strings from the conversation text.
- Produces: `type SessionType = "implementation" | "debugging" | "review" | "discussion"`; `inferSessionType(input: { toolNames: readonly string[]; conversationText: string }): SessionType`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { inferSessionType } from "./session-type.ts";

describe("inferSessionType", () => {
  test("no tools → discussion", () => {
    expect(inferSessionType({ toolNames: [], conversationText: "" })).toBe("discussion");
  });
  test("read-only tools only → review (pi-smart-compact hint: read-only ≠ implementation)", () => {
    expect(inferSessionType({ toolNames: ["read", "grep", "ls"], conversationText: "" })).toBe("review");
  });
  test("edit tools + test-failure signal → debugging", () => {
    expect(inferSessionType({ toolNames: ["edit", "read"], conversationText: "FAIL tests/foo.test.ts\nError: expected 1" })).toBe("debugging");
  });
  test("edit tools, no failure signal → implementation", () => {
    expect(inferSessionType({ toolNames: ["edit", "read"], conversationText: "all good" })).toBe("implementation");
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
import { extractFileOps } from "./file-ops.ts";
import type { Message } from "@earendil-works/pi-ai";

export type SessionType = "implementation" | "debugging" | "review" | "discussion";

const ERROR_SIGNALS = [
  "error:", "failed", "fail:", "failing", "traceback", "exception",
  "✗", "✘", "x tests failed", "not ok ",
] as const;

/** Tool names that mutate state — their presence means hands-on work happened. */
const MUTATING_TOOLS = new Set(["edit", "edit_file", "write", "write_file", "create_file", "multi_edit", "patch", "apply_patch", "bash"]);

export function toolNamesIn(messages: readonly Message[]): string[] {
  const names = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const call = block as unknown as { type: string; name?: unknown } | null;
      if (call?.type === "toolCall" && typeof call.name === "string") names.add(call.name);
    }
  }
  return [...names];
}

export function inferSessionType(input: {
  toolNames: readonly string[];
  conversationText: string;
}): SessionType {
  const tools = input.toolNames.map((t) => t.toLowerCase());
  if (tools.length === 0) return "discussion";
  const lower = input.conversationText.toLowerCase();
  const hasErrors = ERROR_SIGNALS.some((s) => lower.includes(s));
  const mutating = tools.some((t) => MUTATING_TOOLS.has(t));
  if (!mutating) return "review";
  if (hasErrors) return "debugging";
  return "implementation";
}
```

(Also export `toolNamesIn` from this module and reuse it — Task 3's `extractFileOps` already scans blocks independently; that duplication is deliberate, both are 10-line walks.)

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(compact): session-type inference — read-only means review`

---

### Task 5: src/user-messages.ts — verbatim user-message collection

**Files:**
- Create: `bun-apps/s2-agent-ext-compact/src/user-messages.ts`
- Test: `bun-apps/s2-agent-ext-compact/src/user-messages.test.ts`

**Interfaces:**
- Produces:
  - `const MAX_USER_MESSAGES = 50`, `const MAX_MESSAGE_CHARS = 2000`
  - `interface CollectedUserMessage { index: number; text: string; truncated: boolean }`
  - `collectUserMessages(messages: readonly Message[], max?, maxChars?): CollectedUserMessage[]`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { collectUserMessages } from "./user-messages.ts";

const user = (text: string) =>
  ({ role: "user", content: [{ type: "text", text }] }) as never;
const assistant = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as never;

describe("collectUserMessages", () => {
  test("collects user text verbatim, numbered 1-based, skips assistants", () => {
    const out = collectUserMessages([user("fix the bug"), assistant("ok"), user("thanks")]);
    expect(out).toEqual([
      { index: 1, text: "fix the bug", truncated: false },
      { index: 2, text: "thanks", truncated: false },
    ]);
  });
  test("truncates over maxChars", () => {
    const out = collectUserMessages([user("a".repeat(50))], 50, 10);
    expect(out[0].truncated).toBe(true);
    expect(out[0].text.length).toBeLessThanOrEqual(20);
    expect(out[0].text.startsWith("aaaaaaaa")).toBe(true);
  });
  test("caps at max messages", () => {
    const many = Array.from({ length: 60 }, (_, i) => user(`m${i}`));
    expect(collectUserMessages(many).length).toBe(50);
  });
  test("skips empty/whitespace and non-text user content", () => {
    const out = collectUserMessages([user("   "), { role: "user", content: [{ type: "toolResult", id: "t" }] } as never]);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
import type { Message } from "@earendil-works/pi-ai";

export const MAX_USER_MESSAGES = 50;
export const MAX_MESSAGE_CHARS = 2000;

export interface CollectedUserMessage {
  readonly index: number;
  readonly text: string;
  readonly truncated: boolean;
}

function userText(message: Message): string | undefined {
  if (message.role !== "user" || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string } | null)?.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || undefined;
}

export function collectUserMessages(
  messages: readonly Message[],
  max: number = MAX_USER_MESSAGES,
  maxChars: number = MAX_MESSAGE_CHARS,
): CollectedUserMessage[] {
  const out: CollectedUserMessage[] = [];
  for (const m of messages) {
    if (out.length >= max) break;
    const text = userText(m);
    if (text === undefined) continue;
    const truncated = text.length > maxChars;
    out.push({
      index: out.length + 1,
      text: truncated ? `${text.slice(0, maxChars)}…[truncated]` : text,
      truncated,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(compact): verbatim capped user-message collection`

---

### Task 6: src/prompt.ts — CC-style prompt assembly

**Files:**
- Create: `bun-apps/s2-agent-ext-compact/src/prompt.ts`
- Test: `bun-apps/s2-agent-ext-compact/src/prompt.test.ts`

**Interfaces:**
- Consumes: `FileOpsSummary`/`verifiedFilesBlock` (Task 3), `SessionType` (Task 4), `CollectedUserMessage` (Task 5).
- Produces:
  - `SECTION_TITLES: readonly string[]` (the 9 CC sections, in order)
  - `interface PromptInput { conversationText: string; previousSummary?: string; customInstructions?: string; fileOps: FileOpsSummary; sessionType: SessionType; userMessages: readonly CollectedUserMessage[] }`
  - `buildSystemPrompt(): string`
  - `buildUserPrompt(input: PromptInput): string`
  - `extractSummary(raw: string): string` — pulls `<summary>…</summary>`, falls back to whole text

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, buildUserPrompt, extractSummary, SECTION_TITLES } from "./prompt.ts";

const base = {
  conversationText: "user: hello\nassistant: hi",
  fileOps: { read: ["a.ts"], written: [], edited: ["b.ts"] },
  sessionType: "implementation" as const,
  userMessages: [{ index: 1, text: "hello", truncated: false }],
};

describe("SECTION_TITLES", () => {
  test("nine CC sections in order", () => {
    expect(SECTION_TITLES).toEqual([
      "Primary Request and Intent",
      "Key Technical Concepts",
      "Files and Code Sections",
      "Errors and fixes",
      "Problem Solving",
      "All user messages",
      "Pending Tasks",
      "Current Work",
      "Optional Next Step",
    ]);
  });
});

describe("buildUserPrompt", () => {
  test("verified-files above conversation; sections listed; hints present", () => {
    const p = buildUserPrompt(base);
    expect(p.indexOf("<verified-files>")).toBeLessThan(p.indexOf("<conversation>"));
    expect(p).toContain("Edited: b.ts");
    expect(p).toContain("Additional evidence rule");
    expect(p).not.toContain("<previous-summary>");
  });
  test("previousSummary switches to UPDATE variant", () => {
    const p = buildUserPrompt({ ...base, previousSummary: "old summary" });
    expect(p).toContain("<previous-summary>");
    expect(p).toContain("PRESERVE");
  });
  test("customInstructions appended as Additional focus", () => {
    expect(buildUserPrompt({ ...base, customInstructions: "focus on auth" })).toContain(
      "Additional focus: focus on auth",
    );
  });
  test("session-type directive rendered", () => {
    expect(buildUserPrompt(base)).toContain("IMPLEMENTATION");
    expect(buildUserPrompt({ ...base, sessionType: "review" })).toContain("REVIEW");
  });
});

describe("extractSummary", () => {
  test("pulls summary block", () => {
    expect(extractSummary("<analysis>x</analysis>\n<summary>\nbody\n</summary>")).toBe("\nbody\n");
  });
  test("falls back to whole text without tags", () => {
    expect(extractSummary("just text")).toBe("just text");
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
import { verifiedFilesBlock, type FileOpsSummary } from "./file-ops.ts";
import type { SessionType } from "./session-type.ts";
import type { CollectedUserMessage } from "./user-messages.ts";

export const SECTION_TITLES = [
  "Primary Request and Intent",
  "Key Technical Concepts",
  "Files and Code Sections",
  "Errors and fixes",
  "Problem Solving",
  "All user messages",
  "Pending Tasks",
  "Current Work",
  "Optional Next Step",
] as const;

const SESSION_TYPE_DIRECTIVES: Record<SessionType, string> = {
  implementation: "This is an IMPLEMENTATION session: weight sections toward concrete code state, file changes, and remaining work.",
  debugging: "This is a DEBUGGING session: weight sections toward error symptoms, root-cause hypotheses tested, and which fixes were verified.",
  review: "This is a REVIEW session (read-only tools): do NOT claim code was changed. Report findings and verdicts, never implementation progress.",
  discussion: "This is a DISCUSSION session with no tool use: weight sections toward decisions, constraints, and open questions.",
};

export function buildSystemPrompt(): string {
  return [
    "You are a context summarization assistant. Read the conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified in the user message.",
    "Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the <analysis> section followed by the <summary> section.",
  ].join("\n\n");
}

export interface PromptInput {
  conversationText: string;
  previousSummary?: string;
  customInstructions?: string;
  fileOps: FileOpsSummary;
  sessionType: SessionType;
  userMessages: readonly CollectedUserMessage[];
}

export function buildUserPrompt(input: PromptInput): string {
  const parts: string[] = [];
  parts.push(verifiedFilesBlock(input.fileOps));
  parts.push(`<conversation>\n${input.conversationText}\n</conversation>`);
  if (input.previousSummary) {
    parts.push(`<previous-summary>\n${input.previousSummary}\n</previous-summary>`);
  }
  if (input.userMessages.length > 0) {
    parts.push(
      `<user-messages>\n${input.userMessages.map((m) => `[${m.index}] ${m.text}`).join("\n")}\n</user-messages>`,
    );
  }

  const sections = SECTION_TITLES.map((t) => `- ${t}`).join("\n");
  const lines: string[] = [
    "Summarize the conversation for a future assistant session that will continue this work with NO other context.",
    "",
    "Step 1 — <analysis>: before writing the summary, reason section by section about what must be captured. Check each section title against the conversation. This is your self-check scratchpad.",
    `Step 2 — <summary>: output exactly these sections, in order, each as a markdown level-2 heading:\n${sections}`,
    "",
    "Hard rules:",
    `1. Ground truth: the file list in <verified-files> was extracted deterministically from actual tool calls. Section "Files and Code Sections" may ONLY reference paths that appear in <verified-files> or verbatim inside <conversation>. Never invent or guess a path.`,
    `2. Section "All user messages" preserves the user's requests VERBATIM (word-for-word, in order). Use the <user-messages> block as the authoritative copy.`,
    "3. Exact identifiers: preserve code identifiers (function, variable, file, test names) character-for-character. Never paraphrase or translate them.",
    `4. Additional evidence rule: mark something Done ONLY with evidence — a passing test run or explicit user confirmation shown in the conversation. Otherwise it stays under Pending Tasks.`,
    `5. Quote the latest exchange: "Current Work" and "Optional Next Step" must be grounded in the most recent turns of the conversation, quoting the user's last message where relevant.`,
    SESSION_TYPE_DIRECTIVES[input.sessionType],
  ];
  if (input.previousSummary) {
    lines.push(
      "6. UPDATE mode: a <previous-summary> is provided. PRESERVE the information it already contains, ADD new progress, UPDATE statuses (In Progress → Done only with evidence), refresh Next Steps, and drop only items that became irrelevant.",
    );
  }
  if (input.customInstructions) {
    lines.push(`\nAdditional focus: ${input.customInstructions}`);
  }
  parts.push(lines.join("\n"));
  return parts.join("\n\n");
}

export function extractSummary(raw: string): string {
  const match = raw.match(/<summary>([\s\S]*?)<\/summary>/);
  return match ? match[1].trim() : raw.trim();
}
```

Note: `SECTION_TITLES` is typed `as const` (a readonly tuple) — the interface declares `readonly string[]`, which the tuple satisfies.

- [ ] **Step 4: Run tests** — Expected: PASS (also re-run Tasks 2–5 tests to confirm no regressions).

- [ ] **Step 5: Commit** — `feat(compact): CC-style 9-section prompt with verified-files ground truth`

---

### Task 7: src/model.ts + src/summarize.ts — model resolution and the single LLM call

**Files:**
- Create: `bun-apps/s2-agent-ext-compact/src/model.ts`
- Create: `bun-apps/s2-agent-ext-compact/src/summarize.ts`
- Test: `bun-apps/s2-agent-ext-compact/src/model.test.ts`
- Test: `bun-apps/s2-agent-ext-compact/src/summarize.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6; `completeSimple` from `@earendil-works/pi-ai/compat`; `convertToLlm` + `serializeConversation` from `@earendil-works/pi-coding-agent`.
- Produces:
  - `pickModel(ctx: { model?: ModelApi | undefined; modelRegistry: { find(provider: string, id: string): ModelApi | undefined } }, overrideSpec: string | undefined): ModelApi | undefined`
  - `summarizeCcStyle(request: SummarizeRequest, model: ModelApi, auth: ModelAuth, options?: SummarizeOptions): Promise<CcSummaryResult>` where
    - `SummarizeRequest = { messages: readonly Message[]; previousSummary?: string; customInstructions?: string; reserveTokens: number; signal: AbortSignal }`
    - `ModelAuth = { apiKey: string; headers?: Record<string, string>; env?: Record<string, string> }`
    - `SummarizeOptions = { maxTokensFactor?: number; complete?: typeof completeSimple }` (test seam)
    - `CcSummaryResult = { summary: string; usage: Usage | undefined; sessionType: SessionType; fileOps: FileOpsSummary }`

- [ ] **Step 1: Write failing tests — model.test.ts**

```ts
import { describe, expect, test } from "bun:test";
import { pickModel } from "./model.ts";

const registry = (models: Array<{ provider: string; id: string }>) => ({
  find: (provider: string, id: string) =>
    models.find((m) => m.provider === provider && m.id === id) as never,
});

describe("pickModel", () => {
  test("override spec resolved via registry (thinking suffix stripped)", () => {
    const ctxModel = { provider: "zai", id: "default" };
    const m = pickModel(
      { model: ctxModel as never, modelRegistry: registry([{ provider: "zai", id: "glm-5.3" }]) },
      "zai/glm-5.3:high",
    );
    expect(m?.id).toBe("glm-5.3");
  });
  test("unresolvable override falls back to session model", () => {
    const ctxModel = { provider: "zai", id: "default" };
    const m = pickModel({ model: ctxModel as never, modelRegistry: registry([]) }, "nope/x");
    expect(m?.id).toBe("default");
  });
  test("no override → session model; none → undefined", () => {
    const ctxModel = { provider: "zai", id: "default" };
    expect(pickModel({ model: ctxModel as never, modelRegistry: registry([]) }, undefined)?.id).toBe("default");
    expect(pickModel({ model: undefined, modelRegistry: registry([]) }, undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Write failing tests — summarize.test.ts**

```ts
import { describe, expect, test } from "bun:test";
import { summarizeCcStyle } from "./summarize.ts";

const model = {
  provider: "zai",
  id: "glm-5.3",
  maxTokens: 100000,
} as never;

const messages = [
  { role: "user" as const, content: [{ type: "text" as const, text: "fix the failing test" }] },
] as never;

const fakeComplete = (over: Partial<{ stopReason: string; text: string; usage: object }> = {}) =>
  (async () => ({
    stopReason: over.stopReason ?? "stop",
    usage: over.usage ?? { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 },
    content: [{ type: "text" as const, text: over.text ?? "<analysis>a</analysis><summary>done</summary>" }],
  })) as never;

describe("summarizeCcStyle", () => {
  test("happy path: returns extracted summary + usage + sessionType", async () => {
    const r = await summarizeCcStyle(
      { messages, previousSummary: undefined, customInstructions: "auth focus", reserveTokens: 16000, signal: new AbortController().signal },
      model,
      { apiKey: "k" },
      { complete: fakeComplete() as never },
    );
    expect(r.summary).toBe("done");
    expect(r.sessionType).toBe("discussion"); // no tool calls in fixture
    expect(r.usage?.input).toBe(10);
  });
  test("throws on stopReason error (hook will catch → built-in fallback)", async () => {
    await expect(
      summarizeCcStyle(
        { messages, reserveTokens: 16000, signal: new AbortController().signal },
        model,
        { apiKey: "k" },
        { complete: fakeComplete({ stopReason: "error" }) as never },
      ),
    ).rejects.toThrow(/Summarization failed/);
  });
  test("maxTokens = min(floor(factor × reserveTokens), model.maxTokens)", async () => {
    let seen: Record<string, unknown> = {};
    const spy = (async (_m: unknown, _c: unknown, opts: unknown) => {
      seen = opts as Record<string, unknown>;
      return fakeComplete()();
    }) as never;
    // floor(0.5 × 1000) = 500, but model.maxTokens = 100 caps it → 100.
    await summarizeCcStyle(
      { messages, reserveTokens: 1000, signal: new AbortController().signal },
      { ...model, maxTokens: 100 } as never,
      { apiKey: "k" },
      { maxTokensFactor: 0.5, complete: spy },
    );
    expect(seen.maxTokens).toBe(100);
    // Without the model cap, the factor × reserveTokens floor wins → 500.
    await summarizeCcStyle(
      { messages, reserveTokens: 1000, signal: new AbortController().signal },
      model,
      { apiKey: "k" },
      { maxTokensFactor: 0.5, complete: spy },
    );
    expect(seen.maxTokens).toBe(500);
  });
});
```

- [ ] **Step 3: Run to verify failure** — FAIL (both modules missing).

- [ ] **Step 4: Implement src/model.ts**

```ts
import type { Model, Api } from "@earendil-works/pi-ai";

export type ModelApi = Model<Api>;

export interface ModelLookup {
  find(provider: string, id: string): ModelApi | undefined;
}

export interface ModelContext {
  model: ModelApi | undefined;
  modelRegistry: ModelLookup;
}

/** Strip a trailing ":thinking" suffix ("provider/id:high" → "provider/id"). */
function stripThinking(spec: string): string {
  const colon = spec.lastIndexOf(":");
  const slash = spec.indexOf("/");
  return colon > slash && colon !== -1 ? spec.slice(0, colon) : spec;
}

/** Parse "provider/model-id[:thinking]" → { provider, id }; null when no provider slash. */
export function parseModelSpec(spec: string): { provider: string; id: string } | null {
  const s = stripThinking(spec);
  const slash = s.indexOf("/");
  if (slash <= 0) return null;
  return { provider: s.slice(0, slash), id: s.slice(slash + 1) };
}

/** Override spec → registry lookup; unresolvable override falls back to the session model. */
export function pickModel(ctx: ModelContext, overrideSpec: string | undefined): ModelApi | undefined {
  if (overrideSpec) {
    const parsed = parseModelSpec(overrideSpec);
    if (parsed) {
      const matched = ctx.modelRegistry.find(parsed.provider, parsed.id);
      if (matched) return matched;
    }
  }
  return ctx.model;
}
```

- [ ] **Step 5: Implement src/summarize.ts**

```ts
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { contentText, type Api, type Message, type Model, type Usage } from "@earendil-works/pi-ai";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { CompactConfig } from "./config.ts";
import { extractFileOps, type FileOpsSummary } from "./file-ops.ts";
import { buildSystemPrompt, buildUserPrompt, extractSummary } from "./prompt.ts";
import { inferSessionType, toolNamesIn } from "./session-type.ts";
import { collectUserMessages, type CollectedUserMessage } from "./user-messages.ts";

export interface ModelAuth {
  apiKey: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface SummarizeRequest {
  messages: readonly Message[];
  previousSummary?: string;
  customInstructions?: string;
  reserveTokens: number;
  signal: AbortSignal;
}

export interface SummarizeOptions {
  maxTokensFactor?: number;
  /** Test seam; defaults to the real completeSimple. */
  complete?: typeof completeSimple;
}

export interface CcSummaryResult {
  summary: string;
  usage: Usage | undefined;
  sessionType: ReturnType<typeof inferSessionType>;
  fileOps: FileOpsSummary;
  userMessages: readonly CollectedUserMessage[];
}

export async function summarizeCcStyle(
  request: SummarizeRequest,
  model: Model<Api>,
  auth: ModelAuth,
  options: SummarizeOptions = {},
): Promise<CcSummaryResult> {
  const llmMessages = convertToLlm(request.messages as never);
  const conversationText = serializeConversation(llmMessages as never);
  const fileOps = extractFileOps(request.messages);
  const sessionType = inferSessionType({
    toolNames: toolNamesIn(request.messages),
    conversationText,
  });
  const userMessages = collectUserMessages(request.messages);

  const userPrompt = buildUserPrompt({
    conversationText,
    previousSummary: request.previousSummary,
    customInstructions: request.customInstructions,
    fileOps,
    sessionType,
    userMessages,
  });

  const factor = options.maxTokensFactor ?? 0.8;
  const maxTokens = Math.min(
    Math.floor(factor * request.reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );

  const complete = options.complete ?? completeSimple;
  const response = await complete(
    model,
    {
      systemPrompt: buildSystemPrompt(),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: userPrompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: request.signal, maxTokens },
  );

  if (response.stopReason === "error") {
    throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  return {
    summary: extractSummary(contentText(response.content)),
    usage: response.usage,
    sessionType,
    fileOps,
    userMessages,
  };
}
```

(Type notes: `convertToLlm` accepts `AgentMessage[]`; `serializeConversation` accepts its output. If the installed d.ts requires narrower input types, adapt with a cast at the call boundary — never loosen the module's own exports. `response.errorMessage` may not exist on the type — if so, use `String(response)` in the error message instead.)

- [ ] **Step 6: Run tests** — `bun run --cwd bun-apps/s2-agent-ext-compact test` — Expected: PASS.

- [ ] **Step 7: Commit** — `feat(compact): pickModel + summarizeCcStyle — single completeSimple call, host cut point untouched`

---

### Task 8: extensions/compact.ts — hook wiring with degradation

**Files:**
- Modify: `bun-apps/s2-agent-ext-compact/extensions/compact.ts` (replace scaffold stub)
- Modify: `bun-apps/s2-agent-ext-compact/src/index.ts` (lib face re-exports — see Step 3)
- Test: `bun-apps/s2-agent-ext-compact/extensions/compact.test.ts`

**Interfaces:**
- Consumes: `loadCompactConfig` (T2), `pickModel` + `summarizeCcStyle` (T7), host event/ctx types from Global Constraints.
- Produces: default-exported `ExtensionFactory`; exported `createCompactExtension(deps?)` for tests. Deps seam: `createCompactExtension({ summarize = summarizeCcStyle, config = loadCompactConfig() }: CompactExtDeps = {})`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { createCompactExtension } from "./compact.ts";

const prep = {
  firstKeptEntryId: "entry-42",
  messagesToSummarize: [],
  turnPrefixMessages: [],
  isSplitTurn: false,
  tokensBefore: 9000,
  previousSummary: undefined,
  fileOps: { read: new Set(), written: new Set(), edited: new Set() },
  settings: { enabled: true, reserveTokens: 16000, keepRecentTokens: 4000 },
};

const event = (over: Record<string, unknown> = {}) =>
  ({ type: "session_before_compact", preparation: prep, branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal, ...over }) as never;

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    cwd: "/tmp",
    model: { provider: "zai", id: "glm-5.3", maxTokens: 100000 },
    modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) },
    notify: () => {},
    ...over,
  }) as never;

function run(factory: ReturnType<typeof createCompactExtension>) {
  const handlers: Array<(e: never, c: never) => Promise<unknown>> = [];
  factory({ on: (name: string, h: never) => { if (name === "session_before_compact") handlers.push(h); } } as never);
  return handlers;
}

describe("compact extension hook", () => {
  test("returns compaction reusing host cut point + tokensBefore", async () => {
    const summarize = (async () => ({
      summary: "S", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
      sessionType: "implementation", fileOps: { read: [], written: [], edited: [] }, userMessages: [],
    })) as never;
    const [h] = run(createCompactExtension({ summarize, config: { enabled: true, modelOverrideSpec: undefined, maxTokensFactor: 0.8 } }));
    const result = (await h(event(), ctx())) as { compaction: Record<string, unknown> };
    expect(result.compaction.firstKeptEntryId).toBe("entry-42");
    expect(result.compaction.tokensBefore).toBe(9000);
    expect(result.compaction.summary).toBe("S");
    expect((result.compaction.details as { engine: string }).engine).toBe("cc-style");
  });

  test("summarize throws → returns undefined and notifies (built-in fallback)", async () => {
    const summarize = (async () => { throw new Error("LLM unreachable"); }) as never;
    const notifications: string[] = [];
    const [h] = run(createCompactExtension({ summarize, config: { enabled: true, modelOverrideSpec: undefined, maxTokensFactor: 0.8 } }));
    const result = await h(event(), ctx({ notify: (m: string) => notifications.push(m) }));
    expect(result).toBeUndefined();
    expect(notifications[0]).toContain("falling back");
  });

  test("disabled config → no handler registered", () => {
    const handlers = run(createCompactExtension({ config: { enabled: false, modelOverrideSpec: undefined, maxTokensFactor: 0.8 } }));
    expect(handlers.length).toBe(0);
  });

  test("no auth → undefined fallback + notify", async () => {
    const summarize = (async () => ({ summary: "S" })) as never;
    const [h] = run(createCompactExtension({ summarize, config: { enabled: true, modelOverrideSpec: undefined, maxTokensFactor: 0.8 } }));
    const result = await h(event(), ctx({ modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) } }));
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (stub has no such behavior).

- [ ] **Step 3: Implement extensions/compact.ts and src/index.ts**

`extensions/compact.ts`:

```ts
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadCompactConfig, type CompactConfig } from "../src/config.ts";
import { pickModel, type ModelContext } from "../src/model.ts";
import { summarizeCcStyle, type CcSummaryResult, type SummarizeOptions } from "../src/summarize.ts";

export interface CompactExtDeps {
  summarize?: typeof summarizeCcStyle;
  config?: CompactConfig;
}

type AnyRecord = Record<string, unknown>;

export function createCompactExtension(deps: CompactExtDeps = {}): ExtensionFactory {
  return (pi) => {
    const config = deps.config ?? loadCompactConfig();
    if (!config.enabled) return;
    const summarize = deps.summarize ?? summarizeCcStyle;

    pi.on("session_before_compact", async (event, ctx) => {
      try {
        const model = pickModel(
          ctx as unknown as ModelContext,
          config.modelOverrideSpec,
        );
        if (!model) return; // no model at all → let host run built-in compaction
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) {
          ctx.notify(
            `compact: no API key for ${model.provider}/${model.id} — falling back to built-in compaction`,
            "warning",
          );
          return;
        }

        const result: CcSummaryResult = await summarize(
          {
            messages: event.preparation.messagesToSummarize as never,
            previousSummary: event.preparation.previousSummary,
            customInstructions: event.customInstructions,
            reserveTokens: event.preparation.settings.reserveTokens,
            signal: event.signal,
          },
          model,
          { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
          { maxTokensFactor: config.maxTokensFactor } satisfies SummarizeOptions,
        );

        return {
          compaction: {
            summary: result.summary,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            estimatedTokensAfter: Math.ceil(result.summary.length / 4),
            usage: result.usage,
            details: {
              engine: "cc-style",
              sessionType: result.sessionType,
              files: {
                read: result.fileOps.read.length,
                edited: result.fileOps.edited.length,
                written: result.fileOps.written.length,
              },
              userMessages: result.userMessages.length,
            },
          },
        };
      } catch (err) {
        ctx.notify(
          `compact: CC-style summary failed (${err instanceof Error ? err.message : String(err)}) — falling back to built-in compaction`,
          "warning",
        );
        return undefined; // emit() swallows nothing here; undefined → host built-in compaction
      }
    });
  };
}

export default createCompactExtension();
```

`src/index.ts` (lib face, replaces scaffold stub):

```ts
export { loadCompactConfig, type CompactConfig } from "./config.ts";
export { extractFileOps, verifiedFilesBlock, allFiles, type FileOpsSummary } from "./file-ops.ts";
export { inferSessionType, toolNamesIn, type SessionType } from "./session-type.ts";
export { collectUserMessages, type CollectedUserMessage } from "./user-messages.ts";
export { buildSystemPrompt, buildUserPrompt, extractSummary, SECTION_TITLES, type PromptInput } from "./prompt.ts";
export { pickModel, parseModelSpec, type ModelApi, type ModelContext } from "./model.ts";
export { summarizeCcStyle, type CcSummaryResult, type SummarizeRequest } from "./summarize.ts";
export { createCompactExtension, type CompactExtDeps } from "../extensions/compact.ts";
```

- [ ] **Step 4: Run tests + typecheck** — `bun run --cwd bun-apps/s2-agent-ext-compact test` PASS; `bun run --cwd bun-apps/s2-agent-ext-compact typecheck` PASS; `bun run --cwd bun-apps/s2-agent typecheck` PASS (static entry now imports the real hook).

- [ ] **Step 5: Commit** — `feat(compact): session_before_compact hook — CC-style summary, degrade to built-in on any failure`

---

### Task 9: scripts/ab.ts — offline A/B replay harness

**Files:**
- Create: `bun-apps/s2-agent-ext-compact/scripts/ab-metrics.ts` (pure helpers, tested)
- Create: `bun-apps/s2-agent-ext-compact/scripts/ab.ts` (CLI, untested I/O shell)
- Test: `bun-apps/s2-agent-ext-compact/scripts/ab-metrics.test.ts`
- Modify: `bun-apps/s2-agent-ext-compact/package.json` — add `"ab": "bun scripts/ab.ts"`

**Interfaces:**
- Consumes: host `parseSessionEntries`, `findCutPoint`, `sessionEntryToContextMessages`, `getLatestCompactionEntry`, `generateSummaryWithUsage` (arm A); `summarizeCcStyle` (arm B); `loadModelTierConfig` + `resolveModelRole` from `@repo/s2-agent-core-runtime`; `createAgentSessionServices` + `ModelRegistry` for model resolution (file2md `src/session-factory.ts` pattern).
- Produces: `bun run --cwd bun-apps/s2-agent-ext-compact ab [--session <path>] [--n 5] [--model provider/id] [--out report.json]`

- [ ] **Step 1: Write failing tests — ab-metrics.test.ts**

```ts
import { describe, expect, test } from "bun:test";
import { computeMetrics, extractErrorStrings, selectSessions, type SessionCandidate } from "./ab-metrics.ts";

describe("selectSessions", () => {
  test("keeps sessions with ≥ minMessages message entries, largest first, capped at n", () => {
    const c = (id: string, messages: number): SessionCandidate => ({
      id,
      path: `/s/${id}.jsonl`,
      messageEntries: messages,
      bytes: messages * 100,
    });
    const out = selectSessions([c("a", 5), c("b", 500), c("c", 120), c("d", 40)], { minMessages: 50, n: 2 });
    expect(out.map((s) => s.id)).toEqual(["b", "c"]);
  });
});

describe("computeMetrics", () => {
  test("compression ratio and delta fields", () => {
    const m = computeMetrics({
      tokensBefore: 10000,
      summaryTokens: 500,
      summarizedEntryTokens: 8000,
      wallMs: 1234,
      usage: { input: 20000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
    });
    expect(m.compressionRatio).toBeCloseTo(10000 / (10000 - 8000 + 500), 5);
    expect(m.summaryTokens).toBe(500);
    expect(m.cost).toBe(0.02);
  });
});

describe("extractErrorStrings", () => {
  test("pulls Error:/failed lines deterministically, capped", () => {
    const errs = extractErrorStrings("ok\nError: boom x\nit failed badly\nError: second");
    expect(errs).toContain("Error: boom x");
    expect(errs.length).toBeLessThanOrEqual(20);
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement scripts/ab-metrics.ts**

```ts
export interface SessionCandidate {
  id: string;
  path: string;
  messageEntries: number;
  bytes: number;
}

export function selectSessions(
  candidates: readonly SessionCandidate[],
  opts: { minMessages: number; n: number },
): SessionCandidate[] {
  return candidates
    .filter((c) => c.messageEntries >= opts.minMessages)
    .sort((a, b) => b.messageEntries - a.messageEntries)
    .slice(0, opts.n);
}

export interface MetricsInput {
  tokensBefore: number;
  summaryTokens: number;
  summarizedEntryTokens: number;
  wallMs: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

export interface ArmMetrics {
  summaryTokens: number;
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** tokensAfter ≈ tokensBefore − summarizedEntryTokens + summaryTokens; ratio = before/after. */
  compressionRatio: number;
}

export function computeMetrics(input: MetricsInput): ArmMetrics {
  const tokensAfter = input.tokensBefore - input.summarizedEntryTokens + input.summaryTokens;
  return {
    summaryTokens: input.summaryTokens,
    wallMs: input.wallMs,
    inputTokens: input.usage.input,
    outputTokens: input.usage.output,
    cost: input.usage.cost,
    compressionRatio: tokensAfter > 0 ? input.tokensBefore / tokensAfter : Number.POSITIVE_INFINITY,
  };
}

const ERROR_LINE_RE = /^.*((Error|error):[^\n]{0,120}|failed|FAILED|Traceback.*|✗.*)$/gm;

export function extractErrorStrings(conversationText: string, cap = 20): string[] {
  const out: string[] = [];
  for (const line of conversationText.split("\n")) {
    if (out.length >= cap) break;
    if (/(Error|error):/.test(line) || /\bfailed\b|FAILED|Traceback|✗/.test(line)) {
      const trimmed = line.trim().slice(0, 140);
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}
```

(Delete the unused `ERROR_LINE_RE` or keep `extractErrorStrings` loop-only — the regex constant is dead code; ship without it.)

- [ ] **Step 4: Implement scripts/ab.ts (CLI shell)**

```ts
/**
 * Offline A/B replay harness: CC-style compact (this extension) vs the host's
 * built-in generateSummaryWithUsage, on real sessions from ~/.pi/agent/sessions.
 * Both arms share the same cut point (findCutPoint), model, and reserveTokens.
 */
import { mkdir } from "node:fs/promises";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  createAgentSessionServices,
  findCutPoint,
  generateSummaryWithUsage,
  getLatestCompactionEntry,
  ModelRegistry,
  parseSessionEntries,
  DEFAULT_COMPACTION_SETTINGS,
  sessionEntryToContextMessages,
  type FileEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { loadModelTierConfig, resolveModelRole } from "@repo/s2-agent-core-runtime";
import { summarizeCcStyle } from "../src/summarize.ts";
import { computeMetrics, extractErrorStrings, selectSessions, type SessionCandidate } from "./ab-metrics.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function collectCandidates(): Promise<SessionCandidate[]> {
  const root = join(homedir(), ".pi/agent/sessions");
  const out: SessionCandidate[] = [];
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of await readdir(join(root, dir.name))) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(root, dir.name, f);
      const bytes = (await stat(path)).size;
      // Cheap pre-filter: message-entry count ≈ lines starting with {"type":"message"
      const text = await readFile(path, "utf8");
      const messageEntries = text.split("\n").filter((l) => l.startsWith('{"type":"message"')).length;
      out.push({ id: `${dir.name}/${f}`, path, messageEntries, bytes });
    }
  }
  return out;
}

function buildArmInputs(entries: FileEntry[]): {
  messagesToSummarize: ReturnType<typeof sessionEntryToContextMessages>;
  tokensBefore: number;
  previousSummary: string | undefined;
} {
  const sessionEntries = entries.filter((e) => e.type !== "session") as SessionEntry[];
  const cut = findCutPoint(sessionEntries, 0, sessionEntries.length - 1, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
  const toSummarize = sessionEntries.slice(0, cut.firstKeptEntryIndex);
  const messages = sessionEntryToContextMessages(toSummarize as never);
  const chars = toSummarize.map((e) => JSON.stringify(e).length).reduce((a, b) => a + b, 0);
  return {
    messagesToSummarize: messages,
    tokensBefore: Math.ceil(chars / 4),
    previousSummary: getLatestCompactionEntry(entries)?.summary,
  };
}

async function main() {
  const n = Number(arg("n", "5"));
  const sessionArg = arg("session");
  const modelSpec = arg("model") ?? resolveModelRole({ tier: "medium" }, loadModelTierConfig());
  if (!modelSpec) throw new Error("No model: pass --model provider/id or configure the medium tier");
  const [provider, id] = modelSpec.replace(/:[^/]+$/, "").split("/");

  const services = await createAgentSessionServices();
  const registry = new ModelRegistry(services.modelRuntime);
  const model = registry.find(provider, id);
  if (!model) throw new Error(`Model ${provider}/${id} not found in registry`);
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(`No API key for ${provider}/${id}`);

  const chosen = sessionArg
    ? [{ id: sessionArg, path: sessionArg, messageEntries: Number.POSITIVE_INFINITY, bytes: 0 }]
    : selectSessions(await collectCandidates(), { minMessages: 50, n });

  const results = [];
  for (const s of chosen) {
    const entries = parseSessionEntries(await readFile(s.path, "utf8"));
    const { messagesToSummarize, tokensBefore, previousSummary } = buildArmInputs(entries);
    const reserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
    const summarizedEntryTokens = Math.ceil(JSON.stringify(messagesToSummarize).length / 4);
    const conversationText = messagesToSummarize.map((m) => JSON.stringify(m)).join("\n");

    const t0 = performance.now();
    const builtIn = await generateSummaryWithUsage(
      messagesToSummarize as never, model, reserveTokens, auth.apiKey, auth.headers,
      undefined, undefined, previousSummary,
    );
    const t1 = performance.now();
    const ccStyle = await summarizeCcStyle(
      { messages: messagesToSummarize as never, previousSummary, reserveTokens, signal: new AbortController().signal },
      model, { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
    );
    const t2 = performance.now();

    results.push({
      session: s.id,
      tokensBefore,
      armA: {
        metrics: computeMetrics({ tokensBefore, summaryTokens: Math.ceil(builtIn.text.length / 4), summarizedEntryTokens, wallMs: t1 - t0, usage: builtIn.usage as never }),
        summaryPreview: builtIn.text.slice(0, 200),
      },
      armB: {
        metrics: computeMetrics({ tokensBefore, summaryTokens: Math.ceil(ccStyle.summary.length / 4), summarizedEntryTokens, wallMs: t2 - t1, usage: ccStyle.usage as never }),
        summaryPreview: ccStyle.summary.slice(0, 200),
        sessionType: ccStyle.sessionType,
      },
      // Fact set for later blind judging: deterministic ground truth both summaries should recall.
      factSet: {
        paths: [...ccStyle.fileOps.read, ...ccStyle.fileOps.edited, ...ccStyle.fileOps.written].slice(0, 50),
        userRequests: ccStyle.userMessages.slice(0, 20).map((m) => m.text.slice(0, 200)),
        errorStrings: extractErrorStrings(conversationText),
      },
    });
    console.log(`✔ ${s.id}  A:${results.at(-1)!.armA.metrics.summaryTokens}tok/${Math.round(t1 - t0)}ms  B:${results.at(-1)!.armB.metrics.summaryTokens}tok/${Math.round(t2 - t1)}ms`);
  }

  const mean = (pick: (r: (typeof results)[number]) => number) =>
    results.length ? results.reduce((a, r) => a + pick(r), 0) / results.length : 0;
  console.table(results.map((r) => ({ session: r.session, ...r.armA.metrics, ...r.armB.metrics })));
  console.log("means:", {
    aCompression: mean((r) => r.armA.metrics.compressionRatio),
    bCompression: mean((r) => r.armB.metrics.compressionRatio),
    aCost: mean((r) => r.armA.metrics.cost),
    bCost: mean((r) => r.armB.metrics.cost),
  });

  const out = arg("out");
  if (out) {
    await mkdir(join(out, "..") === out ? "." : ".", { recursive: true }).catch(() => {});
    await Bun.file(out, "w").write(JSON.stringify({ model: `${provider}/${id}`, results }, null, 2));
    console.log(`wrote ${out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

(Sanitize when writing the real file: drop the nonsense `mkdir` line — `Bun.file(out, "w").write(...)` creates parent-less files directly; if parents are needed use `mkdir(dirname(out), { recursive: true })` from `node:path`. Import `dirname` and do that.)

Also add to package.json scripts: `"ab": "bun scripts/ab.ts"` (extra scripts beyond test/typecheck are fine — only those two names are gate-resolved).

- [ ] **Step 5: Run metric tests + smoke the CLI offline**

```bash
bun run --cwd bun-apps/s2-agent-ext-compact test
```

Expected: PASS. Then a real smoke (needs the tier/model up — LM Studio SOP):

```bash
bun run --cwd bun-apps/s2-agent-ext-compact ab --n 1 --out /tmp/compact-ab-report.json
```

Expected: one session row, both arms complete, JSON written. If no session passes `minMessages: 50`, lower to 20 for the smoke only.

- [ ] **Step 6: Commit** — `feat(compact): offline A/B replay harness — built-in vs CC-style on real sessions`

---

### Task 10: Docs + full gates

**Files:**
- Create: `bun-apps/s2-agent-ext-compact/CONTEXT.md`
- Create: `bun-apps/s2-agent-ext-compact/docs/UPSTREAM-LESSONS.md`
- Modify: `bun-apps/s2-agent-ext-compact/README.md` (replace scaffold blurb)

**Interfaces:** none (docs only).

- [ ] **Step 1: Write CONTEXT.md**

```markdown
# compact — Claude Code-style /compact for s2-agent

## Scope
Replaces the *summary content* of built-in /compact via the `session_before_compact`
hook. Cut point, session tree, and all failure handling stay with the host.

## Seams
- IN: `session_before_compact` event (preparation, customInstructions, reason, signal).
- OUT: `{ compaction: { summary, firstKeptEntryId, tokensBefore, … } }`; any error →
  `undefined` → host built-in compaction (verified: runner.js emit swallows throws).
- CONFIG: `BUN_PI_COMPACT=0` off; `COMPACT_MODEL=provider/id[:thinking]` override;
  `COMPACT_MAX_TOKENS_FACTOR` (default 0.8).

## Invariants
- Never touch `firstKeptEntryId` / `tokensBefore` — reuse host preparation values.
- Files in "Files and Code Sections" come only from the deterministic
  `<verified-files>` extraction, never LLM invention.
- No "Done" without evidence (passing test or user confirmation).

## Decisions
See docs/adr/ when added; upstream lessons: docs/UPSTREAM-LESSONS.md.
```

- [ ] **Step 2: Write docs/UPSTREAM-LESSONS.md**

Must record (from studying `~/proj/pi-smart-compact`): EESV ten-stage layering and why one LLM call suffices here; yield gate (refuse whole compaction under 10% saving) — deliberately not ported; canonical structured-section parsing vs `includes("## goal")` substring checks — why ours uses `<summary>` tag extraction; pending-slot / branch-provenance tracking and what we do instead (details.engine + host appendCompaction); what a data-backed follow-up would look like if A/B shows hallucination pressure (verify/repair loop).

- [ ] **Step 3: Full gates**

```bash
bun run --cwd bun-apps/s2-agent-ext-compact test
bun run --cwd bun-apps/s2-agent-ext-compact typecheck
bun run --cwd bun-apps/s2-agent typecheck          # cross-package
bun run --cwd bun-apps/s2-agent regen:manifest     # freshness check only — no diff expected
```

Then the devops local CI chain (per CLAUDE.md DevOps — never hand-rolled):
`bun bun-apps/s2-agent/src/cli.ts` wrapper or `bun-apps/s2-agent-ext-devops/src/local-ci-cli.ts` on this branch. Expected: green, and total under the 5-minute budget.

- [ ] **Step 4: Commit** — `docs(compact): CONTEXT + upstream lessons from pi-smart-compact`

- [ ] **Step 5: Live acceptance (manual, after merge/deploy)**

- `/compact` in a live session → summary has the 9 CC sections
- `/compact focus on auth` → `Additional focus: focus on auth` honored
- Kill the model endpoint → `/compact` still succeeds via built-in fallback with a warning notify
- Deployed tree contains the extension: `ls ~/proj/dist/s2-agent-sh/current/ext/ | grep compact`

---

## Self-review notes

- Spec coverage: package+registration (T1), runtime seam+degradation (T7/T8), 6 hints (T3 verified-files, T4 session-type, T6 identifiers/evidence/update/Additional-focus — customInstructions flows from event through summarize to prompt), A/B harness (T9), tests/CI (every task + T10), learning record (T10). Acceptance #1 deploy-verify and #2–#4 live checks are the manual Step 5 of T10.
- Known deliberate deviations from spec: prompt lists 9 section titles (spec wrote "8-section" but enumerated 9 — followed the enumeration); A/B judge blind-scoring is represented by the emitted `factSet` in the JSON report rather than an automated judge LLM call, keeping the harness offline-optional and deterministic — the judge can be run from the report in a follow-up.
- Type consistency: `FileOpsSummary`/`SessionType`/`CollectedUserMessage`/`CcSummaryResult` names are identical across tasks; `completeSimple` seam type matches usage in T7/T8.
