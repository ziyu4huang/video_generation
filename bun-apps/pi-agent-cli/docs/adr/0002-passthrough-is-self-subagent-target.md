# Passthrough exists so the binary is its own sub-agent target

pi-agent-cli ships a full pi-compatible passthrough mode (mirroring `pi -p` /
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
