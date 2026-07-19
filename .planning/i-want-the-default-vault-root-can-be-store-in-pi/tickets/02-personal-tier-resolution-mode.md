# 02 — Personal-tier resolution mode

## Question

Should the new personal tier at `~/.pi/obsidian_config.json` support `mode: "app"` (follow the Obsidian app's currently-open vault as the personal default), or should the personal tier be **explicit `vault_path` only**?

The existing `VaultConfigFile` shape is `{ vault_path?, mode?: "explicit" | "app" }`. Today `mode: "app"` means "ignore `vault_path`, follow the Obsidian app's open vault (Tier 2)." With personal sitting *above* Tier 2 in the new precedence, a personal `mode: "app"` would mean "my personal default is whatever I have open in Obsidian" — semantically odd, since "follow the open app vault" is already Tier 2's job and the personal tier exists precisely to be a *fixed* default that does NOT change as you switch vaults in the app.

Decide:

- **Explicit-only (recommended):** the personal tier accepts `vault_path` only; `mode` is ignored or rejected at `~/.pi`. The personal tier is a fixed, explicit default by construction — which is the whole point of "personal not project." App-follow stays Tier 2's role, unchanged.
- **Mirror the schema (allow `mode: "app"`):** `~/.pi` accepts the same `{vault_path, mode}` shape, so a user could set `mode: "app"` to make "follow the open app vault" their personal default. More flexible / consistent with the project tier's schema, but re-introduces the "default drifts as you switch vaults" behavior the personal tier is meant to replace, and muddies the personal-vs-app-tier boundary.

This shapes the resolver's personal-tier branch (does it consult `mode`?) and the `/obsidian-config` validation for the personal scope.

### Context (pre-gathered — don't re-investigate)

- `VaultConfigFile` interface and `mode` semantics: `src/obsidian-lib.ts` (lines ~125–145) — `mode: "explicit"` (default when `vault_path` set) vs `mode: "app"` (ignore `vault_path`, follow app).
- New precedence (settled, map D2): `env` > **personal (`~/.pi`)** > project (`.pi`) > app-open > local. Personal sits above app-follow.
- The destination grill established the personal tier is a *fixed* default ("a fixed, explicit personal default sitting above app-follow" — map Notes).

type: grilling
claimed: pi-agent
blocked by: —
status: closed

## Resolution (closed 2026-07-19)

**Personal tier is explicit `vault_path` only — `mode` is not honored at `~/.pi`. A stray/unsupported `mode` warns and falls through.**

- **Q1 — Explicit-only.** `~/.pi/obsidian_config.json` accepts `vault_path` only. `mode` is rejected/ignored at the personal tier. Rationale: the personal tier exists precisely to be a *fixed* default that does not drift as the user switches vaults in the Obsidian app; `mode:"app"` re-introduces exactly that drift, and app-follow is already Tier 2's job. The personal tier and the app-open tier keep a clean boundary: personal = fixed explicit default sitting above app-follow.
- **Q2 — Warn + fall through.** If `~/.pi` contains a `mode` the personal tier does not honor (e.g. `mode:"app"`), `resolveVault()` records a `staleReason`/warning and **falls through** the precedence chain (project > app-open > local), treating `~/.pi` as if it had no usable personal config. Matches the resolver's existing stale-handling philosophy ("keep working instead of aborting") — a fat-fingered `~/.pi` never blocks all vault ops.

**Implications for the implementation hand-off (map Not-yet-specified):**
- The personal-tier branch in `resolveVault()` consults `vault_path` only — no `mode` check. A present-but-unsupported `mode` (or a missing `vault_path`) pushes a `staleReason` and continues down the chain.
- `/obsidian-config` (personal scope) writes `{ vault_path }` only; it should reject a `mode:"app"` write at personal scope with a clear message (point the user at Tier 2 / the project tier if they want app-follow).
- The project tier's `{vault_path, mode}` schema is **unchanged** — only the personal tier is explicit-only.

**Unblocks:** [03 — Vault-path portability / sync story](03-vault-path-portability-sync.md). With the personal tier now explicitly *fixed* (no `mode:"app"` escape hatch), the app-follow portability route is gone — so name/alias resolution becomes *more* relevant if the user dotfiles-syncs `~/.pi`. 03's hinge question ("do you sync `~/.pi` across machines?") now fully determines whether the alias branch is worth building.
