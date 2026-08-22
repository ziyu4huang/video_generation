# s2-agent CLI engine workflows

Deterministic workflows run via `s2-agent cli workflow run <name>` (`--help`
for flags). They live in engine dirs (`bun-apps/<pkg>/workflows/`) on purpose:
the gate / retry / loopUntilDry / journaling / resume primitives exist ONLY in
the s2-agent-ext-ultracode engine vm. Two runtimes share the script syntax but
not the gates — `workflow run` and the `workflow` tool's `name` param hit the
real engine through one shared resolver (`workflow-pack.ts`); Claude Code's
`Workflow` tool is best-effort only.

## Packs

A **workflow pack** is a folder with `manifest.json` + an entry script,
run exactly like a single-file script. Manifest schema, resolution precedence
(literal path → `PWD/.pi/workflows/` → `bun-apps/<pkg>/workflows/` → `<name>.js`),
and `--model`/`--args` precedence are enforced by the resolver — see
`s2-agent-ext-ultracode/src/workflow-pack.ts` and
[ADR 0008](../docs/adr/0008-portable-workflow-pack-discovery.md).

Example packs (hermetic; regression-covered in `src/cli/__tests__/workflow.test.ts`):

- `echo/` — minimal smoke: manifest + one `agent()`. Expected `agents=1`.
- `args-demo/` — manifest `args` + `parallel()` fan-out. `agents=2` default, `3` with `--args`.
- `sample/` — every manifest field + `pipeline()`/`phase()`/`log()`. `agents=3`.

The deterministic regression invariant is the **agent count** (add `--json`
for the receipt) — not reply text or wall-clock.

## knowledge-distill

WRITE-side distill: atomises a source into graph-linked vault cards under
engine gates. A single-file script (not a pack); its args (`pr` / `sources` /
`folder` / `maxNotes` / `minCards` / `knowledgeFile` / `vault`) are documented
in the `knowledge-distill.js` header.

```bash
bun --cwd bun-apps/s2-agent src/cli.ts cli workflow run knowledge-distill \
  --model lm-studio/google/gemma-4-12b --thinking low \
  --args '{"pr":[244,242],"folder":"Zettelkasten/distill"}'
```

Pipeline: resolve → baseline → distill (gated `zk-extract`) → optional
graph-link (`zk-ingest`) → garden gate (`zk-card check` + `zk-query --health`,
0 dead-links) → history receipt. Writes only to the target vault folder +
history; never touches source or git.
