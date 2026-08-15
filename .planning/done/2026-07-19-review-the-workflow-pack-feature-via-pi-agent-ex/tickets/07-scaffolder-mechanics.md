## Question

How is a pack **instantiated from the template** — a `workflow pack init <name>` scaffolder, a literal copy, or a manifest `dirs:` declaration — and where does the instantiated pack live? How does the shipped template reach consumers (it must be added to `package.json` `files:`)?

type: prototype
status: closed
claimed: work-session (2026-07-19)  — work-through on existing map ("continue map" wrapper + `.planning/2026-07-19-continue-map/` dir = paste artifacts); picked as frontier #1

blocked by: 05(closed)

## Context

The canonical template ships at `bun-apps/pi-agent-ext-workflow/workflow-pack/template/` (03). Decide the scaffolder command + its resolution target (`.pi/workflows/<name>/` for project packs), how `manifest.json`/`entry.js`/`agents/`/`inputs/` are copied vs the ephemeral dirs (`outputs/ intermediate/ runs/`) created empty with `.gitignore` + `.gitkeep`. Resolve the **checked-in pack** tension (a pack under `bun-apps/<pkg>/workflows/<name>` can't hold writable state — see "Not yet specified" on the map): does scaffolder refuse, redirect state to a sibling, or require the pack live under `.pi/`? Confirm the new `workflow-pack/` dir is added to `files:` so the published package actually contains the template.

## Resolution

**`workflow pack init <name>` → `.pi/workflows/`; checked-in packs authored manually + runtime state-redirect to `.pi/workflows/.state/<pack-id>/`.**

1. **Scaffolder = `workflow pack init <name>`.** Default target: `.pi/workflows/<name>/` (project-local).
   - **Copies from shipped template** (`workflow-pack/template/`): `manifest.json` (stub), `entry.js` (stub), `agents/`, `README.md`, `.gitignore`.
   - **Creates empty + `.gitkeep`**: `inputs/`, `outputs/`, `intermediate/`, `runs/`.
   - `init` targets `.pi/workflows/<name>/` ONLY (pack-local state, no redirect). It **refuses to scaffold into a package dir** — checked-in packs are authored manually (see #3).

2. **Template reaches consumers** via the published package: add `workflow-pack/` to `package.json` `files:`; `init` resolves the template from the installed package path. (Task — confirmed, not a decision.)

3. **Checked-in packs — manual authoring + runtime state-redirect.** A pack under `bun-apps/<pkg>/workflows/<name>/` is authored by copying the template in (NOT via `init`). At RUN time, `resolveWorkflowPack` detects the read-only/package location and **redirects the pack's runtime state** (`runs/ outputs/ intermediate/`) to **`.pi/workflows/.state/<pack-id>/`** — project-local, NOT `~/.pi` (honors 03 + ADR-0001). The pack's STATIC files (manifest/entry/agents) stay in the package dir; only state redirects. `pack-id` per 08 (`<name>-<sha256(absPath)[:12]>`). → **Resolves the map fog "Pack portability across scopes"** (graduated — removed from *Not yet specified*).

4. **Lazy self-provisioning ON.** On run, the engine `mkdir -p`'s the pack's state dirs — in-place for `.pi/` packs, the redirect target for checked-in packs — idempotent. A hand-written manifest or a freshly-redirected checked-in pack never errors on missing dirs.

5. **`.gitignore` ships in the template** (hard constraint: `.pi` is NOT gitignored in this repo); `init` copies it so ephemeral dirs don't leak into VCS. Checked-in-pack authors must include the same `.gitignore` (documented in the template README).

**Deferrals:** backward-compat / migration path for existing packs → 13; extra `init` flags (`--global` for `~/.pi/workflows/<name>/`, `--force` for overwrite) → execution (14), minimal now.
