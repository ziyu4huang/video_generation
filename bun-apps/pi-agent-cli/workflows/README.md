# pi-agent-cli engine workflows

Deterministic workflows runnable via `pi-agent workflow run <name>` — these live
in the **engine dir** (`bun-apps/<pkg>/workflows/`) on purpose: the
gate / retry / loopUntilDry / journaling / resume primitives only exist in the
pi-agent-ext-workflow engine vm, NOT in Claude Code's `Workflow` tool. See
`docs/workflow-cli.md` (two-runtime boundary).

## knowledge-distill

WRITE-side distill pipeline. Takes a codebase source and atomises it into
graph-linked vault cards under engine gate control.

```bash
bun --cwd bun-apps/pi-agent-cli src/cli.ts workflow run knowledge-distill \
  --model lm-studio/google/gemma-4-26b-a4b-qat --thinking low \
  --args '{"pr":[244,242],"folder":"Zettelkasten/distill","maxNotes":14,"minCards":10}'
```

Args:
- `pr` — PR number **or array** of numbers (fetched via `gh`, rendered to md).
- `sources` — array of markdown/text file paths (alternative to `pr`).
- `folder` — vault target folder (default `Zettelkasten/distill`).
- `maxNotes` — hint passed to `zk-extract --max-notes` (default 16).
- `minCards` — success threshold for net-new cards (default 10).
- `knowledgeFile` — optional `.knowledge.jsonl` for the `zk-ingest` graph-link phase.
- `vault` — override vault path (default `<root>/vaults_root/pi-agent-vault`).

Pipeline:
1. **Resolve** — repo root, vault, source list; fetch PR thread(s) → md.
2. **Baseline** — count cards in the target folder + `zk-query --health` snapshot.
3. **Distill** — `pipeline()` over sources; each runs `zk-extract` under a
   `gate()` that retries on failure (validator: exitOk && notesCreated > 0).
4. **GraphLink** *(optional)* — `zk-ingest` when `--knowledge-file` is given.
5. **Garden** — `gate()` around `zk-card check` + `zk-query --health`; validator
   requires `graphHealth.ok && deadLinks == 0`; failure feedback triggers a
   repair retry.
6. **Persist** — history receipt at
   `.claude/workflows/history/knowledge-distill/<RUN_ID>.json` carrying
   `cardsBefore/After`, `netNew`, `distill.trace`, `garden` verdict, and
   `healthBefore/After`.

### Live proof (2026-07-04)

Two-PR run (`pr:[244,242]`) → 9 atomic cards (5 + 4), both distill gates green
on attempt 1, garden gate OK, `graphHealth OK before→after`, 0 orphans / 0
dead-links, every card carries a `## 連結` section with `[[]]` links. Receipt:
`.claude/workflows/history/knowledge-distill/2026-07-04T16-41-35.json`.

The `netNew ≥ minCards` (10) target is **model-dependent** (how aggressively
the distill model splits source into atomic notes), not a workflow-determinism
property — the gate / retry / garden / health machinery is deterministic and
ran clean. A third source clears the ≥10 bar; the workflow itself is correct.

### Safety

Writes only to the target vault folder + the history receipt. Never touches
source code, never git-applies, never pushes. The garden gate is a floor (no
orphans / dead-links), not a ceiling on card quality — the READ-side retrieval
loop (`retrieval-quality-self-improve`) is the real quality signal.
