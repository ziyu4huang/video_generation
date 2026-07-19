# 03 — Vault-path portability / sync story

## Question

Should the `vault_path` stored in `~/.pi/obsidian_config.json` be an **absolute, machine-local path** (simple, but breaks if `~/.pi` is dotfiles-synced across machines with different paths), or a **resolvable name/alias** (e.g. a vault name looked up in the Obsidian app's `obsidian.json` registry) so a synced `~/.pi` works across machines?

`~/.pi` is machine-local by nature. If the user syncs their dotfiles (iCloud / git / chezmoi) so the same `~/.pi` lands on multiple machines, an absolute `vault_path` like `/Users/huangziyu/proj/study-news` is wrong on any machine with a different home or layout. Today `resolveVault()` treats `vault_path` as absolute-or-cwd-relative and `existsSync`s it; there is no name→path resolution step.

Decide:

- **Absolute path as-is (recommended):** keep the current model — `~/.pi` stores an absolute `vault_path`, machine-local. Matches the existing project-tier behavior, zero new resolution machinery. Document that dotfiles-synced setups need a per-machine `~/.pi` (or use `OB_VAULT_PATH` env, which is already machine-specific). The personal tier is "my default on *this* machine," which is what "personal" usually means.
- **Name/alias resolution:** if `vault_path` is a bare name (no `/`), resolve it against the Obsidian app's `obsidian.json` vault registry (`readObsidianVaults()` already enumerates these by basename). Syncable across machines, but adds a resolution branch + ambiguity handling (name not registered → fall through? error?).

This is gated by [02 — Personal-tier resolution mode](02-personal-tier-resolution-mode.md): if the personal tier supports `mode: "app"`, then a synced `~/.pi` with `mode: "app"` is already portable (each machine follows its own open vault), which shrinks the need for name/alias resolution — possibly to zero. Decide [02] first.

### Context (pre-gathered — don't re-investigate)

- Current `vault_path` handling: `resolveVault()` Tier 1b — `isAbsolute(vault_path) ? vault_path : resolve(cwd, vault_path)`, then `existsSync`. No name lookup.
- `readObsidianVaults()` already returns `{path, open}[]` from the app registry (`obsidian.json`), keyed by path with `basenameOf()` available for name matching.
- `~/.pi` layout confirmed machine-local: `~/.pi/{auth.json, agent/, workflows/, web-search.json}`.

type: grilling
claimed: pi-agent
blocked by: 02 — Personal-tier resolution mode
status: closed

## Resolution (closed 2026-07-19)

**Absolute, machine-local `vault_path` as-is — no name/alias resolution.**

- `~/.pi/obsidian_config.json` stores an absolute `vault_path` (e.g. `/Users/huangziyu/proj/study-news`), exactly as the project tier does today (`isAbsolute ? path : resolve(cwd, path)` + `existsSync`). Zero new resolution machinery — no `obsidian.json` name lookup, no ambiguity branch.
- Rationale: the user's original framing ("personal choice not project choice") is about WHERE the default lives (user scope vs project scope), not cross-machine portability. "Personal" = my default on THIS machine. Dotfiles-syncing `~/.pi` across machines is not a current need.
- **Multi-machine escape hatch (documented, not built):** if the user ever syncs `~/.pi` across machines with different home paths, the existing `OB_VAULT_PATH` env (Tier 1a, already machine-specific per shell profile) covers it without touching the personal tier. No per-machine `vault_path` juggling inside `~/.pi`.
- The project tier's path handling is **unchanged** — only the personal tier is added, and it reuses the identical absolute/relative + `existsSync` logic.

**Map consequence — frontier now EMPTY.** With [01](01-shared-resolver-confirmation.md), [02](02-personal-tier-resolution-mode.md), and this ticket closed, every decision the implementation depends on is settled. The way to the destination is clear; what remains is the **implementation hand-off** (resolver rewrite + tests + README tier table + `--scope project` flag + run-dir migration) — "doing," not deciding. See the map's *Not yet specified* for the hand-off edge.
