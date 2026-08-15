> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: review-pi-agent-deploy-single-exec-binary-ensure

## Destination

A locked **decision-set (spec)** that lets a portable single-exec `pi-agent-cli`
binary — copied onto a machine **without** this repo (no `node_modules`, no
`bun-apps/`, no `.pi/workflows/`) — run **any** user-supplied workflow-pack
(the pi-agent-ext-workflow pack format: a self-contained `manifest.json` + entry
`.js`, **no imports**) via the headless `pi-agent-cli workflow run <name>`
command. The spec is **verified by a real end-to-end run of a representative
pack from a foreign cwd**, then handed off to a build session.

The map **plans** (locks decisions until the way is clear); it does not build.
Execution is a separate handoff — wayfinder's default.

## Notes

- **Domain.** `bun-apps/pi-agent-cli` (the CLI + `scripts/build.ts --compile`,
  which produces `dist/pi-agent-cli/pi-agent-cli`) × `bun-apps/pi-agent-ext-workflow`
  (the pack format, the cwd-based resolver in `src/workflow-pack.ts`, and the
  `node:vm`-based engine in `src/workflow.ts`). Entry path is **headless
  `workflow run` only (Path A)**; the interactive `workflow` *tool* is NOT
  registered in this CLI's sessions (`shared.ts` bakes in only pi-obsidian).
- **Resolved scope (pinned by grilling, not tickets).**
  - Deploy target = **standalone / portable** (repo-less machine).
  - "Done" = a **locked spec handed off** (no execution carried into the map).
  - Entry path = **Path A only** (headless `workflow run`); Path B is out of scope.
  - Success bar = **general** — any conforming user-supplied pack must run.
- **Skills every session should consult.** wayfinder (work-through-the-map),
  grilling + grill-memory, domain-modeling (record crystallised decisions in
  `bun-apps/pi-agent-cli/CONTEXT.md` + `docs/adr/`).
- **Standing prefs.** Verify by actually running — always OFFER a real run.
  Test portable artifacts from a **foreign cwd** (cwd == artifact masks bugs).
  Always Bun. Plan-first.
- **Probe log (2026-07-19).** `build:exe` + foreign-cwd run confirmed: the
  workflow ext + `node:vm` engine are inlined and execute in-compile; absolute-
  path pack resolution works portably (resolver branch 1 — the option-(a) floor
  of ticket 04); the pi-default model fallback (`zai/glm-5.2`) works from a
  foreign cwd with no `--model` / no repo-local settings (model-config fog
  cleared). Evidence in tickets 01 / 02.

## Decisions so far

<!-- closed tickets — one-line gist, then open the ticket for the detail -->

- [01 — Does `--compile` inline the workflow extension?](tickets/01-compile-inlines-workflow-ext.md) — **Yes.** No `external` configured; the resolver + `vm` engine are baked into the standalone exe. The "externals" comment in `commands/workflow.ts` is inaccurate for the compile artifact.
- [02 — Execution primitive + multi-file survival in-compile](tickets/02-engine-execution-primitive-self-contained.md) — Engine runs the entry via `node:vm` (Bun builtin → works in-compile); packs must be **self-contained (no imports)**, so multi-file packs don't exist — "general runner" = read any 2-file pack folder. Execution is portable.
- [03 — Existing test coverage for the workflow command](tickets/03-existing-test-coverage.md) — Source-mode only; mocks `runWorkflowScript` and unit-tests the CLI layer (`buildMainSpec`, `parseWorkflowArgs`, `outDir`/model precedence). **No** coverage for compiled binary, foreign cwd, or a real on-disk pack. The transparent-passthrough mock pattern is reusable for a portable probe.
- [04 — Portable pack-discovery model](tickets/04-portable-pack-discovery-model.md) — Add two name-resolution tiers ranking ABOVE repo walk-up ("most local wins"): absolute-path → `<cwd>/workflows` → `<binDir>/workflows` (`dirname(process.execPath)`, verified) → repo `.pi/workflows` → repo `bun-apps/<pkg>/workflows`. Rejected `~/.pi/workflows`. Engine change in `workflow-pack.ts`; ADR warranted.

## Not yet specified

<!-- in-scope fog, not yet sharp enough to ticket -->

- **Obfuscation interaction.** `build:exe` supports `--obfuscate`; the memory
  notes the obfuscator's regex transformer is brittle on pi-obsidian's
  wiki-link/frontmatter regexes. Whether obfuscation breaks the inlined
  workflow engine is unverified. Adjoining concern — revisit only if the
  destination expands to "ship an obfuscated portable binary."

## Out of scope

<!-- work ruled beyond the destination -->

- **Path B — the interactive `workflow` tool in agent sessions.** The destination
  is satisfied by headless `workflow run` (Path A). pi-agent-cli does not
  register the `workflow` tool for interactive sessions today; adding it is a
  separate effort. Resurface only if the destination is redrawn.
- **Build distribution mechanics** — signing, notarization, version stamping,
  auto-update, installers. Beyond "can it run a workflow-pack."
- **Obfuscation/protection strength** of the shipped binary — a packaging
  concern, orthogonal to pack execution.
