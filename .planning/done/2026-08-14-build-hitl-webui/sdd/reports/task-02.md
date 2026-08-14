# Task 2 Report — HITL pending-Promise registry + appexec resolve + abort (zk-spawn, HITL-webui Phase 1)

- **BASE**: `33bae1c6c9020e62ee373f8314d3736bd065156a` (Task-1 commit, branch `hitl-webui-phase1`)
- **HEAD**: `32deb614da25939e2ccdcf7063f2ce0f12f1b65e` (branch `hitl-webui-phase1`)
- **Commit message**: `feat(webui): appexec resolve + pending registry + abort seams (HITL return transport T2)`

## What changed (per file)

### `bun-apps/pi-agent-ext-webui/src/web-server.ts` (the volatile adapter)

1. New field after `private token: string | null = null;`:

```ts
  /** Optional WS-close handler (spec Component 1); null => none (the default). */
  private onWsClose: (() => void) | null = null;
```

2. New seam method after `setTokenAuth` (mirrors setCommandHandler/setHttpRoutes/setTokenAuth):

```ts
  setWsCloseHandler(cb: (() => void) | null): void {
    this.onWsClose = cb;
  }
```

3. WS `close` arm of `serveWithFallback`'s `websocket` block now invokes the handler alongside pruning:

```ts
            close: (ws) => {
              this.clients.delete(ws);
              if (this.onWsClose) this.onWsClose();
            },
```

### `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (the composition root)

