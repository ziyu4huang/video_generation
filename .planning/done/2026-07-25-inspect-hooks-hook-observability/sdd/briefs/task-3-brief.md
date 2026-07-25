## Task 3: Wire the tool's `execute()` (real + self_test + JSON)

**Files:**
- Modify: `bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts` (the `makeInspectHooksTool` body)
- Test (append): `bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.test.ts`

**Interfaces:**
- Consumes: `analyzeHooks`, `formatHooksReport` (Task 1), `ctx.getHooks()` (Task 2 polyfill), `summarizeFindings`.
- Produces: a complete `inspect_hooks` tool ready for registration.

- [ ] **Step 1: Append the tool end-to-end test**

Append to `src/tools/__tests__/inspect-hooks.test.ts`:

```ts
import { makeInspectHooksTool } from "../inspect-hooks.js";

describe("inspect_hooks (tool end-to-end, fake ctx)", () => {
  const fakeCtx = (snapshot: HooksSnapshot) =>
    ({ getHooks: () => snapshot } as unknown as Parameters<
      ReturnType<typeof makeInspectHooksTool>["execute"]
    >[4]);

  test("text report surfaces unknown-event finding", async () => {
    const tool = makeInspectHooksTool();
    const res = await tool.execute(
      "id",
      {},
      undefined,
      undefined,
      fakeCtx(snap([{ path: "ext.ts", hooks: [{ event: "turn_starts", count: 1 }] }])),
    );
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('unknown event "turn_starts"');
  });

  test("return_json=true returns {findings, summary, snapshot}", async () => {
    const tool = makeInspectHooksTool();
    const res = await tool.execute(
      "id",
      { return_json: true },
      undefined,
      undefined,
      fakeCtx(snap([{ path: "ext.ts", hooks: [{ event: "turn_end", count: 2 }] }])),
    );
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.summary).toEqual({ total: 0, high: 0, medium: 0, low: 0 });
    expect(parsed.snapshot.extensions[0]).toEqual({
      path: "ext.ts",
      hooks: [{ event: "turn_end", count: 2 }],
    });
    expect(Array.isArray(parsed.findings)).toBe(true);
  });

  test("self_test=true returns deterministic mock (no live ctx)", async () => {
    const tool = makeInspectHooksTool();
    const res = await tool.execute("id", { self_test: true }, undefined, undefined, {} as never);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("self_test");
    expect(text).toContain("Inspect Hooks");
  });

  test("hooks-unavailable (available:false) degrades gracefully", async () => {
    const tool = makeInspectHooksTool();
    const res = await tool.execute("id", {}, undefined, undefined, fakeCtx(snap([], false)));
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("Hooks unavailable");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/tools/__tests__/inspect-hooks.test.ts )
```
Expected: FAIL — the placeholder `execute` (from Task 1) always returns `available:false`, so the unknown-event / JSON assertions fail.

- [ ] **Step 3: Replace the `makeInspectHooksTool` `execute` body**

In `src/tools/inspect-hooks.ts`, replace the entire `makeInspectHooksTool` function with:

```ts
export function makeInspectHooksTool() {
  return defineTool({
    name: "inspect_hooks",
    label: "Inspect Hooks",
    description:
      "List every loaded extension's registered lifecycle hooks (pi.on handlers) — which events each extension listens on, handler counts, and any handler registered against an unknown event name (likely a typo / dead handler). Fact-finder companion to inspect_extensions.",
    parameters: Type.Object({
      by_event: Type.Optional(Type.Boolean({ description: "Group inventory by event instead of by extension (who listens on X?)" })),
      return_json: Type.Optional(Type.Boolean({ description: "Return machine-readable JSON instead of a text report" })),
      self_test: Type.Optional(Type.Boolean({ description: "When true, run against deterministic test data instead of live ctx" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      // self_test: deterministic mock, no live session.
      if (params.self_test) {
        const mock: HooksSnapshot = {
          extensions: [
            { path: "bun-apps/example/ext.ts", hooks: [{ event: "turn_end", count: 1 }, { event: "turn_starts", count: 1 }] },
          ],
          available: true,
        };
        const findings = analyzeHooks(mock);
        return {
          content: [{ type: "text" as const, text: "self_test: true\n\n" + formatHooksReport(mock, findings, Boolean(params.by_event)) }],
          details: null,
        };
      }

      const snapshot = (ctx as ExtensionContext).getHooks();
      const findings = analyzeHooks(snapshot);

      if (params.return_json) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { findings, summary: summarizeFindings(findings), snapshot },
                null,
                2,
              ),
            },
          ],
          details: null,
        };
      }
      return {
        content: [{ type: "text" as const, text: formatHooksReport(snapshot, findings, Boolean(params.by_event)) }],
        details: null,
      };
    },
  });
}
```

Also DELETE the trailing placeholder export block from Task 1 (the `export { };` + `export type { ExtensionContext }` lines) — `ExtensionContext` is already imported at the top via the `defineTool` import line; ensure the top import reads:

```ts
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
( cd bun-apps/pi-agent-ext-power-tool && bun test src/tools/__tests__/inspect-hooks.test.ts )
```
Expected: PASS — all tool end-to-end tests green.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-power-tool/src/tools/inspect-hooks.ts \
        bun-apps/pi-agent-ext-power-tool/src/tools/__tests__/inspect-hooks.test.ts
git commit -m "feat(power-tool): wire inspect_hooks execute (live snapshot + self_test + JSON)"
```

---

