**ID:** `ADR-ultracode-0001` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# Pack runtime state is pack-local, never in ~/.pi

**Status:** accepted (locked 2026-07-19; wayfinder ticket [03-state-model](../../../.planning/2026-07-19-review-the-workflow-pack-feature-via-s2-agent-ex/tickets/03-state-model.md))

A workflow-pack's runtime state — run history (`runs/`), outputs (`outputs/`), and on-disk intermediates (`intermediate/`) — lives **inside the pack folder** (flat top-level dirs, gitignored), **not** in the global `~/.pi/workflows/projects/<key>/` store the rest of the engine uses for inline scripts. The canonical folder-structure **template ships inside the extension** at `workflow-pack/template/`. We chose this so a pack is a self-contained, agent-cleanable, repeatable unit: an agent identifies a pack's I/O/history by listing one folder and purges it in place, and "repeat run" (versioned `outputs/<ts>/`, ticket 11) stays co-located with the pack that produced it.

## Considered options

- **Global store, pack-keyed + manifest contract** — state under `~/.pi/workflows/projects/<key>/` keyed by a pack-id; manifest declares the I/O contract. Closest to the current architecture. **Rejected by the user** ("no workflow-pack store in `~/.pi`").
- **Pack-local** ✅ — state inside the pack folder. Maximally self-contained; the agent's stated goal ("easily identify input/output/intermediate/history") is met by directory structure alone. Chosen.
- **Hybrid: manifest contract + in-pack state marker** — bytes in the global store, a `STATE.md` / `.workflow-state` pointer in the pack. **Rejected** — the user wanted the real bytes pack-local, not a pointer back to a global store.

## Consequences

- **Inline scripts diverge.** Inline `script` runs (no pack) keep the existing `~/.pi` run-persistence unchanged; only *packs* go pack-local. The engine needs a branch point (ticket 13).
- **Checked-in packs can't hold state.** A pack resolved from `bun-apps/<pkg>/workflows/<name>` (a read-only/package dir) can't host writable `runs/outputs/intermediate`. Its state must **redirect** to a pack-id-keyed location (`pack-id = <name>-<sha256(absPath)[:12]>`, ticket 08). Mechanics live in the scaffolder (07) + backward-compat (13); flagged as map fog until those resolve.
- **`.pi` is not gitignored in this repo** — every pack template must ship a `.gitignore` for its ephemeral dirs, or state leaks into version control.
- **Determinism tension.** On-disk intermediates (a new capability, ticket 12) may tension the resume invariant — intermediates currently live in script variables for reproducibility. Surfaced for ticket 12 to resolve (likely an opt-in flag).
