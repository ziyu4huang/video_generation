**ID:** `ADR-s2-agent-0002` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

> **Amended 2026-08-12 (s2-agent-cli merge).** The decision holds, but the
> mechanism gained one step. There is no longer a separate CLI binary: the
> passthrough is reached as `s2-agent cli [flags] [prompt]`, so re-invoking
> `process.argv[1]` alone would land a child in the **TUI** root, not the CLI.
> `runCli()` therefore exports `PI_SELF_ENTRY_PREFIX=cli`
> (`src/cli/dispatch.ts`), which `getPiInvocation()` in
> `s2-agent-ext-subagent/src/spawn-subagent-subprocess.ts` prepends to the child
> argv so the child re-enters the same namespace. "s2-agent-cli" below should be
> read as "the `cli` entry namespace".

# Passthrough exists so the binary is its own sub-agent target

The `cli` namespace ships a full pi-compatible passthrough mode (mirroring `pi -p` /
`pi --mode json`, accepting `-e` / `--approve` as silent no-ops) even though it
is primarily a command CLI. The reason: pi-obsidian's `obsidian_distill` and
`obsidian_garden` tools spawn child agents by re-invoking `process.argv[1]`
with pi flags, so the SAME binary must be drivable as a sub-agent. This makes
the design recursive — a parent run calls an obsidian tool → the tool spawns a
child Passthrough run → the child is the binary again. The alternative (a
separate sub-agent binary, or driving child agents through the SDK directly from
the extension) would split the runtime into two code paths to keep in sync, and
lose the property that a `--model` choice on the parent propagates to every
child. Two env knobs make the recursion behave: `OB_PARENT_MODEL` publishes the
resolved model so children inherit it (instead of silently reverting to the pi
default), and `OB_SUBAGENT_MODEL` floors children onto a fast trusted model when
the parent is slow.
