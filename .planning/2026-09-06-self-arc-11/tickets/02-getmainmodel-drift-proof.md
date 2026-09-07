# t02 — getMainModel honesty: stale comment + inheritance receipt legs

## Verified findings

- Ledger (a) premise is STALE. Wiring EXISTS and is populated:
  - `extensions/subagent.ts:74` `mainModelHolder` — `:110` and `:164` wire
    `getMainModel: () => mainModelHolder.current` into both tools;
  - `session_start` populates it (`:311`, `ctx.model`), `model_select`
    re-populates on `/model` switches (`:319`);
  - consumption chain: `src/subagent-tool.ts:300` → `modelCtx` `:402` →
    core-runtime `agent-model.ts:67` (session default = mainModel),
    `:123` (scope clamp prefers mainModel).
- Doc drift: `src/subagent-tool-render.ts:113–118` comment says "getMainModel
  is not wired in production" — the opposite of the registration file.
- Receipt machinery: `tui-drive.ts:75` `--expect-model` (default `/glm/`)
  latches `receipt.checks.modelIsGlm` (`:1056`) on `receipt.modelLine`.

## Implementation

1. Rewrite the stale comment in `subagent-tool-render.ts` (~:113–118) to
   state the truth: untagged dispatches resolve to the parent session model
   via the session_start-captured holder; the "default" placeholder guard
   stays (it protects detached-resume hosts where session_start never fired).
2. Verify `receipt.modelLine` captures the RESOLVED model (post
   `onModelResolved`), not just the requested slot. If slot-only, extend the
   modelLine capture to include the resolved modelSeg (renderCall already
   re-reads the registry per tick).
3. Explicit inheritance latch: add `receipt.checks.inheritedParentModel` —
   modelLine matches `--expect-model` on an UNTAGGED dispatch (no model/
   tier/capability args in the driven prompt).

## Tests + receipt design

- Unit: update/extend the render test that asserts the omission behavior if
  it quotes the stale comment (grep tests for "not wired").
- Receipt (source leg): `--scenario dispatch --expect-model <stub-session
  model id>` — assert BOTH `modelIsGlm`-style and the new inheritance check.
- Receipt (deployed leg, learning #1 — verify the artifact, not the label):
  - `grep -c getMainModel <versionDir>/s2-agent.js` ≥ 3 (property name
    survives minification: two wirings + schema option);
  - re-run the dispatch receipt on the deployed tree.

## Risks / descope

- None material. If modelLine proves slot-only and the extension is fiddly,
  the minimal honest fallback is the comment fix + deployed grep leg only —
  still closes the ledger item.
