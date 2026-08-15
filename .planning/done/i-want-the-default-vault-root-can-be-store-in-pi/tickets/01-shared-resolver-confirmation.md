# 01 — Shared-resolver confirmation

## Question

Do all vault consumers (the `obsidian` MCP tool, the zk tools `zk_ingest`/`zk_card`/`zk_ask`/`knowledge_query`, the `movie` orchestrator, and the `pi-agent-cli`) route vault resolution through the **single** `resolveVault()` in `pi-agent-ext-obsidian/src/obsidian-lib.ts` — or does each re-implement resolution, ballooning the change surface?

This de-risks the destination: if it's one shared resolver, the personal-tier change is a single-site edit and every consumer follows for free. If consumers re-implement, each call site must be found and patched, and the scope of [02](02-personal-tier-resolution-mode.md)/[03](03-vault-path-portability-sync.md) widens.

### Context (pre-gathered — don't re-investigate)

- The obsidian MCP tool (`extensions/obsidian.ts`) re-exports `resolveVault` from `../src/obsidian-lib.ts` (line 76, 190, 228) and calls `await resolveVault(cwd)` (line 245, 1887).
- The zk tools live in `pi-agent-ext-knowledge-card/src/`; `ingest.ts:44` notes "Env (passed through from pi-obsidian): OB_VAULT_PATH / OB_VAULT_DIR", and `host-fns.ts:13` imports `resolveVault` from the shared extension.
- The CLI (`pi-agent-cli`) parses `--vault`/`--vault-dir` (`args.ts`, `flag-spec.ts:88`) and `passthrough.ts:55` sets `OB_VAULT_PATH` env from them.

type: research
claimed: pi-agent
blocked by: —
status: closed

## Resolution (closed 2026-07-19)

**Single shared resolver — one change point. Every live consumer funnels through `resolveVault()`.**

- **obsidian MCP tool** → calls `resolveVault(cwd)` directly (`extensions/obsidian.ts:245`).
- **zk tools** (`zk_ingest`/`zk_card`/`zk_ask`/`knowledge_query`, in `pi-agent-ext-knowledge-card`) → `host-fns.ts:13` imports the same `resolveVault` from `@repo/pi-agent-ext-obsidian/extensions/obsidian.ts`; `host-fns.ts:48` does `(await resolveVault(ctx.cwd)).path`.
- **CLI** (`pi-agent-cli`) → `--vault`/`--vault-dir` flags are translated to `OB_VAULT_PATH`/`OB_VAULT_DIR` env (`passthrough.ts:55`), which the shared resolver reads as Tier 1a. Same function.
- **`movie` orchestrator** → does not resolve the vault itself; its knowledge/distill workflows invoke the CLI (which sets the env above). No independent resolver.

→ Changing `resolveVault()` + its config-path helpers once propagates to all consumers. Scope is contained to `obsidian-lib.ts` + its README tier table + the `/obsidian-config` write path.

**One divergence (out of scope):** `pi-agent-cli/src/commands/memory-to-vault.ts:107` ships its own `resolveVaultPath()` — checks `--vault`/`OB_VAULT_PATH` explicit, then walks up 10 dirs for `vaults_root/pi-agent-vault`, reading no config file. It is a one-off CLI migration utility, not a live MCP tool, so it would not pick up the new `~/.pi` tier automatically. Harmonizing it to call the shared `resolveVault()` is a follow-up (ruled out of scope on the map), not a blocker for this effort.
