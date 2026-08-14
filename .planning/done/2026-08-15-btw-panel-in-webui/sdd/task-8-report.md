# Task 8 Report — HTTP routes + wiring glue

**Status:** DONE (TDD followed)
**Commit:** see below
**Package:** `bun-apps/pi-agent-ext-webui`

## What was done

### Step 1–4: `src/btw-routes.ts` + `tests/btw-routes.test.ts` (TDD)

- Wrote `tests/btw-routes.test.ts` first (verbatim from the brief: 4 tests — snapshot + headers, empty default state, model list, route-chaining fall-through). Verified FAIL (unresolvable `../src/btw-routes`).
- Created `src/btw-routes.ts` per brief: `createBtwRoutes(deps: BtwRoutesDeps): HttpRouteHandler` with `BtwRoutesDeps = { getState(): BtwThreadState | null; getModels(): BtwModelSummary[] }`, `BtwModelSummary = { provider; id; api }`. `GET /api/btw` returns `getState() ?? EMPTY_STATE`; `GET /api/btw/models` returns `getModels()`; both `application/json; charset=utf-8` + `Cache-Control: no-store`; other paths → `null` (chain fall-through).
- Verified 4/4 PASS.

### Step 5: wiring glue in `src/webui-wiring.ts` (five additive edits)

1. Imports: `createBtwRoutes`, `createBtwStore`/`createBtwForwarder`, `emitBtwCommand`/`onBtwEvent` (`.js` specifiers, matching file convention).
2. `WebuiSessionCtx` widened with `modelRegistry: { getAvailable(): Array<{ provider; id; api }> }` (structural slice; real ExtensionContext remains a superset).
3. Factory-body seam next to `bound`: `btwStore` + forwarder broadcasting the `btw` WebFrame via `server.broadcast`; subscribed during factory setup (pre-`session_start`) so btw's initial thread event is captured. **Deviation from brief (typing):** brief's verbatim `onBtwEvent(pi.events, forwardBtwEvent)` fails tsc because `pi.events` is `RenderHostEvents | undefined` and `onBtwEvent`'s bus param is non-optional; guarded as `if (pi.events) onBtwEvent(pi.events, forwardBtwEvent)` — same guarded-seam convention the file already uses for the render seams.
4. `dispatch` gained `case "btw": if (pi.events) emitBtwCommand(pi.events, action.command); break;` — not agentic, bypasses mutex/pending registry by construction (separate switch case).
5. `setHttpRoutes` chain now consults btw routes FIRST: `createBtwRoutes({ getState: () => btwStore.state(), getModels: () => (bound?.ctx.modelRegistry?.getAvailable() ?? []).map(...) })(req, srv) ?? renderRoutes(req, srv) ?? outputRoutes(req, srv)`. Model mapping mirrors the btw override-entry `provider/id/api` convention (brief soft spot: keys verified against `BtwModelRef` in btw-channels.ts — identical names, no adjustment needed).

### Step 6: package gate

`( cd bun-apps/pi-agent-ext-webui && bun run test )` → **306 pass / 0 fail** (includes `bunx tsc` build + full unit suite). The widened `WebuiSessionCtx` and additive glue broke nothing.

## Deviations / notes

- **Guarded `onBtwEvent` subscription** (see above) — the only textual deviation from the brief; required by tsc.
- `getModels` uses `bound?.ctx.modelRegistry?.getAvailable() ?? []` — pre-`session_start` (or a host ctx without the registry) yields `[]`; the panel refetches after connect.
- Known deferred quirk respected: no assumption that a btw dispose emits anything; the store simply holds the last snapshot.

## Concerns

- None blocking. The `provider/id/api` mapping is pinned only by the structural type; Task 11's contract test covers the glue end-to-end.

## Completion note

Tested + committed by mechanical follow-up dispatch (zk-spawn): implementer dispatch ran out of budget after staging. Reviewer is the compliance gate.
