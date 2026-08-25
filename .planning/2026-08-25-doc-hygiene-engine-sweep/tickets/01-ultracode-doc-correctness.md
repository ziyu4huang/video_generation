# 01 — ultracode/workflow doc correctness: Path-A citations + inert `-e` prose + knowledge-distill invocation

Source: map Context (15 `-e` sites + 5 Path-A sites + knowledge-distill.js:28).

## Scope

- **Path-A citations** (ext-ultracode):
  - `src/workflow-pack.ts:4-7` header — "shared by BOTH entry paths" lists the
    removed Path A; rewrite to the single remaining path (D1: code headers
    rewritten outright).
  - `PRD.md` two-paths section (:55-82) + headless invocation (~:92-102) — add
    `STATUS 2026-08-25` amendment: Path A removed (#2015); keep history (D1).
  - `CONTEXT.md` **Entry path** term (:54-58) — rewrite to single path.
- **`-e` prose ×15 sites / 12 files** (map Context list, all verified
  comments/docs): drop the flag (`run.sh -e workflow -p` → `run.sh -p`), reword
  "alias `-e workflow` resolution" → the built-in workflow extension (D2).
- **`s2-agent/workflows/knowledge-distill.js:28`** — invocation block cites
  `cli workflow run knowledge-distill`; point at the `workflow` tool (name:
  knowledge-distill) per the file's own tool-era docs.
- **Fog pre-check before close**: repo-wide grep `cli workflow` over live
  docs/skills (`bun-apps`, `.claude/skills`, `docs/`) — fix or record every hit.

## Acceptance criteria

- [x] Path-A citation sites state the single-path reality (PRD = amendment)
- [x] All 15 `-e` sites fixed or per-site verdict recorded
- [x] `cli workflow` live-doc grep clean (or hits dispositioned in-ticket)
- [x] Touched packages' canonical `bun run test` green (ultracode, krea2, flux2, s2-agent)
- [x] No version bumps; merged via devops chain; reviewer pass

## Review round (2026-08-25, verdict WITH-FIXES → fixed)

- Blocker 1 fixed: knowledge-distill.js INVOCATION had the old
  `# or from markdown sources:` / `--args '…'` pair duplicated under the new
  form (my patch replaced the head but not the tail) — deduped; the orphan
  `--args` flag form (a flag of the removed CLI) became an args-JSON comment.
- Blocker 2 fixed: `meta.description` still said "runnable via `s2-agent
  workflow run`" (a form that never existed) → built-in workflow tool form.
- NITs fixed: PRD:26 invented-looking "since 2026-07-10" date dropped;
  s2-agent CONTEXT.md Workflow-pack + resolution-precedence terms de-CLI'd;
  cli.ts:116 namespace comment drops `workflow run`; ext-ultracode
  CONTEXT.md:186 CLI arm; workflow-pack.test.ts / workflow-tool-pack.test.ts /
  workflow-tool.ts Path-A comments → removal-noted historical wording.
- **Grep-claim correction (reviewer):** residual `-e workflow` hits are 2, not
  0 — both benign + now dispositioned: scripts/run-ext-e2e.sh:13 (NEGATED
  mention: "no `-e workflow` needed") and scripts/run-self-improve-loop.sh:6
  (past-tense history note). Left as-is deliberately.

## Outcome (2026-08-25)

- Path-A: workflow-pack.ts header rewritten (single entry path); PRD gets the
  D1 STATUS amendment at the two-paths section + :26 dependency line + headless
  invocation block rewritten to the tool-era `-p` form; CONTEXT.md Pack-resolver
  + **Entry path** terms rewritten (single path, no `-e`).
- All 15 `-e` sites fixed: invocation forms drop the flag (`run.sh -e workflow -p`
  → `run.sh -p`); "alias resolution"/"incantation" prose reworded to
  built-in/static-loaded. Residual repo-wide grep for `-e workflow|-e ultracode`
  = 0.
- **Scope-plus (measured, not creep):** samples/audit-run-dir-resolve.js's AUDIT
  TARGET was the deleted lazy resolver — header retargeted to resolve.ts's argv
  construction and the three audit prompts' deleted-symbol lists
  (resolveLazyExtension/rewriteExtensionArgs/buildBundleArgvFromLayout) replaced
  with the live surface (buildArgvFromManifest/suppressResolvedArgv/mode guards).
  Zero external references (grep receipt), standalone sample.
- knowledge-distill.js INVOCATION block → tool-era form with removal note.
- `cli workflow` residual hits ALL sanctioned history: PRD STATUS amendment +
  its historical Path-A bullet, workflow-pack.ts removal note, s2-agent ADR 0008
  (dated record — .planning-style snapshot discipline), s2-agent CONTEXT.md:95 +
  workflows/README.md:11 + dispatch-log.ts:7 already documented the removal
  (round-2 t02, untouched).
- Gates: ultracode 1193/0 (check+typecheck+unit); krea2 66/0; flux2 138/0;
  s2-agent 953/0/3. No version bumps (doc-only).
