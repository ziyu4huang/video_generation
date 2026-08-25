**ID:** `ADR-s2-agent-0006` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: repo-root `CONTEXT-MAP.md`

# --dry-run excludes write tools (deterministic guard, not an LLM instruction)

`s2-agent cli`'s `--dry-run` is implemented in `dryRunExclude()`
(`src/cli/sessions/shared.ts`): when set, it adds the `WRITE_TOOLS` set — the Obsidian
mutating tools (`obsidian_create`, `obsidian_append`, `obsidian_append_section`,
`obsidian_update_frontmatter`, `obsidian_move`, `obsidian_rename`,
`obsidian_delete`, `obsidian_invalidate`, `obsidian_distill`, `obsidian_garden`)
— to the session's `excludeTools`. The write tools are therefore unavailable to
the session: the agent physically cannot mutate the vault, regardless of what it
is instructed to do. The read-only tools (`obsidian_read`, `obsidian_search`,
`obsidian_list`, `obsidian_query`, `obsidian_status`, `obsidian_open`,
`obsidian_semantic_search`) stay available so the agent can still gather context
and report what it WOULD do.

The point of doing it this way — excluding the tools rather than appending a
"do not write" instruction to the system prompt — is determinism. Relying on the
LLM to obey a dry-run instruction is fragile: the model may still emit a write
tool call, and "dry-run" becomes a hope, not a guarantee. Excluding the tools
makes the dry-run a hard property of the session: no write can occur by any
path. The trade-off is zero flexibility — a write the agent genuinely should
make during a planned dry-run cannot go through; the run is read-and-plan only.
Accepted because a dry-run that can still write is not a dry-run.
