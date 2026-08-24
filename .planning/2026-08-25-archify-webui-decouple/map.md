---
effort: 2026-08-25-archify-webui-decouple
created: 2026-08-25
last: 2026-08-25
status: complete
---
# archify-webui-decouple — ext-webui out of the static/deploy extension set; archify↔webui contract made explicit

## Destination

`s2-agent-ext-webui` leaves the STATIC registration set (and stays deploy-excluded),
so the s2-agent static bundle no longer imports webui at all; the archify↔webui
seam is recorded as an explicit one-way contract — archify announces on the optional
host event bus, webui subscribes, neither imports the other — with ownership
documented on both sides.

## Context (measured 2026-08-25 on this machine, worktree video_generation__deploy @ branch archify-webui-decouple off origin/main)

- **No hard coupling exists in either direction.** `grep webui` over
  `bun-apps/s2-agent-ext-archify/{src,extensions}` returns zero imports — every hit
  is a comment, a docstring, or an emit-channel string. `grep archify` over
  `s2-agent-ext-webui/{src,extensions}` likewise: the Diagram pane serves artifacts
  by payload path, never by import. Neither package lists the other in `package.json`.
- **The event contract is 1 emitter → 1 subscriber.** Emitters of `"webui:open"` /
  `"webui:present"` / `"webui:deck"`: exactly `archify/src/open-announce.ts:24,27,94`.
  Subscribers: exactly `webui/src/webui-wiring.ts:1019,1033,1082`. String-literal
  channels on the optional host bus (`OpenBus = { emit?: … }`, structural slice,
  `open-announce.ts:4`), inert-guarded (`events?.emit?.`) — no bus ⇒ no effect.
- **`webui:open`/`webui:present` events are REPLAYED** (`webui/src/protocol.ts:150`,
  webui-wiring replay filter `:1374` passes those names through) — a channel rename
  would strand every persisted event recorded under the old name.
- **The static seam is three files, two derived.** `s2-agent/src/registry-config.ts:349-367`
  (webui entry, `load: "static"`, `skills: true`, `enabled: true`, no deploy block,
  `excludeReason` per the registry invariant) → `src/static-extensions.ts:104,133`
  (GENERATED import + factory row, via `regen:static`) → `src/run-dir/manifest.json:47,66`
  (GENERATED, via `regen:manifest`: skills dir + `staticExtensions[]`).
  Hand-written = the one registry entry only.
- **Dynamic loading is a well-trodden lane**: 9 entries already `load: "dynamic"`
  (tool-gate, devops, flux2, krea2, ltx, research-tool, zai-mcp, movie-director, …);
  source mode loads them via `-e`, no bundle import.
- **Webui is deploy-excluded since 2026-08-24** (user decision, recorded in the
  registry entry's own notes: "Loads in source mode as before; does not ship.
  Re-include = give it a deploy block again (order 110)").
- **Host-side `--no-webui` / `--webui-port` CLI flags are load-mode independent**:
  `s2-agent/src/cli-argv.ts:115-153` parses them from PRE-patch argv and
  `cli.ts:73-75` translates to `WEBUI_DISABLED`/`WEBUI_PORT` env — they merely set
  env the (absent) webui would read; harmless under any load mode.

## Tickets

Single mechanical move — no ticket decomposition. One PR:
- registry `load: "static"` → `"dynamic"` + regen:manifest + regen:static + contract
  documentation (this map's Decisions) + gates.

## Decisions

- **D1 (CONFIRMED by user 2026-08-25): `load: "dynamic"`, not removal
  and not `enabled: false`.** Reason: the 2026-08-24 user decision keeps webui loading
  in source mode ("local operator browser UI"); dynamic is the only mode that both
  removes it from the static import set AND preserves source-mode loading.
  `enabled: false` would disable it everywhere (hyperframes treatment) — a different,
  stronger decision than the directive states.
- **D2 (CONFIRMED by user 2026-08-25): keep the `webui:*` channel
  strings; resolve the seam by INVERSION, documented.** Reason: the data flow is
  already inverted (archify announces, webui subscribes, zero imports); renaming the
  channels to "neutral" names is cosmetic churn that strands every replayed event
  recorded under the old names (Context above) and risks a missed subscriber in a
  rename sweep. Ownership gets DOCUMENTED instead: the channel trio is an
  archify-owned announce contract with frozen names; webui's CONTEXT.md records it
  as an inbound dependency.
- **D3: s2-agent host CLI flags (`--no-webui`, `--webui-port`) stay.** They predate
  the decoupling, are env-only seams, and removing them changes user-facing CLI
  surface for no coupling win.

## Frontier

cleared — PR #2007 merged CLEAN 2026-08-25 (mergeSha 19d2fea0, branch swept).

Both fog items resolved at execution: `regen:static` output dropped the webui
import + factory row (no generator surgery needed beyond deleting the dead
`ROW_COMMENTS.webui` key); no test pins webui's presence in `staticExtensions[]`
(`manifest-consistency.test.ts` green through the regen). Gates: s2-agent 1064 /
archify 720 / webui 627 tests 0 fail; schema-cost canary measured webui as before
(dynamic entries stay registered); local_ci pass 68.8s ≤ 300s budget; deploy +
verify-deploy-e2e pass on the new dist (boot/ext-load/tools-probe/model-call/
vision-call/file2md-ocr all pass; tool-gate-fire skip = not in deploy set).

Carry: s2-agent version NOT bumped through #2007 (still 0.7.10, merge-tool
advisory) — fold the bump into the next s2-agent PR (round-2 simplify).

## Fog of war

- Whether `regen:static` output for a dynamic webui keeps or drops its description
  row in `static-extensions-gen.ts:128` (the description map used by the generator) —
  inspected at execution time; if the map keys off registry entries rather than load
  mode it may need the webui row moved alongside.
- Whether any test pins webui's presence in `staticExtensions[]`
  (`manifest-consistency.test.ts` covers the manifest; not yet read end-to-end).
- schema-cost canary: webui stays REGISTERED (dynamic), so it stays measured —
  expected no-drift, but the canary output is the receipt.

## Cross-effort links

- **Builds-on**: `.planning/2026-08-24-registry-code-as-config` — the REGISTRY module
  + zero-import contract (its D4) is what makes this move a one-entry data change
  instead of a YAML/codegen excavation.
- **Shares-decision-with**: `.planning/2026-08-15-archify-webui-html` (archived) —
  that effort BUILT the `webui:open` `/files` contract this effort freezes and
  documents; no code it shipped changes here.
