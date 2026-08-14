### Task 6: protocol frame + transport mapping

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/protocol.ts` (add `BtwCommandFrameSchema` to the inbound union; add `BtwWebFrame` to the outbound `WebFrame` union)
- Modify: `bun-apps/pi-agent-ext-webui/src/web-transport.ts` (new `parseCommand` case + `DispatchAction` member)
- Test: `bun-apps/pi-agent-ext-webui/tests/protocol-btw.test.ts` (or extend the existing protocol/transport test files with these cases — follow wherever `appexec` frame tests live)

**Interfaces:**
- Consumes: Task 5 (`btwCommandFromFrame`, `BtwCommand`, `BtwEvent`); existing `validateInbound(raw): ClientFrame | null`, `WebTransport.parseCommand(frame): DispatchAction | ...`, TypeBox `Type`/`Static`.
- Produces: `BtwCommandFrameSchema` / `BtwCommandFrame` (validated inbound frame `{ type: "btw"; kind; text?; mode?; model?; level? }`); `BtwWebFrame = { type: "btw"; event: BtwEvent }` member of `WebFrame`; `DispatchAction` member `{ kind: "btw"; command: BtwCommand }`.

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-webui/tests/protocol-btw.test.ts
import { describe, expect, it } from "bun:test";
import { validateInbound } from "../src/protocol";
import { WebTransport } from "../src/web-transport";

describe("btw inbound frames", () => {
  it("validates well-formed btw command frames", () => {
    expect(validateInbound({ type: "btw", kind: "ask", text: "hi" })).toEqual({
      type: "btw",
      kind: "ask",
      text: "hi",
    });
    expect(validateInbound({ type: "btw", kind: "mode", mode: "tangent" })).toEqual({
      type: "btw",
      kind: "mode",
      mode: "tangent",
    });
    expect(validateInbound({ type: "btw", kind: "model", model: { provider: "p", id: "m", api: "a" } })).toEqual({
      type: "btw",
      kind: "model",
      model: { provider: "p", id: "m", api: "a" },
    });
  });

  it("rejects frames with an unknown kind", () => {
    expect(validateInbound({ type: "btw", kind: "bogus" })).toBeNull();
    expect(validateInbound({ type: "btw" })).toBeNull();
  });

  it("parseCommand maps btw frames to a btw dispatch action", () => {
    expect(WebTransport.parseCommand({ type: "btw", kind: "mode", mode: "tangent" } as never)).toEqual({
      kind: "btw",
      command: { kind: "mode", mode: "tangent" },
    });
    expect(WebTransport.parseCommand({ type: "btw", kind: "summarize" } as never)).toEqual({
      kind: "btw",
      command: { kind: "summarize" },
    });
  });

  it("parseCommand returns null for inconsistent btw bodies", () => {
    expect(WebTransport.parseCommand({ type: "btw", kind: "ask" } as never)).toBeNull();
    expect(WebTransport.parseCommand({ type: "btw", kind: "mode", mode: "bogus" } as never)).toBeNull();
  });
});
```

If the existing transport tests already cover `parseCommand` for `appexec` in a dedicated file, add these cases there instead of a new file — keep the imports identical to that file's.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/protocol-btw.test.ts )`
Expected: FAIL — `BtwCommandFrameSchema` not in the union (`validateInbound` returns null) and `parseCommand` has no `btw` case.

- [ ] **Step 3: Implement protocol additions**

In `bun-apps/pi-agent-ext-webui/src/protocol.ts` (TypeBox — NOT zod):

```ts
import { btwCommandFromFrame, type BtwEvent } from "./btw-channels";
// (merge into the existing imports at the top of the file)

export const BtwCommandFrameSchema = Type.Object({
  type: Type.Literal("btw"),
  kind: Type.Union([
    Type.Literal("ask"),
    Type.Literal("new"),
    Type.Literal("clear"),
    Type.Literal("inject"),
    Type.Literal("summarize"),
    Type.Literal("model"),
    Type.Literal("thinking"),
    Type.Literal("mode"),
  ]),
  text: Type.Optional(Type.String()),
  mode: Type.Optional(Type.Union([Type.Literal("contextual"), Type.Literal("tangent")])),
  model: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Object({ provider: Type.String(), id: Type.String(), api: Type.String() }),
    ]),
  ),
  level: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Union([
        Type.Literal("off"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
      ]),
    ]),
  ),
});
export type BtwCommandFrame = Static<typeof BtwCommandFrameSchema>;
```

Add `BtwCommandFrameSchema` to the `InboundCommandSchema` union (alongside `AgenticWithTextSchema`, `AbortCommandSchema`, `AppExecCommandSchema`, `ControlCommandSchema`). Add the explicit outbound member to the `WebFrame` union:

```ts
export interface BtwWebFrame {
  type: "btw";
  event: BtwEvent;
}
```

- [ ] **Step 4: Implement the transport mapping**

In `bun-apps/pi-agent-ext-webui/src/web-transport.ts`:

1. Extend the `DispatchAction` union with `{ kind: "btw"; command: BtwCommand }` (import `BtwCommand` from `./btw-channels`).
2. In `parseCommand`, next to the existing `appexec` case:

```ts
if (frame.type === "btw") {
  const command = btwCommandFromFrame(frame as BtwCommandFrameInput);
  if (!command) return null;
  return { kind: "btw", command };
}
```

(Match the exact structural style of the existing `appexec` branch — if it uses a `switch` or destructuring, mirror that; keep the `btwCommandFromFrame` call and the null path identical.)

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/protocol-btw.test.ts )`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the package gate**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: PASS — all 16 existing test files stay green (the new union member is additive).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/protocol.ts bun-apps/pi-agent-ext-webui/src/web-transport.ts bun-apps/pi-agent-ext-webui/tests/protocol-btw.test.ts
git commit -m "feat(webui): add btw WS frame type and dispatch action"
```

