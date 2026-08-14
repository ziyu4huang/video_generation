### Task 2: snapshot derivation module

**Files:**
- Create: `bun-apps/pi-agent-ext-btw/src/btw/snapshot.ts`
- Test: `bun-apps/pi-agent-ext-btw/__tests__/snapshot.test.ts`

**Interfaces:**
- Consumes: `BtwDetails` from `src/btw/types.ts` (existing: `{ question; thinking; answer; provider; model; api; thinkingLevel; timestamp; usage? }`); `AgentSessionEvent` type (import from the same SDK module path `src/btw/session.ts` uses — adjust the import specifier if it differs); `BtwMessageSnapshot` from Task 1.
- Produces: `interface BtwStatusUpdate { status: BtwMessageStatus; statusText?: string }`; `snapshotsFromDetails(details: BtwDetails[]): BtwMessageSnapshot[]`; `statusFromEvent(event: AgentSessionEvent): BtwStatusUpdate | null`; `snapshotsFromMessages(messages: AgentMessage[], status: BtwStatusUpdate | null): BtwMessageSnapshot[]`.

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-btw/__tests__/snapshot.test.ts
import { describe, expect, it } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { BtwDetails } from "../src/btw/types";
import { snapshotsFromDetails, snapshotsFromMessages, statusFromEvent } from "../src/btw/snapshot";

const ev = (partial: Record<string, unknown>): AgentSessionEvent =>
  partial as unknown as AgentSessionEvent;

const details: BtwDetails[] = [
  {
    question: "what failed?",
    thinking: "",
    answer: "the shader compile step",
    provider: "anthropic",
    model: "claude-sonnet-4",
    api: "anthropic",
    thinkingLevel: "off",
    timestamp: 1,
  },
];

describe("snapshotsFromDetails", () => {
  it("maps persisted BtwDetails to stable keyed snapshots", () => {
    expect(snapshotsFromDetails(details)).toEqual([
      { id: "btw-d-0", role: "user", text: "what failed?", status: "done" },
      { id: "btw-d-1", role: "assistant", text: "the shader compile step", status: "done" },
    ]);
  });

  it("returns an empty array for an empty thread", () => {
    expect(snapshotsFromDetails([])).toEqual([]);
  });
});

describe("statusFromEvent", () => {
  it("maps tool lifecycle events to running-tool status", () => {
    expect(statusFromEvent(ev({ type: "tool_execution_start", toolName: "bash" }))).toEqual({
      status: "running-tool",
      statusText: "running-tool: bash",
    });
    expect(statusFromEvent(ev({ type: "tool_execution_start" }))).toEqual({
      status: "running-tool",
      statusText: "running-tool: tool",
    });
  });

  it("maps turn lifecycle back to streaming/done", () => {
    expect(statusFromEvent(ev({ type: "tool_execution_end" }))).toEqual({ status: "streaming" });
    expect(statusFromEvent(ev({ type: "turn_end" }))).toEqual({ status: "done" });
  });

  it("returns null for events that do not change status", () => {
    expect(statusFromEvent(ev({ type: "message_update" }))).toBeNull();
    expect(statusFromEvent(ev({ type: "turn_start" }))).toBeNull();
  });
});

describe("snapshotsFromMessages", () => {
  it("derives keyed snapshots, folding the status override into the last message", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "q" }] },
      { role: "assistant", parts: [{ type: "text", text: "partial answer" }] },
    ] as unknown as Parameters<typeof snapshotsFromMessages>[0];
    expect(
      snapshotsFromMessages(messages, { status: "running-tool", statusText: "running-tool: bash" }),
    ).toEqual([
      { id: "btw-m-0", role: "user", text: "q", status: "done" },
      {
        id: "btw-m-1",
        role: "assistant",
        text: "partial answer",
        status: "running-tool",
        statusText: "running-tool: bash",
      },
    ]);
  });

  it("defaults the last live message to streaming when no override is set", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "q" }] },
      { role: "assistant", parts: [{ type: "text", text: "a" }] },
    ] as unknown as Parameters<typeof snapshotsFromMessages>[0];
    expect(snapshotsFromMessages(messages, null)).toEqual([
      { id: "btw-m-0", role: "user", text: "q", status: "done" },
      { id: "btw-m-1", role: "assistant", text: "a", status: "streaming" },
    ]);
  });
});
```

Note for the implementer: the fixture message shape above (`role` + `parts[].text`) is the plan's best-grounded guess. Before writing the implementation, check the real `AgentMessage` shape via the extraction already in `src/btw/session.ts` (`runBtw`'s answer extraction and `getBtwHandoffThread`'s live-message walk) and adjust BOTH `textOf`/`roleOf` below and these fixtures together so the assertions stay exactly these.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/snapshot.test.ts )`
Expected: FAIL — cannot resolve `../src/btw/snapshot`.

