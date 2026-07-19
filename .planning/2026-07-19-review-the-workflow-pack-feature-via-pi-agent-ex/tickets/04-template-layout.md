## Question

What is the canonical internal folder layout the template prescribes?

type: prototype
status: closed
claimed: chart-session (2026-07-19)

## Resolution

**Flat top-level dirs** — every category visible on `ls`; the three ephemeral dirs gitignored together. This is the literal "clear insider folder structure template" — it encodes the I/O contract as directory structure, so an agent identifies input/output/intermediate/history at a glance.

```
<pack>/                         # instantiated under .pi/workflows/<name>/ (see 07)
├── manifest.json        # io contract, agent refs, version, retention (see 05, 08, 09)
├── entry.js             # orchestration script (manifest.entry points here)
├── agents/              # bundled subagent defs, .claude/agents-compatible (see 09)
│   └── <role>.md
├── inputs/              # input seeds / fixtures   (version-controlled)
├── outputs/             # run results              (gitignored, purgable)
├── intermediate/        # on-disk intermediates    (gitignored, purged aggressively)
├── runs/                # run history / journal    (gitignored, retention policy)
└── .gitignore           # outputs/ intermediate/ runs/ *.lock
```

Consequence locked here: **intermediates are persisted to disk** (a new engine capability — today's design keeps them in-memory in script variables). "Clean intermediate files" is impossible otherwise. Mechanics (naming, when written/purged, opt-in vs always-on) → ticket 12.

Rejected:
- **Nested `state/` container** — categories hide one level down; less at-a-glance for the agent.
- **Lean template, engine-created state** — agent can't see state structure by listing the pack before a run.
