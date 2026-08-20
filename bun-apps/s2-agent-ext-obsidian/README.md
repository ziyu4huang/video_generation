# pi-obsidian

Obsidian integration as a [pi](https://pi.dev) package. Gives the pi agent
tools to read/write/search a project-local Obsidian vault and open notes in the
Obsidian app. Fresh vaults are auto-seeded with starter notes on first use.

## What you get

**Tools** (callable by the LLM):

| Tool | Description |
|------|-------------|
| `obsidian_list` | Recursively list `.md` notes under a folder |
| `obsidian_read` | Read a note's contents |
| `obsidian_create` | Create or overwrite a note (overwrite guard + mtime conflict detection; auto-creates parent folders) |
| `obsidian_append` | Append text to a note (creates it if missing) |
| `obsidian_append_section` | Insert text under a heading; creates the heading if absent |
| `obsidian_search` | Full-text search (substring/regex/words/fuzzy), field/folder filters, relevance/recency sort, context snippets, groupByFile, and graph queries (`graph`: backlinks/outgoing/orphans/dead-links/neighbors) |
| `obsidian_semantic_search` | Meaning-based (vector) search via an external [vault-mind](https://github.com/reza899/vault-mind) ChromaDB service. Finds cards whose wording differs from the query but is conceptually on-point — the complement to lexical `obsidian_search`. Optional infrastructure: see [Semantic search](#semantic-search-optional) |
| `obsidian_query` | Structured metadata query (Dataview-lite): filter by tags (AND/OR), folder, created date — index-only, no body reads |
| `obsidian_move` | Move/rename a note and auto-rewrite all inbound `[[wiki-links]]` |
| `obsidian_rename` | Same-directory rename alias of `move` |
| `obsidian_delete` | Delete a note + strip inbound links (requires `confirm:true`) |
| `obsidian_update_frontmatter` | Merge frontmatter keys without touching the body (tags unioned) |
| `obsidian_invalidate` | Force-clear read cache + vault index after external edits |
| `obsidian_open` | Open a note or the whole vault in the Obsidian app |
| `obsidian_distill` | Distill markdown/text into atomic Zettelkasten notes (subagent) |
| `obsidian_garden` | Audit/repair vault graph health (subagent) |
| `obsidian_status` | Introspect the active vault: path, name, resolution source, note count, stale warnings, all candidates |

**Commands:**

| Command | Description |
|---------|-------------|
| `/obsidian [note]` | Open the vault (or a note) in Obsidian |
| `/obsidian-init` | Register the project vault folder with the Obsidian app |
| `/obsidian-config` | Show / set the active vault — see [Vault configuration](#vault-configuration) |

**Auto-seed:** On first run, if `<cwd>/vault/` is empty, the bundled
`vault-template/` starter notes (README, Inbox, Templates, Tags MOC) are copied
in so you start with a structured knowledge base.

## Vault resolution

Resolution runs top-down (first match wins):

| Tier | Source | What it is |
|------|--------|------------|
| **1a — explicit** | `OB_VAULT_PATH` env | Absolute path; overrides everything (for CI / one-off runs) |
| **1b — personal** | `~/.pi/obsidian_config.json` `vault_path` | Your **user-global default** — the vault that follows you across every project. `vault_path` only (absolute, machine-local); `mode` is **not** honored here. Written by `/obsidian-config <path>` (default scope). |
| **1c — project** | `<cwd>/.pi/obsidian_config.json` `vault_path` | Per-project override. Full schema (`vault_path` + `mode`); skipped when `mode: "app"`. Written by `/obsidian-config <path> --scope project`. |
| **2 — auto-follow app** | `obsidian.json` `open: true` vault | The vault currently open in the Obsidian app — what you see is what the agent uses |
| **3 — fallback** | `<cwd>/${OB_VAULT_DIR \|\| "vault"}` | Zero-config project-local folder, auto-created + seeded on first use |

**Personal beats project:** the personal tier (1b) always wins over the project
tier (1c) — a project cannot override your personal default short of an env
var. Set your usual vault once at `~/.pi` and it applies everywhere; use
`--scope project` only when a specific project needs a different vault.

**Stale-config handling:** if a Tier 1 target is configured but its path no
longer exists, resolution does **not** abort — it records a warning and falls
through to Tier 2 / 3, so the agent keeps working instead of silently pointing
at a ghost path (or creating an empty `./vault` and confusing you). The warning
surfaces in `/obsidian-config`, `obsidian_status`, and the `vault:` header line
prepended to every `zk_*` tool result.

**Legacy env vars** still honored: `OB_VAULT` (named vault from `obsidian.json`)
and `OB_USE_GLOBAL` (skip Tier 3 fallback and resolve only from `obsidian.json`).

## Vault configuration

`/obsidian-config` is the human-friendly way to inspect and steer vault
resolution. All `obsidian_*` and `zk_*` tools operate on whichever vault it
reports as active.

```
/obsidian-config                      # show active vault + source + all candidates
/obsidian-config <path>               # set personal vault (~/.pi; mode "explicit"), e.g.
                                      #   /obsidian-config ./my-vault
                                      #   /obsidian-config /abs/path/to/vault
/obsidian-config <path> --scope project  # set a PROJECT-scoped vault (<cwd>/.pi)
/obsidian-config --use-app            # follow the Obsidian app's open vault (always project scope)
/obsidian-config --list               # list all registered vaults
/obsidian-config --clear              # forget the personal path (--scope project clears the project one)
```

There are two persistent config files:

| Location | Scope | Honors `mode`? |
|----------|-------|----------------|
| `~/.pi/obsidian_config.json` | **personal** (user-global default — Tier 1b) | **No** — `vault_path` only; a stray `mode: "app"` is warned about and ignored |
| `<cwd>/.pi/obsidian_config.json` | **project** (per-project override — Tier 1c) | Yes (`"explicit"` default, or `"app"`) |

```json
{
  "vault_path": "/abs/path/to/vault",   // absolute, or cwd-relative (project tier) / HOME-relative (personal tier)
  "mode": "explicit"                      // project tier only — "explicit" (default) or "app"
}
```

`mode: "app"` (project tier) makes the agent follow whatever vault you have
open in the Obsidian app — convenient when you switch vaults in the app and want
the agent to follow without editing config. Tier 1 env (`OB_VAULT_PATH`) always
wins over both tiers, so CI can pin a vault regardless of config/app state.

> **`run-dir/obsidian_config.json` is retired.** Earlier versions wrote the
> persistent config to `run-dir/`; that location is no longer read or written.
> On first read, any pre-existing `run-dir/obsidian_config.json` is migrated
> once into `<cwd>/.pi/obsidian_config.json` (and the old file removed).

## Install

### Local path (development, zero-network)

```bash
# global (all projects)
pi install ./packages/pi-obsidian

# project-local (shared via .pi/settings.json)
pi install -l ./packages/pi-obsidian
```

### npm (once published)

```bash
pi install npm:pi-obsidian
```

### Try without installing

```bash
pi -e ./packages/pi-obsidian
```

### Important: git sources and subdirectories

pi treats a git repo's **root** as the package root and scans conventional
directories (`extensions/`, `skills/`, …). This package lives in a subdirectory
(`packages/pi-obsidian/`), so `pi install git:github.com/you/repo` will **not**
find it. Options:

1. Use **local path** (`./packages/pi-obsidian`) — recommended during development.
2. Reference the subdirectory explicitly in `.pi/settings.json`:

   ```json
   { "packages": ["./packages/pi-obsidian"] }
   ```

3. Move this folder into its **own git repository** so the root is the package.
4. Publish to **npm** and install via `npm:pi-obsidian`.

## Path safety

All note paths are resolved within the vault and rejected if they escape it
(no `../` traversal, no symlink escapes, no control chars). Writes into
`.obsidian/` and `.git/` are blocked. Writes are atomic (temp + rename) and
support optimistic-concurrency via `expectedMtime`.

## Files

```
bun-apps/pi-obsidian/
├── package.json        # pi manifest + pi-package keyword
├── README.md           # this file
├── extensions/
│   └── obsidian.ts     # extension: 16 tools + 3 commands + vault seeding
├── docs/               # ENHANCEMENT-PRD.md · KNOWN-ISSUES.md · VALIDATION-C5C6.md
├── scripts/            # bench-trigram-search · bench-index-persistence ·
│                       # measure-schema-tokens · validate-real-vault
├── skills/
│   └── using-obsidian-vault/  # optional skill: vault conventions + zk_* hand-off
└── vault-template/     # starter notes copied into a fresh vault
    ├── README.md
    ├── Inbox/README.md
    ├── Templates/{Daily Note, Design Note}.md
    └── Tags/Index.md
```

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `OB_VAULT_DIR` | `vault` | Subfolder name (relative to cwd) for the Tier 3 fallback folder |
| `OB_VAULT_PATH` | — | Absolute path; Tier 1 — overrides everything |
| `OB_VAULT` | — | Registered vault name from `obsidian.json` (legacy, global mode only) |
| `OB_USE_GLOBAL` | unset | Any truthy value skips the Tier 3 fallback |
| `OB_CACHE_MAX` | `500` | Soft cap on the session file cache (true LRU, access-order). Tunable at runtime. |
| `OB_INDEX_POLL_MS` | `2000` | Throttle window for incremental index refresh; `0` forces a refresh each call (tests). |
| `OB_TRIGRAM_SEARCH` | on | `0` disables the C5 trigram candidate pre-filter for substring search. |
| `OB_INDEX_PERSIST` | on | `0` disables C6 cross-session index persistence (load/save). |
| `OB_INDEX_CACHE_DIR` | `<vault>/.cache` | Where C6 writes `pi-obsidian-index.json`. **Point outside the vault** (e.g. `/tmp/pi-obsidian-cache`) if you git-track or sync the vault folder and don't want a `.cache/` tracked there — see below. |
| `OB_DISTILL_TOOLS` | *(built-in set)* | Comma-separated tool names the distill subagent may call (B6). |
| `OB_GARDEN_AUDIT_TOOLS` / `OB_GARDEN_FIX_TOOLS` | *(built-in set)* | Same for garden audit / fix modes. Fix defaults to audit + write tools. |
| `OB_PARENT_MODEL` / `OB_SUBAGENT_MODEL` | — | Model-id inheritance floor for distill/garden subagents (B2). `OB_SUBAGENT_MODEL` is a trusted floor; a known-weak `OB_PARENT_MODEL` is refused. |
| `OB_SUBAGENT_TIMEOUT_MS` | `1200000` | Per-call wall-clock timeout for distill/garden subagents (writer archetype — aligned to the 20-min writer envelope, `ROLE_AWARE_DISPATCH_BOUNDS`; `0` = no gate). |
| `VAULT_MIND_BASE_URL` | `http://127.0.0.1:8000` | Base URL of the vault-mind service for `obsidian_semantic_search`. A path prefix is honoured (e.g. `http://host:9999/vm/` → `…/vm/api/search`). Unset + no service → the tool returns a structured `isError` so the agent falls back to `obsidian_search`. |
| `VAULT_MIND_AUTO_REINDEX` | unset (off) | Set to `1` (or any truthy string other than `0`/`false`) to auto-fire a `POST /api/index {force_reindex:true}` after `obsidian_distill` writes notes, so new Zettelkasten cards are picked up without a manual re-index. **Default OFF** — when unset/`0`/`false` no HTTP is issued and distill behaves exactly as before. Fire-and-forget: failures only `console.warn`, never alter the distill tool result. |

### C6 `.cache/` note

C6 persists the vault index to `<vault>/.cache/pi-obsidian-index.json` by default
(so it lives alongside the vault and survives across sessions). If you **git-track
or sync the vault folder**, add `.cache/` to that vault's `.gitignore` (or set
`OB_INDEX_CACHE_DIR` to a path outside the vault) — otherwise the cache file
shows up as an untracked file in the vault. (The bundled `vaults_root/s2-agent-vault`
test vault already ignores `.cache/`.)

## External use (bun scripts)

The pure index + graph/report logic is importable from `pi-obsidian/lib`
without starting the pi runtime — useful for vault analysis, CI checks,
or feeding external renderers.

```ts
import { getIndex, toMermaid, summarizeVault, renderReportMD } from "pi-obsidian/lib";
const idx = await getIndex("./vault");
console.log(toMermaid(idx));            // Mermaid graph
console.log(renderReportMD(summarizeVault(idx))); // Traditional-Chinese report
```

### Export the graph (CLI)

`scripts/vault-graph-export.mjs` exports the wiki-link graph in three portable
formats:

```bash
# Mermaid → paste into https://mermaid.live
bun run scripts/vault-graph-export.mjs --format mermaid --out out/vault-graph.mmd

# DOT → render with Graphviz (`dot -Tsvg out/vault-graph.dot -o graph.svg`)
bun run scripts/vault-graph-export.mjs --format dot --out out/vault-graph.dot

# JSON → feed D3 / custom tooling (`jq . out/vault-graph.json`)
bun run scripts/vault-graph-export.mjs --format json --out out/vault-graph.json
```

| Format | Renderer |
|--------|----------|
| `mermaid` | [mermaid.live](https://mermaid.live), GitHub fenced ```mermaid blocks |
| `dot` | Graphviz (`dot`, `fdp`), WebGraphviz |
| `json` | D3-force, Obsidian Canvas import, ad-hoc tooling |

The JSON shape: `{ nodes: [{id,title,tags,created,path}], edges: [{source,target}], stats }`.

### Summarize the vault (CLI)

```bash
bun run scripts/vault-summarize.mjs --out out/vault-report.md
```

Produces a Traditional-Chinese Markdown report: overview stats, tag clusters,
topic clusters (per folder), and health (orphans / dead links / title-style
outliers). Add `--llm` to also generate semantic per-topic summaries via the
`obsidian_distill` subagent (offline by default).

## Semantic search (optional)

`obsidian_semantic_search` is an **optional** meaning-based (vector) retrieval
mode that complements `obsidian_search` (lexical). It calls an external
**[vault-mind](https://github.com/reza899/vault-mind)** service — a FastAPI +
ChromaDB app that indexes the vault into embeddings. It is the only `obsidian_*`
tool that makes an HTTP call; pi-obsidian otherwise stays hermetic (filesystem
only). Because it is optional infrastructure:

- With `VAULT_MIND_BASE_URL` unset **or** the service down, the tool returns a
  structured `isError` result pointing at `obsidian_search` — the agent falls
  back to lexical search. No crash, no hard dependency.
- It is opt-in per environment; it adds no runtime dependencies to pi-obsidian
  (uses the platform `fetch`).
- After `obsidian_distill` writes notes, set `VAULT_MIND_AUTO_REINDEX=1` to
  have pi-obsidian fire a `force_reindex` at vault-mind automatically — closing
  the manual re-index gap so freshly-distilled cards are searchable by meaning
  without a separate step. Off by default (zero HTTP when unset).

### When to use it

Lexical search fails when the query is phrased differently from a card's
title/keywords. A natural-language question like *"how do I avoid the gpu
exploding on big images"* shares **no tokens** with the relevant
`MemoryError` / OOM-guard cards, so `obsidian_search` returns nothing.
Semantic search surfaces them by meaning. Empirically (425-card `s2-agent-vault`,
`all-MiniLM-L6-v2`): *"switching git branches broke my downloaded model
weights"* → top hit 0.618 `model-symlink-silent-skip-on-commit`, the exact card
lexical substring search could not reach.

### Stand up vault-mind (one-time)

```bash
git clone https://github.com/reza899/vault-mind.git ../vault-mind
( cd ../vault-mind && make quick-start )   # docker, or `make dev-local` without

# Index the same vault pi-obsidian resolves — give it the host filesystem path.
curl -X POST http://127.0.0.1:8000/api/index \
  -H "Content-Type: application/json" \
  -d '{"vault_name":"s2-agent-vault","vault_path":"/abs/path/to/vaults_root/s2-agent-vault"}'

# Verify (returns ranked chunks + metadata):
curl -G http://127.0.0.1:8000/api/search \
  --data-urlencode "vault_name=s2-agent-vault" \
  --data-urlencode "query=git branches broke my model weights"
```

Then point the tool at it and (re)index after `obsidian_distill` / `zk_ingest`:

```bash
export VAULT_MIND_BASE_URL=http://127.0.0.1:8000   # default; set only if non-default
```

**Re-index path (gap #5 — manual for v1):** after ingesting new cards, re-POST
`/api/index` with `force_reindex:true`. An auto-hook on `obsidian_distill` /
`zk_ingest` is a documented follow-up.

**Indexing gotchas (vault-mind v1.4, learned iter-4):**

- **Use `/api/index` `force_reindex:true`, never `/api/collections/{name}/reindex`.**
  The `/reindex` endpoint stalls — its document count freezes mid-rebuild and the
  collection is left partial. `/api/index force_reindex:true` returns a `job_id`
  that completes reliably (~18s for a 493-file vault); poll
  `GET /api/index/job/{job_id}` until `status:"completed"`, then confirm via
  `GET /api/collections/{name}/status` (`status:"indexed"`). The listing endpoint's
  `document_count` is cached/stale — trust the per-collection `/status`.
- **vault-mind auto-prefixes `vault_`.** It derives `collection_name = "vault_" +
  vault_name`, so POST `vault_name` **without** the `vault_` prefix: the canonical
  s2-agent collection is `vault_pi_agent_vault`, so POST
  `"vault_name":"s2-agent-vault"` (or `pi_agent_vault`) — never
  `"vault_name":"vault_pi_agent_vault"` (that creates a misnamed
  `vault_vault_pi_agent_vault` duplicate). `/api/search` accepts either hyphen or
  underscore form for `vault_name` (it normalizes). Deleting a collection is a
  two-step confirmation-token flow: DELETE returns a `confirmation_token` (300s
  TTL), then `DELETE ...?confirmation_token=<tok>` starts an async cleanup job —
  poll `GET /api/collections` until empty.
- **Controlled-corpus harness:** `scripts/controlled-corpus.mjs` stages a tiny
  paper+distill vault (~24 cards, two distinct domains) as its own collection so
  semantic/lexical/graph retrieval can be measured on a noise-free field instead
  of the full 2900-doc vault. Idempotent; `--status` / `--search "query"` probe.

### Embedding model quality (honest caveat)

vault-mind's default `all-MiniLM-L6-v2` is multilingual but lightweight; on
CJK + technical corpora (mlx / 知識圖譜 / CFG) similarity scores land in the
0.3–0.6 band — relevant cards still surface but the tool defaults
`similarity_threshold` to **0.3** (down from vault-mind's 0.4) so weak-but-relevant
hits are not silently dropped. For higher quality, swap to a stronger
multilingual model via vault-mind's `EMBEDDING_MODEL`.

## Known limitations

The full, date-stamped list lives in **[docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)**.
Highlights:

- **`renameOverwrite` is not atomic-overwrite on Windows** (`fs.rename` throws
  `EPERM`/`EEXIST` onto an existing target; only `EXDEV` is special-cased). In-place
  edits (append / frontmatter update / move-with-overwrite) fail on Windows; not hit
  on macOS/Linux.
- **`obsidian_search` regex / words / fuzzy are full-scan by design** — only
  `substring` mode uses the C5 trigram index (a literal-substring pre-filter is sound;
  the others aren't). See [docs/VALIDATION-C5C6.md](docs/VALIDATION-C5C6.md) for the
  measured 5–10× substring speedup at 10k notes.
- **Schema cost is ~3.3k tokens/turn** (every tool + param `description` ships in
  `tools[]` each request). `scripts/measure-schema-tokens.mjs` quantifies it; further
  trimming is conservative to preserve model tool-use.
- **`obsidian_distill` / `obsidian_garden` need `OB_SUBAGENT_MODEL`** (they spawn `pi`).

Previously-listed TODOs now resolved (C1 backlinks via index, C2 memoized adjacency,
B5 `runSubagent` refactor, C5/C6/C7/C8/A6/A4) — see `docs/ENHANCEMENT-PRD.md`.

## License

MIT
