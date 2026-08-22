# T4 — one settings.json reader

Export `readUserSettings` from sessions/shared.ts. passthrough's
`readUserDefaults()` becomes an async wrapper returning
`{ provider: s.defaultProvider, model: s.defaultModel } | undefined`.

Keep the exported signature — workflow.ts:39 imports it. Update header comment;
drop the "preserves dynamic-import style" note (shared.ts already statically
imports pi-coding-agent, so loading behavior cannot change).

**Verify**: workflow-command.test.ts hermeticity cases + full suite.

Status: **closed**
