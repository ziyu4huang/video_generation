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

Resolution runs in 3 tiers (top-down, first match wins):

| Tier | Source | What it is |
|------|--------|------------|
| **1 — explicit** | `OB_VAULT_PATH` env | Absolute path; overrides everything (for CI / one-off runs) |
| **1 — explicit** | `.pi/obsidian_config.json` `vault_path` | Persistent per-project setting (written by `/obsidian-config <path>`); skipped when `mode: "app"` |
| **2 — auto-follow app** | `obsidian.json` `open: true` vault | The vault currently open in the Obsidian app — what you see is what the agent uses |
| **3 — fallback** | `<cwd>/${OB_VAULT_DIR \|\| "vault"}` | Zero-config project-local folder, auto-created + seeded on first use |

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
/obsidian-config              # show active vault + source + all candidates
/obsidian-config <path>       # set explicit vault (mode "explicit"), e.g.
                              #   /obsidian-config ./my-vault
                              #   /obsidian-config /abs/path/to/vault
/obsidian-config --use-app    # follow the Obsidian app's open vault (mode "app")
/obsidian-config --list       # list all registered vaults
/obsidian-config --clear      # forget the explicit path (fall back to app/local)
```

The persistent config file is `.pi/obsidian_config.json`:

```json
{
  "vault_path": "/abs/path/to/vault",   // Tier 1 explicit (absolute or cwd-relative)
  "mode": "explicit"                      // "explicit" (default) or "app"
}
```

`mode: "app"` makes the agent follow whatever vault you have open in the
Obsidian app — convenient when you switch vaults in the app and want the agent
to follow without editing config. Tier 1 env (`OB_VAULT_PATH`) always wins over
both, so CI can pin a vault regardless of config/app state.

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
packages/pi-obsidian/
├── package.json        # pi manifest + pi-package keyword
├── README.md           # this file
├── extensions/
│   └── obsidian.ts     # extension: 7 tools + 2 commands + vault seeding
├── skills/
│   └── seed-vault/     # optional skill that documents vault conventions
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

## Known limitations & TODO

- **`renameOverwrite` is not atomic-overwrite on Windows.** It only special-cases
  `EXDEV`; on win32 `fs.rename` to an existing target throws `EPERM`/`EEXIST`, so
  in-place edits of an existing note (append / frontmatter update / move-with-overwrite)
  fail on Windows. Fix: handle the existing-target case (e.g. unlink-then-rename, or
  fall back to `cp({force:true})` on `EPERM`/`EEXIST` too). Not hit on macOS/Linux.
- **Graph/search helpers re-scan more than they need to.** Deferred perf wins:
  - `findBacklinks` re-reads the whole vault and re-parses every `[[link]]` to locate
    backlinks, instead of reusing `VaultIndex.reverseAdjacency` (already built). Read
    only the backlink source files the index already knows about.
  - `graphNeighbors` rebuilds a full undirected adjacency `Map` from scratch on every
    call; build/memoize it on `VaultIndex` (which already does a reverse-adjacency pass).
  - `moveNote` / `deleteNote` rewrite inbound links with sequential `await`s per source;
    the sources are independent — `Promise.all` the reads and writes.
- **`runSubagent` uses the `new Promise(async …)` antipattern.** The async executor's
  implicit promise is discarded, so a throw that escapes the inner `try/catch` becomes
  an unhandled rejection instead of rejecting the returned promise. `finish()` also lacks
  an idempotency guard (it runs twice on spawn `error`+`close`); benign today because the
  first resolve wins, but fragile. Prefactor to a plain `async` function + `finally` cleanup.
- **16 tools add ~2,300 tokens of constant context overhead per turn.** In pi's
  architecture, a tool's `description` and every parameter `description` are sent
  in the API's `tools[]` schema array on *every* request — whether or not that
  tool is used in that turn. This is separate from (and in addition to) the system
  prompt text. Measured across 16 tools: ~8,400 chars of schema ≈ ~2,300 tokens
  of fixed cost per API call.
  Mitigation paths (highest impact first):
  - **Shorten verbose parameter `description` fields** — the biggest contributor
    inside each tool's schema, especially `obsidian_search` (10+ params).
  - **Add a `minimal` package option** that skips rarely-used tools by default
    (`obsidian_distill`, `obsidian_garden`, `obsidian_query`, `obsidian_invalidate`);
    opt-in when needed. Cuts ~4 heavy-schema tools from default registration.
  - **Use `pi.setActiveTools([...subset])`** to deactivate tools not needed for
    the current session.

## License

MIT
