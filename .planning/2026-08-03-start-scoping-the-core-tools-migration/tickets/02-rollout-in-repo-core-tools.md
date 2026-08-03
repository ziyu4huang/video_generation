## Question
Owner-declare `gating:{ core: true }` on the 14 in-repo CORE_TOOLS members across 4 packages, and wire each package into the QA corpus + drift-guard so the declarations are captured/verified. Packages + tools: pi-agent-ext-hermes-memory (memory, memory_search, session_search, skill_manage, grill_decision); pi-agent-ext-knowledge-card (zk_card, zk_ask, zk_ingest, knowledge_query); pi-agent-ext-web-access (web_search, fetch_content, get_search_content); pi-agent-ext-obsidian (obsidian, obsidian_help). For each tool: add `gating: { core: true }` to its tool def (inside the defineTool/registerTool literal); add the package's registrar to `qa/evaluate.ts` `captureOwnerDeclaredDefs([...])` + `MIGRATED_EXTENSIONS` in drift-guard.test.ts (mirror GATES rollouts 04–12); add a local `tool-gating.d.ts` augmentation where the package needs it to typecheck (mirror subagent/workflow). Verify each package's `bun test` + the tool-gate suite green; `bun run qa` stays PASS. The 4 already-declared (todo/goal_complete/ask_user_question/enable_tool) are NOT in scope (done).

type: task
blocked by:
status: open
