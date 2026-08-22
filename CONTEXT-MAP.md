# CONTEXT-MAP — domain contexts index

Guidance: each domain owns its CONTEXT.md + docs/adr/ (ADR-<context>-NNNN style,
never bare numbers; bun-apps/docs/adr/INDEX.md lists all). This file is the index.

## Pipeline of record
- Agent development pipeline (wayfind -> superpowers <=> workflow/subagents):
  diagram of record lives in .planning/2026-08-20-develop-pipeline-v2/map.md
  (workflow as primary execution engine, tier system T1/T2/T3, pipeline-gate
  enforcement, unified dispatch records). Previous version:
  .planning/done/2026-08-17-develop-pipeline/map.md.

## Domain contexts
- bun-apps/s2-agent — thin monkey-patch wrapper around the real pi TUI (hardcoded
  providers, cwd-independent extensions) plus the non-interactive `s2-agent cli`.
  (s2-agent = renamed pi-agent, 2026-08-21; upstream deps still @earendil-works/pi-*;
  update flow unchanged; repo-root ./pi-agent.sh kept as deprecated compat alias.)
- bun-apps/s2-agent-core-runtime — core runtime nouns: RunView projection,
  SubagentInFlightRegistry, ActivityStatus vocabulary.
- bun-apps/s2-agent-ext-archify — typed-JSON-IR technical diagrams rendered to
  self-contained HTML, composed into meeting decks of NATIVE editable PowerPoint
  shapes; zero-browser, zero-blip, byte-locked diagram slides.
- bun-apps/s2-agent-ext-btw — BTW side-conversation modal for parallel Q&A
  without polluting main agent context.
- bun-apps/s2-agent-ext-devops — tool-based PR-merge/branch/local-CI lifecycle
  (structured JSON, no bash-polling loops); owns shared pipeline scripts.
- bun-apps/s2-agent-ext-file2md — file→Markdown bridge: rasterize PDFs, describe
  pages via local vision-LLM subagents, stitch into one project-local .md.
- bun-apps/s2-agent-ext-flux2 — agent-optimized wrapper around the flux2
  Swift/MLX image generator (Flux2 Klein 9B + SAM3.1), one dispatcher over 18 subcommands.
- bun-apps/s2-agent-ext-hermes-memory — persistent memory, session search, and
  secret scanning; facts/failures/corrections survive session close.
- bun-apps/s2-agent-ext-knowledge-card — Zettelkasten: atomic notes, vault CRUD,
  graph-enhanced RAG, and a deterministic convergence sink.
- bun-apps/s2-agent-ext-krea2 — minimal wrapper around the pure-Swift Krea 2
  Turbo CLI; 2 subcommands, shares wrapper architecture with flux2/ltx.
- bun-apps/s2-agent-ext-ltx — wrapper around ltx-video pure-Swift/MLX (LTX-2.3
  i2v); native-* family vs the run.py-bridged i2v.
- bun-apps/s2-agent-ext-movie-director — agent-first video production pipeline
  (Bun port of OpenMontage); the agent IS the orchestrator over manifests/gates.
- bun-apps/s2-agent-ext-obsidian — read/write/search/graph a project-local
  Obsidian vault; opt-in semantic search + distill/garden subagents.
- bun-apps/s2-agent-ext-power-tool — agent self-diagnostics: static load/token
  reporting plus failure-pathology detection.
- bun-apps/s2-agent-ext-research-tool — research collection: Bilibili/YouTube LLM
  videos, vault frontmatter, and arXiv paper discovery.
- bun-apps/s2-agent-ext-subagent — isolated single-subagent dispatch subsystem:
  subagent/subagent_runs tools, WorkflowAgent runner, spawnSubagent API.
- bun-apps/s2-agent-ext-superpowers — Pi-native port of the Superpowers
  methodology: 14 pinned skills + CSO discovery + using-superpowers bootstrap.
- bun-apps/s2-agent-ext-task — /goal objective driver + todo step tracker (shared
  status widget, lifecycle hooks); also owns ask_user_question and /response-language.
- bun-apps/s2-agent-ext-tool-gate — dynamic gate hiding heavy domain tools behind
  keyword matching (~22k → ~6.8k tok/req schema overhead).
- bun-apps/s2-agent-ext-wayfind — Pi-native port of Matt Pocock's decision-chain
  suite: grilling + wayfinder settle decisions before any code is written.
- bun-apps/s2-agent-ext-web-access — web access: 8 search providers behind one
  interface, content extraction, browser-curator fallback, SSRF protection.
- bun-apps/s2-agent-ext-ultracode — Claude Code-style dynamic workflows: JS
  orchestration fanning out parallel isolated subagents.
- bun-apps/s2-agent-ext-zai-mcp — Z.ai MCP servers bridged into pi as normal pi
  tools (pi has no built-in MCP integration).

## DevOps
- Git/branch/PR/merge phases: bun-apps/s2-agent-ext-devops (devops-workflow skill;
  CLI fallbacks in src/*-cli.ts).
