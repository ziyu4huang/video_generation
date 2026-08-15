type: grilling
claimed: main-session (2026-08-15)

## Question

What is the npm-publishing fate of the three publish-ready ports (`workflow`, `superpowers`,
`wayfind`) once the in-repo package root points at `./src/`?

`package.json` `main`/`exports["."]` currently resolve to `./dist/index.js` — npm cannot ship
a `.ts` root, so repointing naively breaks `bun publish`. Candidates to decide between:

- **(a) `publishConfig` override** — dev root stays `./src/index.ts`; `publishConfig.main` /
  `publishConfig.exports` point back at `./dist/`, with `prepublishOnly` (already present on
  workflow) building first. npm applies `publishConfig` at pack time only, so Bun dev
  resolution never sees dist. Cost: publishing still requires a working tsc build (dist stays
  in the publish flow, just not the dev flow).
- **(b) Drop publishability** — `private: true`, delete `publishConfig`/`prepublishOnly`/
  `files`. Simplest; burns the npm surface. Only viable if nothing installs these from npm.
- **(c) Keep dual entries indefinitely** — rejected direction (that's today's status quo this
  effort exists to kill), listed for completeness.

Sub-question: does `webui` even belong in this decision (it has no `publishConfig` —
explorer found none — so it can migrate unconditionally under either (a) or (b))?

Blocking input: whether any external consumer installs these packages from npm (see map's
"Not yet specified" — check npm registry + upstream repos before deciding).

## Resolution

**Decision: (b) drop publishability** — user-confirmed 2026-08-15.

Evidence base for the decision:

- npm registry check (2026-08-15): `@repo/pi-agent-ext-workflow`, `-superpowers`, `-wayfind`
  all **404** on registry.npmjs.org — none of the four has ever been published. The only
  existing packages are the upstream originals (`pi-dynamic-workflows@1.0.1`,
  `@quintinshaw/pi-dynamic-workflows@3.5.1`), which this repo forks, not publishes.
- The `@repo` scope is not (and per workspace convention would not be) an owned npm org, so
  the current names could never be published without a rename anyway.

Consequence for tickets 02–05: remove `publishConfig`, `prepublishOnly`, `files`, and the
upstream `repository` field (workflow) alongside the root flip; `private: true` added.
Ticket 05 may DELETE the boot heal patch + `test:dist` gate outright (no publish flow keeps
a dist alive).

Ticket closed 2026-08-15.

