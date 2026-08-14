### Task 8: HTTP routes + wiring glue

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/btw-routes.ts`
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (widen `WebuiSessionCtx`; subscribe `onBtwEvent` → forwarder; `dispatch` case `"btw"`; chain btw routes into `setHttpRoutes`)
- Test: `bun-apps/pi-agent-ext-webui/tests/btw-routes.test.ts`

**Interfaces:**
- Consumes: Task 5 (`onBtwEvent`, `emitBtwCommand`); Task 6 DispatchAction member `{ kind: "btw"; command: BtwCommand }`; Task 7 (`createBtwStore`, `createBtwForwarder`); existing `HttpRouteHandler = (req, srv) => Response | null` and `server.setHttpRoutes`, `server.broadcast`, `renderRoutes`/`outputRoutes` chain at `webui-wiring.ts` ~L370, `WebuiSessionCtx` (currently `{ abort(): void; ui: WebuiUi }` — the real `ExtensionContext` is a structural superset per the file's own comment).
- Produces: `createBtwRoutes(deps: BtwRoutesDeps): HttpRouteHandler` with `BtwRoutesDeps = { getState(): BtwThreadState | null; getModels(): BtwModelSummary[] }` and `BtwModelSummary = { provider: string; id: string; api: string }`; `GET /api/btw` + `GET /api/btw/models` responses (`application/json; charset=utf-8`, `Cache-Control: no-store`); `WebuiSessionCtx` now includes `modelRegistry`.

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-webui/tests/btw-routes.test.ts
import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server";
import { createBtwRoutes } from "../src/btw-routes";
import type { BtwThreadState } from "../src/btw-channels";

const servers: WebServer[] = [];
afterEach(() => {
  for (const server of servers) server.stop();
  servers.length = 0;
});

const STATE: BtwThreadState = {
  messages: [{ id: "btw-m-0", role: "user", text: "q", status: "done" }],
  mode: "contextual",
  model: null,
  thinking: null,
};

function startServer(deps: Parameters<typeof createBtwRoutes>[0]): WebServer {
  const server = new WebServer({ port: 0 });
  servers.push(server);
  server.setHttpRoutes(createBtwRoutes(deps));
  server.start();
  return server;
}

describe("GET /api/btw", () => {
  it("returns the latest thread snapshot with no-store headers", async () => {
    const server = startServer({ getState: () => STATE, getModels: () => [] });
    const res = await fetch(`${server.url}/api/btw`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(STATE);
  });

  it("returns an empty default state when nothing has been emitted yet", async () => {
    const server = startServer({ getState: () => null, getModels: () => [] });
    const res = await fetch(`${server.url}/api/btw`);
    expect(await res.json()).toEqual({ messages: [], mode: "contextual", model: null, thinking: null });
  });
});

describe("GET /api/btw/models", () => {
  it("returns the registry-backed model list", async () => {
    const models = [{ provider: "anthropic", id: "claude-sonnet-4", api: "anthropic" }];
    const server = startServer({ getState: () => STATE, getModels: () => models });
    const res = await fetch(`${server.url}/api/btw/models`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(models);
  });
});

describe("route chaining", () => {
  it("returns null for other paths so the existing chain continues", () => {
    const handler = createBtwRoutes({ getState: () => STATE, getModels: () => [] });
    expect(handler(new Request("http://localhost/api/views"), undefined as never)).toBeNull();
    expect(handler(new Request("http://localhost/output/x.png"), undefined as never)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-routes.test.ts )`
Expected: FAIL — cannot resolve `../src/btw-routes`.

- [ ] **Step 3: Write the route handler**

```ts
// bun-apps/pi-agent-ext-webui/src/btw-routes.ts
import type { HttpRouteHandler } from "./web-server";
import type { BtwThreadState } from "./btw-channels";

/** Registry-backed model summary fed to the panel's Model dropdown (D12). */
export interface BtwModelSummary {
  provider: string;
  id: string;
  api: string;
}

export interface BtwRoutesDeps {
  getState(): BtwThreadState | null;
  getModels(): BtwModelSummary[];
}

const EMPTY_STATE: BtwThreadState = {
  messages: [],
  mode: "contextual",
  model: null,
  thinking: null,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** GET /api/btw (thread snapshot, D7) + GET /api/btw/models (registry list, D12). */
export function createBtwRoutes(deps: BtwRoutesDeps): HttpRouteHandler {
  return (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/api/btw") {
      return jsonResponse(deps.getState() ?? EMPTY_STATE);
    }
    if (req.method === "GET" && url.pathname === "/api/btw/models") {
      return jsonResponse(deps.getModels());
    }
    return null;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-routes.test.ts )`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire everything into webui-wiring.ts (glue — covered end-to-end by Task 11's contract test)**

In `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts`, five additive edits:

1. Imports:

```ts
import { createBtwRoutes } from "./btw-routes";
import { createBtwForwarder, createBtwStore } from "./btw-store";
import { emitBtwCommand, onBtwEvent } from "./btw-channels";
```

2. Widen `WebuiSessionCtx` (the real `ExtensionContext` is a structural superset, per the interface's own comment — this only narrows less):

```ts
interface WebuiSessionCtx {
  abort(): void;
  ui: WebuiUi;
  modelRegistry: { getAvailable(): Array<{ provider: string; id: string; api: string }> };
}
```

(If the SDK `ModelRegistry` type is importable with the same specifier style the file already uses for other SDK types, type the member as `ModelRegistry` instead of the structural literal — both satisfy the route mapping below.)

3. In the factory body, next to where `bound` is declared, add the store + subscription (webui subscribes during factory setup, BEFORE any `session_start` fires, so it catches btw's initial thread event):

```ts
const btwStore = createBtwStore();
const forwardBtwEvent = createBtwForwarder(btwStore, (frame) => server.broadcast(frame));
onBtwEvent(pi.events, forwardBtwEvent);
```

4. In `dispatch(action)`, next to the existing `case "appexec":` block, add:

```ts
case "btw":
  if (pi.events) emitBtwCommand(pi.events, action.command);
  break;
```

5. Replace the HTTP route chain (~L370) so btw routes are consulted first:

```ts
server.setHttpRoutes(
  (req, srv) =>
    createBtwRoutes({
      getState: () => btwStore.state(),
      getModels: () =>
        (bound?.ctx.modelRegistry?.getAvailable() ?? []).map((m) => ({
          provider: m.provider,
          id: m.id,
          api: m.api,
        })),
    })(req, srv) ?? renderRoutes(req, srv) ?? outputRoutes(req, srv),
);
```

Note (soft spot): the `provider`/`id`/`api` field mapping mirrors the btw override-entry payload convention; if the SDK `Model` names a field differently (e.g. `modelId`), adjust the three keys here AND keep `BtwModelSummary` unchanged.

- [ ] **Step 6: Run the package gate**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: PASS — the widened ctx and additive glue break nothing.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/btw-routes.ts bun-apps/pi-agent-ext-webui/tests/btw-routes.test.ts bun-apps/pi-agent-ext-webui/src/webui-wiring.ts
git commit -m "feat(webui): serve /api/btw snapshot and model list, bridge bus to WS frames"
```


## Phase 3 — panel UI

