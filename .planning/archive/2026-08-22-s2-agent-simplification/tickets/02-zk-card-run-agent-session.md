# T2 — zk-card routes through runAgentSession

Extend `RunAgentSessionOptions` (run-agent-session.ts):

- `defaultTools?: string[]` — applies the `parsed.tools ?? <default>` rule inside.
- `labelPrefix?: string` — model log line becomes `[<prefix>]  model: <label>  thinking: <level>`.

zk-card.ts: keep `applyVaultEnv(parsed)` at each call site; delete
`runKnowledgeTask`; every subcommand calls
`runAgentSession(parsed, { defaultTools, labelPrefix: "zk-card <sub>", task })`.

**Verify**: package suite + typecheck.

Status: **closed**
