# Task 1 Report — appexec respond shape (zk-spawn, HITL-webui Phase 1)

- **BASE**: `7279fec6ea57e96205d1d8398dde793cef659587` (origin/main)
- **HEAD**: `33bae1c6c9020e62ee373f8314d3736bd065156a` (branch `hitl-webui-phase1`)
- **Commit message**: `feat(webui): appexec respond shape — parseCommand surfaces extra (HITL return transport T1)`

## What changed (per file)

### `bun-apps/pi-agent-ext-webui/src/protocol.ts`

1. `AppExecCommandSchema` JSDoc replaced (schema object literal byte-identical) — now documents `appexec`
   as the HITL return transport recognizing `{ kind: "respond", id, action, tweak? }` in `extra`, with the
   schema deliberately loose (unknown-op frames VALIDATE then are IGNORED at parse time, spec §6).
2. `DispatchAction` appexec variant tightened from the loose
   `| { kind: "appexec"; op: string; [k: string]: unknown }` to the typed respond shape:

```ts
  | {
      kind: "appexec";
      op: "respond";
      id: string;
      action: string;
      tweak?: string;
    }
```

### `bun-apps/pi-agent-ext-webui/src/web-transport.ts`

`parseCommand` `case "appexec":` rewritten: validates the respond sub-shape in `extra`
(`kind === "respond"`, string `id`, string `action`, `tweak` undefined-or-string) and surfaces the typed
descriptor; anything else (no `extra`, unknown op, malformed respond) returns `null` (ignored at parse
time). `tweak` is only set on the output object when it is a string, so the descriptor never carries an
explicit `tweak: undefined` (keeps `toEqual` exact).

```ts
      case "appexec": {
        const extra = frame.extra;
        if (
          extra?.kind === "respond" &&
          typeof extra.id === "string" &&
          typeof extra.action === "string" &&
          (extra.tweak === undefined || typeof extra.tweak === "string")
        ) {
          const out = { kind: "appexec", op: "respond", id: extra.id, action: extra.action };
          if (typeof extra.tweak === "string") out.tweak = extra.tweak;
          return out;
        }
        return null;
      }
```

### `bun-apps/pi-agent-ext-webui/tests/web-transport.test.ts`

The single `appexec -> bypass descriptor (NOT agentic; NO source field)` test (which asserted the drop)
was replaced by the plan's seven-test focused set:

1. respond (id+action) → typed bypass descriptor `{kind, op:"respond", id, action}`
2. respond with tweak → tweak surfaced
3. respond is NOT agentic (no `source` field) — bypasses the mutex
4. no `extra` → `null` (ignored at parse time, spec §6)
5. unknown op in `extra` (`kind:"nope"`) → `null` (ignored, NOT rejected by schema)
6. malformed respond (missing id / missing action) → `null`
7. non-string `tweak` (number 5) → `null`

## Test evidence

- **Red (before implementation)** — `( cd bun-apps/pi-agent-ext-webui && bun test tests/web-transport.test.ts )`:
  `26 pass / 6 fail` — the 6 failing tests are exactly the new appexec shape/ignore assertions
  (old code returned `{ kind: "appexec", op: "appexec" }` and dropped `extra`). The 7th new test
  ("NOT agentic — no source") passed trivially under the old shape too (it also lacked `source`).
- **Green (after implementation)** — `( cd bun-apps/pi-agent-ext-webui && bun test )` (FULL suite):
  `232 pass / 0 fail` (`Ran 232 tests across 22 files`).
- **Type gate** — `( cd bun-apps/pi-agent-ext-webui && bun run build )` (`bunx tsc` over `src/**`): exit 0.

## Staged set verification

`git diff --cached --name-only` before committing showed exactly:

```
bun-apps/pi-agent-ext-webui/src/protocol.ts
bun-apps/pi-agent-ext-webui/src/web-transport.ts
bun-apps/pi-agent-ext-webui/tests/web-transport.test.ts
```

## Deviations from plan.md

None in substance. Two presentational-only notes:

- The `out` literal in web-transport.ts declares its full object type explicitly (per plan 3c verbatim);
  the snippet above abbreviated it for readability only — the committed code is the plan's verbatim form.
- Commit message uses the task brief's variant (`parseCommand surfaces extra (HITL return transport T1)`)
  rather than the plan's Step-5 variant (`typed DispatchAction + parseCommand surface`); same intent,
  the brief's instruction was followed.

## Concerns

None. Task 2's `dispatch` consumes exactly the produced variant
`{ kind:"appexec"; op:"respond"; id:string; action:string; tweak?:string }`; the narrowed union makes
`action.id` / `action.action` / `action.tweak` available without an `as` (tsc exit 0 confirms).
