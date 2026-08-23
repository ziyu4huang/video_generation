# compose-hyperframes dispatch action — design

## Problem

`bun-apps/pi-agent-ext-movie-director/src/hyperframes_native.ts` (`renderHyperframes()`)
ships a fully working third composition tier — provider registry (`registry.ts`), runtime
probe (`providers.ts`), and adapter (`composeHyperframesAdapter`) are all wired to the
`compose:hyperframes` capability. But the agent-facing tool router, `dispatch.ts`, has no
case for it: only `compose`, `compose-remotion`, `compose-motion`, and `pre-compose` exist
as callable commands.

The `animated-explainer.yaml` pipeline manifest (`data/pipeline_defs/animated-explainer.yaml:236`)
already lists `hyperframes_compose` in the `compose` stage's `tools_available`, and even
has governance language about it (`hyperframes lint`/`validate` must pass before render).
That declaration has never had anything to implement it — no agent can actually invoke it.
`providers.ts`'s `composeHyperframesAdapter` already defaults `command: req.command ||
"compose-hyperframes"`, anticipating this exact command name.

This spec closes that one gap: add `compose-hyperframes` as a real dispatch command,
mirroring the existing `compose-remotion` case exactly (same edit-decision shape, same
pre-compose gate enforcement, same error contract).

Out of scope (deferred, per explicit decision): `edit.audio` (narration/music) support
inside `hyperframes_native.ts`, and any rewording of `animated-explainer.yaml`'s
`tools_available`/`review_focus` prose.

## Design

### `dispatch.ts`

- Add `"compose-hyperframes"` to the `COMMANDS` `as const` array, positioned after
  `"compose-motion"` and before `"pre-compose"` (matches the manifest's declared tier
  ordering: compose → compose-remotion → compose-motion → compose-hyperframes → pre-compose).
  This alone propagates the new command through the `Command` type, the `COMMAND_ENUM`
  TypeBox schema, and `host-fns.ts`'s `buildMovieHostFnEntries()` (which iterates
  `COMMANDS`) — no separate registration needed in those places.
- Import `renderHyperframes` from `./hyperframes_native.ts`.
- Add a new `case "compose-hyperframes":` block, structurally identical to the existing
  `case "compose-remotion":` block:
  - Validate `opts.editDecisions` is present and `.cuts` is an array; on failure return
    `{ ok: false, error: "compose-hyperframes requires {editDecisions:{version,cuts:[...]}}" }`.
  - Run `enforcePreCompose(edit, opts)` and return its failure result unmodified if it
    returns non-null (same gate `compose`/`compose-remotion`/`compose-motion` all enforce).
  - Resolve `workDir` the same way (`opts.workDir` or `projectDir(opts.projectId ??
    "_compose_hyperframes")`).
  - Call `renderHyperframes(edit, { workDir, output, width, height })` — no `fps`,
    `captions`, or `transitionSeconds` options, because `HyperframesComposeOptions` doesn't
    accept them (`transitionSeconds` is read from `edit.transitionSeconds` internally by
    `hyperframes_native.ts`, same as `compose-remotion`'s pattern — not a separate dispatch
    param).
  - Return `{ ok: true, text: jsonOut(report) }`.
- Extend the top-of-file command reference text block with a `• compose-hyperframes` entry
  in the same style as the existing `compose-remotion`/`compose-motion` entries, explicitly
  noting: same `editDecisions` shape as compose-remotion; v1 does not wire `edit.audio`
  (narration/music) — use `compose-remotion` when audio is required; enforces the same
  pre-compose gate; returns a `render_report` with `render_grammar:'hyperframes'`.

### `host-fns.ts`

- Add `"compose-hyperframes": 900_000` to `HOST_FN_TIMEOUT_MS`, matching the other three
  compose tiers' long timeout (compose/compose-remotion/compose-motion are all 900s; a
  headless-Chrome render is not faster than the others).

### `host-fns.test.ts`

- Add `"compose-hyperframes"` to the array in the `"compose-motion / compose-remotion /
  compose have long timeouts"` test (currently asserts `["compose-motion",
  "compose-remotion", "compose"]`), so the new timeout entry is actually verified rather
  than just present.

### No changes needed (verified, not assumed)

- `precompose-gate.ts`: the total-duration formula already branches only on
  `edit.render_runtime === "ffmpeg"` (sum) vs. everything else including `"hyperframes"`
  and `undefined` (max/absolute-timeline) — `"hyperframes"` already gets correct semantics
  with zero changes.
- `selector.ts` / `registry.ts`: `selectProvider()` is not in the call path of any direct
  `compose*` dispatch case (including the existing `compose-remotion`/`compose-motion`) —
  those call the render function directly. `compose-hyperframes` follows the same pattern.
- `commands.ts` / `cli.ts`: both are generic wrappers over the `Command` union type: they
  pick up `"compose-hyperframes"` automatically once it's in `COMMANDS`.
- `manifest-consistency.test.ts`: unrelated (pipeline-manifest schema consistency, not
  dispatch command coverage).

## Testing

`renderHyperframes()`'s own logic is already covered by `hyperframes_native.test.ts`'s 18
tests (composition generation, binary resolution, render success/failure paths). The new
dispatch case needs coverage at the dispatch layer only for the two behaviors it adds on
top of `renderHyperframes()` — matching the existing test posture for `compose-remotion`
(which also has no dispatch-level end-to-end test requiring a real binary):

1. `dispatch("compose-hyperframes", {})` (no `editDecisions`) → `{ ok: false, error:
   "compose-hyperframes requires {editDecisions:{version,cuts:[...]}}" }`.
2. `dispatch("compose-hyperframes", { editDecisions: <edit that fails pre-compose> })` →
   returns the pre-compose gate's failure result, never reaching `renderHyperframes()`
   (verifiable by asserting the gate's characteristic error shape, matching how
   `compose-motion`'s equivalent gate behavior is tested in `precompose-gate.test.ts`).

Full existing suite (`bun test` in `bun-apps/pi-agent-ext-movie-director/`) must stay green
throughout.

## Non-goals

- No change to `hyperframes_native.ts` itself.
- No `edit.audio` support.
- No changes to `animated-explainer.yaml` or any other pipeline manifest.
- No changes to `driver-wiring.ts`'s deterministic `run-pipeline` compose stage (it stays
  hardcoded to `compose-motion`; wiring runtime selection there is a separate, larger
  decision explicitly deferred in this session's scoping conversation).
