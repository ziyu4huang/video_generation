---
status: complete
---

> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Map — default vault root at ~/.pi (personal, not project)

## Destination

The obsidian extension resolves the **default vault from a user-global config at `~/.pi/obsidian_config.json`** (personal), which takes **precedence over any project config**, so the user's chosen default vault follows them across every project instead of being locked to a project-local `.pi/`. A project may still pin its own vault via `<project>/.pi/` (lower precedence) or `OB_VAULT_PATH` env (highest); the Obsidian-app-open tier and the `cwd/vault` fallback stay as the last resorts. One resolver change flows through to every consumer (obsidian tool, zk tools, CLI).

## Notes

**Domain:** the pi-obsidian vault-resolution layer — `bun-apps/pi-agent-ext-obsidian/src/obsidian-lib.ts` (`resolveVault`, `vaultConfigPath`, `readVaultConfig`, `writeVaultConfig`, `runDirPath`) plus its docs (`README.md` tier table) and the `/obsidian-config` write path in `extensions/obsidian.ts`. The zk tools (`pi-agent-ext-knowledge-card/src/host-fns.ts`) and the CLI (`pi-agent-cli`) are *consumers*, not parallel resolvers.

**Four settled decisions (this effort's trunk — resolved in the charting grill):**

1. **Shape = code change.** Add `~/.pi/obsidian_config.json` as a user-global config tier in the resolver (NOT a one-time write, NOT an `OB_VAULT_PATH`-env-in-shell-profile hack). The capability to store the default at user level is the point.
2. **Precedence = personal wins over project.** `env (OB_VAULT_PATH)` > **personal (`~/.pi`)** > project (`<project>/.pi`) > app-open (Tier 2) > local (`cwd/vault`, Tier 3). "Personal choice not project choice" means the personal vault is used in every project regardless of project config; only an explicit env var can override it.
3. **Write target defaults to personal.** `/obsidian-config <path>` writes `~/.pi/obsidian_config.json` by default (the tier that actually wins on read, so read/write stay consistent); an explicit scope flag (e.g. `--scope project`) opts into writing `<project>/.pi/` for a project-specific override.
4. **Project config = one location.** The project tier is `<project>/.pi/obsidian_config.json` ONLY (matches pi's existing `.pi/` convention everywhere). The current "preferred" `run-dir/obsidian_config.json` (`bun-apps/pi-agent/run-dir/`) is **retired** as a config location — read once for migration, then `.pi/` is canonical.

**Key facts (already verified — don't re-litigate):**

- `~/.pi` is already the user-level pi home (`auth.json`, `agent/`, `workflows/`, `web-search.json`). Adding `~/.pi/obsidian_config.json` matches the existing personal-level convention; no new directory concept.
- **Single change point (VERIFIED in [01](tickets/01-shared-resolver-confirmation.md)):** every live consumer funnels through the one `resolveVault()` in `obsidian-lib.ts` — the obsidian MCP tool calls it directly (`extensions/obsidian.ts:245`); the zk tools import it (`host-fns.ts:13,48`); the CLI sets `OB_VAULT_PATH`/`OB_VAULT_DIR` env which that resolver reads as Tier 1a. Change the resolver once, all consumers follow.
- **One divergence (out of scope):** `pi-agent-cli/src/commands/memory-to-vault.ts:107` has its own `resolveVaultPath()` (walks up 10 dirs for `vaults_root/pi-agent-vault`, reads no config). It's a one-off CLI migration utility, not a live MCP tool — harmonizing it is a follow-up, not a blocker.
- The config file shape (`VaultConfigFile = { vault_path?, mode?: "explicit" | "app" }`) is reused unchanged; the new tier adds a *location*, not a schema.
- Tier 2 (Obsidian-app open vault) is already machine-wide but *follows whatever is open* — not a fixed personal default. That gap is exactly what this effort closes: a fixed, explicit personal default sitting *above* app-follow.

**Skills every session should consult:** `grilling`, `domain-modeling`, `writing-plans`, `executing-plans`, `verification-before-completion`.

## Decisions so far

<!-- the index — one line per closed ticket -->

- [01 — Shared-resolver confirmation](tickets/01-shared-resolver-confirmation.md) — every live vault consumer (obsidian MCP tool, zk tools, CLI) funnels through the single `resolveVault()` in `obsidian-lib.ts`; one change point. `memory-to-vault.ts` is the one divergence (own resolver, CLI utility, out of scope).
- [02 — Personal-tier resolution mode](tickets/02-personal-tier-resolution-mode.md) — personal tier (`~/.pi`) is **explicit `vault_path` only**; `mode` is not honored there (app-follow stays Tier 2's job, keeping the personal default fixed). A stray/unsupported `mode` warns + falls through the chain (matches the resolver's stale-handling).
- [03 — Vault-path portability / sync story](tickets/03-vault-path-portability-sync.md) — `~/.pi` stores an **absolute, machine-local `vault_path`** as-is (same logic as the project tier); no name/alias resolution machinery. Multi-machine needs are covered by the existing `OB_VAULT_PATH` env (documented, not built).

## Not yet specified

<!-- in-scope fog you can't ticket yet; graduates as the frontier advances -->

**✅ IMPLEMENTED (2026-07-19).** The hand-off below was executed directly: the personal tier is live in `pi-agent-ext-obsidian`, all 16 new hermetic tests pass, the full suite is green (378 pass; the lone fail is the pre-existing vault-submodule skip). Changed files:

- Rewrite `vaultConfigPath` / `readVaultConfig` / `writeVaultConfig` in `pi-agent-ext-obsidian/src/obsidian-lib.ts` to add the personal tier at `~/.pi/obsidian_config.json` (absolute `vault_path` only; `mode` ignored → warn + fall through).
- Insert the personal tier into `resolveVault()` at the settled precedence: `env (OB_VAULT_PATH)` > **personal (`~/.pi`)** > project (`<project>/.pi`) > app-open > local.
- Retire `runDirConfigPath()` (`bun-apps/pi-agent/run-dir/obsidian_config.json`) as a config location — **one-time migration read**: if a `run-dir` config exists and no `<project>/.pi` config does, read it once and write to `<project>/.pi/` (mechanics: read-once-move vs warn-and-stop — a small behavior choice to settle at implementation time; does not gate the route).
- Add a `--scope project` flag to `/obsidian-config` (default write = `~/.pi` personal; `--scope project` writes `<project>/.pi/`). Personal-scope writes reject `mode:"app"`.
- Update the README tier table + `vaultConfigPath` doc; add tests (isolate from the user's real `~/.pi` via temp `HOME` or a config-path override).

The way is clear — hand to `writing-plans`/`executing-plans`, or implement directly.

## Out of scope

- **`OB_VAULT_PATH`-in-shell-profile as the solution** — rejected at the destination grill (shape C): it's an env var (shell-specific, not a declarative config file, every consumer must see the env). Env stays as the Tier-1 override for CI/one-offs only.
- **A one-time config write without touching resolution logic** — rejected at the destination grill (shape B): it wouldn't actually move where the *default* is read from; project config would still win.
- **Harmonizing `memory-to-vault.ts`'s own `resolveVaultPath()`** to call the shared `resolveVault()` — a separate CLI utility, not a live tool; a nice-to-have follow-up, not on this route. Link if the destination is ever redrawn to "single resolver everywhere."
- **Changing Tier 2 (Obsidian-app open-vault) behavior** — untouched. The personal tier sits *above* it; app-follow semantics are unchanged.
> Closed 2026-08-15: all 3 tickets closed; personal-tier vault resolver shipped.
