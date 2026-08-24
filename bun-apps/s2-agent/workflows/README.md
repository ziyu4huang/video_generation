# s2-agent engine workflows

Deterministic workflows running on the s2-agent-ext-ultracode engine. They
live in engine dirs (`bun-apps/<pkg>/workflows/`) on purpose: the gate /
retry / loopUntilDry / journaling / resume primitives exist ONLY in that
engine vm. Two runtimes share the script syntax but not the gates — the
interactive `workflow` tool's `name` param hits the real engine through the
shared resolver (`workflow-pack.ts`); Claude Code's `Workflow` tool is
best-effort only.

> The former `s2-agent cli workflow run <name>` headless namespace was
> removed 2026-08-25 (ultracode TRIM — usage receipts in
> `../CONTEXT.md` "Workflow CLI surface (removed)"). Headless drivers import
> the engine directly, e.g.
> `bun-apps/s2-agent-ext-flux2/scripts/self-improve-loop.driver.ts`
> (`runWorkflow` from `s2-agent-ext-ultracode/src/workflow.ts`).

## Packs

A **workflow pack** is a folder with `manifest.json` + an entry script,
run exactly like a single-file script. Manifest schema, resolution precedence
(literal path → `PWD/.pi/workflows/` → `bun-apps/<pkg>/workflows/` → `<name>.js`),
and manifest-vs-override `model`/`args` precedence are enforced by the
resolver — see `s2-agent-ext-ultracode/src/workflow-pack.ts` and
[ADR 0008](../docs/adr/0008-portable-workflow-pack-discovery.md).

Example packs (hermetic; regression-covered by
`s2-agent-ext-ultracode/tests/workflow-pack.test.ts`, which runs these REAL
packs against the engine):

- `echo/` — minimal smoke: manifest + one `agent()`. Expected `agents=1`.
- `args-demo/` — manifest `args` + `parallel()` fan-out. `agents=2` default, `3` with args override.
- `sample/` — every manifest field + `pipeline()`/`phase()`/`log()`. `agents=3`.

The deterministic regression invariant is the **agent count** — not reply
text or wall-clock.

## knowledge-distill

WRITE-side distill: atomises a source into graph-linked vault cards under
engine gates. A single-file script (not a pack); its args (`pr` / `sources` /
`folder` / `maxNotes` / `minCards` / `knowledgeFile` / `vault`) are documented
in the `knowledge-distill.js` header. Run it by name in an s2-agent session
(the `workflow` tool resolves `bun-apps/<pkg>/workflows/`), or headless via a
small driver script on the engine API (see the flux2 driver above).

Pipeline: resolve → baseline → distill (gated `zk-extract`) → optional
graph-link (`zk-ingest`) → garden gate (`zk-card check` + `zk-query --health`,
0 dead-links) → history receipt. Writes only to the target vault folder +
history; never touches source or git.
