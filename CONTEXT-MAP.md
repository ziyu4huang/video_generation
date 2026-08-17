# CONTEXT-MAP — domain contexts index

Guidance: each domain owns its CONTEXT.md + docs/adr/ (ADR-<context>-NNNN style,
never bare numbers; bun-apps/docs/adr/INDEX.md lists all). This file is the index.

## Pipeline of record
- Agent development pipeline (wayfind -> superpowers <=> subagents): diagram of
  record lives in .planning/2026-08-17-develop-pipeline/map.md (D9). Routing
  table: superpowers using-superpowers bootstrap.

## Domain contexts
- bun-apps/pi-agent — thin monkey-patch wrapper around the real pi TUI (hardcoded
  providers, cwd-independent extensions) plus the non-interactive `pi-agent cli`.
- bun-apps/pi-agent-core-runtime — core runtime nouns: RunView projection,
  SubagentInFlightRegistry, ActivityStatus vocabulary.
- bun-apps/pi-agent-ext-btw — BTW side-conversation modal for parallel Q&A
  without polluting main agent context.
- bun-apps/pi-agent-ext-devops — tool-based PR-merge/branch/local-CI lifecycle
  (structured JSON, no bash-polling loops); owns shared pipeline scripts.
- bun-apps/pi-agent-ext-file2md — file→Markdown bridge: rasterize PDFs, describe
  pages via local vision-LLM subagents, stitch into one project-local .md.
- bun-apps/pi-agent-ext-flux2 — agent-optimized wrapper around the flux2
  Swift/MLX image generator (Flux2 Klein 9B + SAM3.1), one dispatcher over 18 subcommands.
- bun-apps/pi-agent-ext-hermes-memory — persistent memory, session search, and
  secret scanning; facts/failures/corrections survive session close.
- bun-apps/pi-agent-ext-knowledge-card — Zettelkasten: atomic notes, vault CRUD,
  graph-enhanced RAG, and a deterministic convergence sink.
- bun-apps/pi-agent-ext-krea2 — minimal wrapper around the pure-Swift Krea 2
  Turbo CLI; 2 subcommands, shares wrapper architecture with flux2/ltx.
- bun-apps/pi-agent-ext-ltx — wrapper around ltx-video pure-Swift/MLX (LTX-2.3
  i2v); native-* family vs the run.py-bridged i2v.
- bun-apps/pi-agent-ext-movie-director — agent-first video production pipeline
  (Bun port of OpenMontage); the agent IS the orchestrator over manifests/gates.
- bun-apps/pi-agent-ext-obsidian — read/write/search/graph a project-local
  Obsidian vault; opt-in semantic search + distill/garden subagents.
- bun-apps/pi-agent-ext-power-tool — agent self-diagnostics: static load/token
  reporting plus failure-pathology detection.
- bun-apps/pi-agent-ext-research-tool — research collection: Bilibili/YouTube LLM
  videos, vault frontmatter, and arXiv paper discovery.
- bun-apps/pi-agent-ext-subagent — isolated single-subagent dispatch subsystem:
  subagent/subagent_runs tools, WorkflowAgent runner, spawnSubagent API.
- bun-apps/pi-agent-ext-superpowers — Pi-native port of the Superpowers
  methodology: 14 pinned skills + CSO discovery + using-superpowers bootstrap.
- bun-apps/pi-agent-ext-task — /goal objective driver + todo step tracker (shared
  status widget, lifecycle hooks); also owns ask_user_question and /response-language.
- bun-apps/pi-agent-ext-tool-gate — dynamic gate hiding heavy domain tools behind
  keyword matching (~22k → ~6.8k tok/req schema overhead).
- bun-apps/pi-agent-ext-wayfind — Pi-native port of Matt Pocock's decision-chain
  suite: grilling + wayfinder settle decisions before any code is written.
- bun-apps/pi-agent-ext-web-access — web access: 8 search providers behind one
  interface, content extraction, browser-curator fallback, SSRF protection.
- bun-apps/pi-agent-ext-workflow — Claude Code-style dynamic workflows: JS
  orchestration fanning out parallel isolated subagents.
- bun-apps/pi-agent-ext-zai-mcp — Z.ai MCP servers bridged into pi as normal pi
  tools (pi has no built-in MCP integration).

## DevOps
- Git/branch/PR/merge phases: bun-apps/pi-agent-ext-devops (devops-workflow skill;
  CLI fallbacks in src/*-cli.ts).