- [ ] **Step 3: Write minimal implementation**

```ts
// bun-apps/pi-agent-ext-btw/src/btw/snapshot.ts
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { BtwDetails } from "./types";
import type { BtwMessageSnapshot, BtwMessageStatus } from "./webui-events";

/** A status change derived from a sub-session AgentSessionEvent; null = no change. */
export interface BtwStatusUpdate {
  status: BtwMessageStatus;
  statusText?: string;
}

/** Persisted thread (BtwDetails[]) -> snapshots. Ids are index-stable: btw-d-<index>. */
export function snapshotsFromDetails(details: BtwDetails[]): BtwMessageSnapshot[] {
  const snapshots: BtwMessageSnapshot[] = [];
  for (const entry of details) {
    snapshots.push({ id: `btw-d-${snapshots.length}`, role: "user", text: entry.question, status: "done" });
    snapshots.push({ id: `btw-d-${snapshots.length}`, role: "assistant", text: entry.answer, status: "done" });
  }
  return snapshots;
}

/**
 * Map a sub-session event to a status override for the LAST live message.
 * Reads only the event type discriminant plus an optional tool name — never
 * full event payloads — so it stays robust across SDK event shapes.
 */
export function statusFromEvent(event: AgentSessionEvent): BtwStatusUpdate | null {
  const type = (event as { type?: unknown }).type;
  if (type === "tool_execution_start") {
    const toolName = (event as { toolName?: unknown }).toolName;
    return { status: "running-tool", statusText: `running-tool: ${typeof toolName === "string" && toolName ? toolName : "tool"}` };
  }
  if (type === "tool_execution_end") return { status: "streaming" };
  if (type === "turn_end") return { status: "done" };
  return null;
}

// roleOf/textOf mirror the extraction already used by src/btw/session.ts
// (runBtw's answer extraction / getBtwHandoffThread's live-message walk).
// If session.ts exports a reusable helper, import it instead of duplicating.
function roleOf(message: unknown): "user" | "assistant" {
  const role = (message as { role?: unknown }).role;
  return role === "user" ? "user" : "assistant";
}

function textOf(message: unknown): string {
  const parts = (message as { parts?: Array<{ type?: unknown; text?: unknown }> }).parts ?? [];
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/**
 * Live sub-session messages -> snapshots. Ids are index-stable: btw-m-<index>.
 * The status override (if any) is folded into the LAST message only; with no
 * override the last message defaults to "streaming" (mid-turn).
 */
export function snapshotsFromMessages(
  messages: readonly unknown[],
  status: BtwStatusUpdate | null,
): BtwMessageSnapshot[] {
  return messages.map((message, index) => {
    const isLast = index === messages.length - 1;
    const update = isLast ? (status ?? { status: "streaming" as const }) : null;
    return {
      id: `btw-m-${index}`,
      role: roleOf(message),
      text: textOf(message),
      status: update ? update.status : "done",
      ...(update?.statusText ? { statusText: update.statusText } : {}),
    };
  });
}
```

If the real `AgentMessage` type is available as an export, type `messages: readonly AgentMessage[]` and drop the `unknown` casting — keep the runtime behavior identical either way.

Note: real code (`src/btw/session.ts` `handleBtwSessionEvent`) maps `tool_execution_end` back to "streaming" only when the session is still streaming (`session.isStreaming`); `statusFromEvent` maps it unconditionally. This simplification is deliberate — `statusFromEvent` has no session handle, and the unconditional mapping only differs in the brief post-tool window.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/snapshot.test.ts )`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-btw/src/btw/snapshot.ts bun-apps/pi-agent-ext-btw/__tests__/snapshot.test.ts
git commit -m "feat(btw): add snapshot derivation for webui thread events"
```