1. **Module-header refresh** (Task-1 review's ledgered minor finding): the stale bullet
   `appexec BYPASSES the mutex entirely (no concrete v1 ops; forward seam)` now reads:

```ts
 *  - `appexec` BYPASSES the mutex entirely — it is the HITL return transport
 *    (spec Component 1): a typed `respond` descriptor resolves the pending
 *    Promise registered under its `id` (unknown ids are ignored), while
 *    session_shutdown / WS close abort every pending as {cancelled:true}.
```

2. **`WebuiServer`** extended with `setWsCloseHandler(cb: (() => void) | null): void;` (after `setTokenAuth`).
3. **`WebuiWiring`** extended with `registerPending(id: string): Promise<{ action?: string; tweak?: string; cancelled?: boolean }>;`
   (see Deviations #1 for the `action?` vs the plan's `action`).
4. **Registry** inserted after `let disposed = false;` (closure-local `HitlResponse` type + `Map` + `registerPending` + `cancelAllPending`):

```ts
  type HitlResponse = { action?: string; tweak?: string; cancelled?: boolean };
  const pending = new Map<string, { resolve: (r: HitlResponse) => void }>();

  function registerPending(id: string): Promise<HitlResponse> {
    return new Promise<HitlResponse>((resolve) => {
      pending.set(id, { resolve });
    });
  }

  function cancelAllPending(): void {
    for (const entry of pending.values()) entry.resolve({ cancelled: true });
    pending.clear();
  }
```

5. **`dispatch` `case "appexec"`** rewritten from the v1 no-op to resolve-by-id:

```ts
      case "appexec": {
        const entry = pending.get(action.id);
        if (entry) {
          pending.delete(action.id);
          entry.resolve(
            action.tweak !== undefined
              ? { action: action.action, tweak: action.tweak }
              : { action: action.action }
          );
        }
        break;
      }
```

6. **WS-close seam wired** after `server.setCommandHandler(onCommand);`: `server.setWsCloseHandler(() => cancelAllPending());`
7. **`session_shutdown`** handler now calls `cancelAllPending()` between `controller.handleShutdown()` and `server.dropSession()`.
8. **`return` block**: `dispose()` gained `server.setWsCloseHandler(null);` + `cancelAllPending();`; `registerPending` exposed on the returned object.

### `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts`

1. `FakeWebServer` (inline in this file, per the plan) gained `wsCloseHandler: (() => void) | null = null;`
   field + `setWsCloseHandler(cb)` method (recorded seam — tests fire it to assert abort).
2. The old `appexec → NO sendUserMessage, NO lock acquired` no-op test was replaced by the plan's
   five-test `describe("HITL appexec return transport (respond resolve + registry + abort)")`:
   - respond resolves pending by id with `{action}` (bypasses mutex — no sendUserMessage path)
   - respond with tweak surfaces `tweak`
   - respond for an unknown id ignored (registered pending stays pending; then cancelled via session_shutdown)
   - session_shutdown resolves all pending (two concurrent ids) as `{cancelled:true}`
   - WS close (`server.wsCloseHandler!()`) resolves pending as `{cancelled:true}` — also asserts
     `wireWebui` actually registered the handler (`expect(server.wsCloseHandler).not.toBeNull()`)

### `bun-apps/pi-agent-ext-webui/tests/web-server.test.ts`

One focused real-`WebServer` test added inside `describe("WebServer broadcast over a real WS")`,
right after "prunes a client after it disconnects": opens a WS to an ephemeral-port server with
`setWsCloseHandler` installed, asserts the cb does NOT fire on connect (`closeCount === 0`), closes
the client, and waits for the cb to fire exactly once. Proves the REAL server invokes cb on close
(the FakeWebServer only proves wiring CALLS `setWsCloseHandler`).

## Test evidence

- **Red (before implementation)** — `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts tests/web-server.test.ts )`:
  `50 pass / 6 fail` — exactly the 5 new HITL wiring tests (`wiring.registerPending is not a function`,
  unresolved respond promises, `server.wsCloseHandler` null) + the real-`WebServer` test
  (`s.setWsCloseHandler is not a function`). The plan's predicted red surface.
- **Green (after implementation)** — same command: `56 pass / 0 fail`.
- **Full gate** — `( cd bun-apps/pi-agent-ext-webui && bun test )`: `237 pass / 0 fail` (`Ran 237 tests across 22 files`).
  (237 = Task-1's 232 + 5 new wiring tests; the replaced no-op test netted +0, plus 1 new real-server test → +6 total over Task 1's dispatch count reconciles to 232 + 5 = 237 because the old appexec no-op test was removed.)
- **Type gate** — `( cd bun-apps/pi-agent-ext-webui && bun run build )` (`bunx tsc` over `src/**`): exit 0
  after the Deviation-#1 fix. (First run of the plan's verbatim code FAILED tsc: `Property 'action' is missing
  in type '{ cancelled: true; }' but required in type 'HitlResponse'` — see below.)

## Staged set verification

`git diff --cached --name-only` before committing showed exactly:

```
bun-apps/pi-agent-ext-webui/src/web-server.ts
bun-apps/pi-agent-ext-webui/src/webui-wiring.ts
bun-apps/pi-agent-ext-webui/tests/web-server.test.ts
bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts
```

## Deviations from plan.md

1. **`action` made optional (`action?: string`) in `HitlResponse` + `WebuiWiring.registerPending`.**
   The plan's verbatim types declared `action: string` (required) while `cancelAllPending` resolves
   `{ cancelled: true }` (no action) — `bun run build` (`tsc`) correctly rejected that as
   TS2741. Minimal fix preserving the plan's flat shape and all test assertions: `action?` in both
   places, with a comment noting an abort response carries NO action. Runtime behavior is exactly
   the plan's (resolve `{action[,tweak]}` / `{cancelled:true}`); tests' `toEqual` assertions unchanged.
   Phase-2 consumers should branch on `cancelled` before reading `action`.
2. Commit message uses the task brief's exact string
   (`appexec resolve + pending registry + abort seams (HITL return transport T2)`) rather than plan
   Step-5's variant — the brief's instruction was followed (same as Task 1's precedent).

## Concerns

None blocking. Two informational notes:

- The registry stores only `{resolve}` (no `reject`) — per the plan's Self-Review note, abort RESOLVES
  with `{cancelled:true}`; there is no rejection path anywhere (no unhandled-rejection risk).
- The plan's `Files` list mentioned "FakeWebServer's file wherever the plan puts it" — `FakeWebServer`
  is defined inline in `tests/webui-wiring.test.ts` (not `tests/helpers/`), so no separate file was touched.
