# `s2-agent cli` — verification report

End-to-end verification that the non-interactive CLI works on the current
`main`. Re-run the commands in [Reproduce (smoke)](#reproduce-smoke) below.

> Verified: 2026-06-27 (typecheck + live e2e refreshed 2026-07-16) · branch
> `main@0809dc4`

> **Amended 2026-08-12 (s2-agent-cli merge).** This report was written while the
> CLI was its own package (`bun-apps/s2-agent-cli`, program name
> `bun-s2-agent-cli`). It now lives inside `s2-agent` at `src/cli/**` and is
> reached as `s2-agent cli <command>`. Two consequences for what follows:
>
> 1. **Paths.** `src/commands/` → `src/cli/commands/`, `src/sessions/` →
>    `src/cli/sessions/`, `src/__tests__/` → `src/cli/__tests__/`. The invocation
>    `bun src/cli.ts <command>` → `bun bun-apps/s2-agent/src/cli.ts cli <command>`
>    (or `./s2-agent.sh cli <command>` from the repo root). Every command in the
>    Reproduce section has been rewritten to a form that runs today; the
>    historical *findings* are left as written.
> 2. **The standalone-bundle assertions no longer describe a real property.**
>    The CLI had its own `scripts/build.ts` producing a self-contained
>    `dist/bun-s2-agent-cli/cli.js`. That script and that artifact are both gone:
>    the CLI ships inside s2-agent's four deploy modes (`scripts/deploy.ts`
>    `--bundle` / `--snapshot` / `--standalone` / `--exe`), so "the CLI bundle is
>    self-contained" is no longer a separable claim to verify — s2-agent's own
>    deploy tests own it. Rows and sections asserting it are annotated in place
>    rather than deleted, so the verification history stays readable.

## 2026-07-16 update — typecheck drift fix + a real live-blocking bug

Re-ran `bunx tsc --noEmit` and `bun test`, then re-verified live e2e end to
end. Findings:

- **Own-package tsc errors: 23 → 0.** All fixed in `src/cli/__tests__/`,
  `src/cli/commands/` (doctor.ts, knowledge-pipeline.ts, tools-metrics.ts), and
  `workflows/lib/`. 448 transitive errors in sibling packages
  (`s2-agent-ext-web-access`, `s2-agent-ext-obsidian`, …) are unchanged and
  **out of scope** — tracked as known/deferred, not this package's debt. Added
  `bun run typecheck` (`bunx tsc --noEmit`) as a local convenience script;
  **not** wired into CI (would false-red on the transitive errors).
- **Fixed a real functional gap, not just a type annotation.**
  `knowledge-pipeline.ts` read `parsed.memoryDir` / `parsed.reconverge`, but
  `args.ts` never parsed `--memory-dir` / `--reconverge` — both flags were dead
  code (silently ignored). Added proper flag-spec rows so they now work.
- **Found + fixed a live-blocking bug in a sibling package.** `distill` /
  `zk-extract` / `zk-card` / `zk-ask` / `pipeline pdf-to-vault` stage 2 were
  **all broken** at runtime: `s2-agent-ext-knowledge-card/extensions/
  knowledge-card.ts`'s tool allowlists (`DISTILL_TOOLS`, `ADD_TOOLS`,
  `FIND_TOOLS`, `UPDATE_TOOLS`, `REMOVE_TOOLS`, `CHECK_TOOLS`, `RAG_TOOLS`)
  still referenced the pre-Phase-3 granular `obsidian_*` tool names
  (`obsidian_list`, `obsidian_read`, `obsidian_search`, `obsidian_distill`, …).
  `s2-agent-ext-obsidian` had already folded all 18 granular tools into one
  action-dispatched `obsidian` tool (+ `obsidian_help`) — those old names are
  no longer independently registered — but `s2-agent-ext-knowledge-card`'s
  allowlists were never updated to match, so every subagent spawn hit `error:
  Unknown tool name(s) in --tools / PI_TOOLS`. Fixed by collapsing every list
  to `["obsidian", "obsidian_help"]` (`DISTILL_TOOLS` also keeps `"read"` for
  filesystem input files), matching the pattern `s2-agent-ext-obsidian`'s own
  `OBSIDIAN_DISTILL_TOOLS` already used. Updated the one test that hardcoded
  the stale CSV. Re-verified: `pipeline pdf-to-vault` and `distill` both now
  complete successfully end to end (see updated test matrix below).
  - **Not fixed this pass:** several task-prompt strings in
    `knowledge-card.ts` still tell the subagent to "call the
    `obsidian_distill` tool" / "`obsidian_search` matchMode:…" as if those
    were standalone tool names, instead of `obsidian` with `action:"distill"`
    / `action:"search"`. These are prompt-quality issues, not hard failures
    (the subagent worked around it via `obsidian_help`, per the live test
    below) — flagged as a follow-up, out of scope for this pass.

## Environment

| Item | Value |
|------|-------|
| Runtime | Bun `1.3.14` on macOS (Darwin 25.5.0) |
| Deps | `bun install` → 502 packages |
| Config | `~/.pi/agent/{settings,models,auth}.json` |
| Credentials | **from env** (`ZAI_API_KEY`, `DEEPSEEK_API_KEY`); `auth.json` is `{}` |
| Default model | `zai/glm-5.3` (from `settings.json`) |
| Local VLM | LM Studio `localhost:1234` — `google/gemma-4-12b` loaded || `list` | 53 models resolve with valid credentials |

## Test matrix (all PASS)

| # | Path | Model | Result |
|---|------|-------|--------|
| 1 | ~~`scripts/build.ts` (bundle + minify)~~ | — | ~~✓ `dist/bun-s2-agent-cli/cli.js` + sourcemap~~ — **obsolete 2026-08-12**: no per-CLI build script or artifact; see `bun scripts/deploy.ts` |
| 2 | ~~bundle `version` / `help`~~ | — | ~~✓ runs from `dist/`~~ — **superseded**: now `bun dist/s2-agent/s2-agent.js cli version` against s2-agent's deploy |
| 3 | meta: `version` / `-v` / `help` / `help <cmd>` / `list` | — | ✓ |
| 4 | passthrough (core agent loop) | zai/glm-5.3 | ✓ `PI-CLI-OK` |
| 5 | `distill` (markdown → Zettelkasten) | zai/glm-5.3 | ✓ 5 notes + MOC, 14 wiki-links |
| 6 | `file2md` (image → Obsidian md) | lm-studio/gemma-4-12b | ✓ OCR+describe, 397 chars |
| 7 | `pipeline pdf-to-vault` (PDF → md → vault) | stage1 gemma / stage2 glm-5.3 | ✓ 1/1 page → 4 notes || 8 | `pipeline pdf-to-vault` resume | — | ✓ skips done page + stage 2 |

### 2026-07-16 re-verification (post typecheck-fix + knowledge-card bug fix)

| # | Path | Model | Result |
|---|------|-------|--------|
| 1 | ~~`scripts/build.ts` (bundle + minify)~~ | — | ~~✓ `dist/s2-agent-cli/cli.js`~~ — **obsolete 2026-08-12** (see banner) |
| 2 | meta: `version` / `list` | — | ✓ (`list` now resolves 1068 models — registry growth since 06-27, unrelated to this pass) |
| 3 | passthrough (core agent loop) | zai/glm-5.3 | ✓ `PI-CLI-OK` |
| 4 | `vlm-describe` (image → Obsidian md) | lm-studio/gemma-4-12b | ✓ 709 chars (synthetic test image; the 06-27 fixture PDF is not checked into the repo) |
| 5 | `distill` (markdown → Zettelkasten) | zai/glm-5.3 | ✓ 4 notes + MOC, 10 links — **first attempt hit the knowledge-card tool-allowlist bug below; passes after the fix** |
| 6 | `pipeline pdf-to-vault` (PDF → md → vault) | stage1 gemma / stage2 glm-5.3 | ✓ 1/1 page → 3 notes — **stage 2 hit the same allowlist bug on the first attempt; passes after the fix** || 7 | `pipeline pdf-to-vault` resume | — | not re-run this pass (unchanged code path; 06-27 result stands) |
| 8 | `bun test` (this package) | — | ✓ 332/332, 22 files |
| 9 | `bun test` (`s2-agent-ext-knowledge-card`, touched by the fix) | — | ✓ 337/337, 22 files |

## Key behaviors confirmed

- **Self-subagent recursion** — the parent agent invokes `obsidian_distill`,
  which spawns an isolated subagent that **re-invokes this same entry point** in
  pi-compatible JSON mode and writes notes via `obsidian_create`. Observed in
  both `distill` and pipeline stage 2 (`[tool] obsidian_distill` →
  `[tool done] (ok)`). *(Still true post-merge; the child now re-enters via
  `PI_SELF_ENTRY_PREFIX=cli` so it lands in the `cli` namespace rather than the
  TUI root — see ADR 0002.)*
- **VLM path** — magic-number sniff (`kind: image|pdf`), profile classifier
  (VLM on page 1), per-page explain wrapped in `withRetry` (429/transient
  aware). gemma-4-12b correctly read a hand-rendered "Photosynthesis" image.
- **Pipeline coordination** — timestamped+slug run dir, `pipeline.json` with
  per-stage status (`file2md` / `distill`), options captured for resume.
- **Resume** — re-run reuses the run dir: stage 1 skips pages already `done`,
  stage 2 skipped unless `--force-distill`.

## Reproduce (smoke)

All paths below are relative to the **repo root**. `./s2-agent.sh cli …` and
`bun bun-apps/s2-agent/src/cli.ts cli …` are interchangeable.

```bash
( cd bun-apps && bun install )                 # workspace root — never inside s2-agent/

# offline
./s2-agent.sh cli version
./s2-agent.sh cli help
./s2-agent.sh cli list
( cd bun-apps/s2-agent && bun test )           # unit + offline e2e

# live — passthrough (needs ZAI_API_KEY)
./s2-agent.sh cli -p --no-session "Reply with: PI-CLI-OK"

# live — zk-extract (needs ZAI_API_KEY)
./s2-agent.sh cli zk-extract input.md --vault /tmp/v --folder Zettelkasten --max-notes 6

# live — file2md + pipeline (needs LM Studio on :1234)
./s2-agent.sh cli file2md page.png --out /tmp/vlm-out
./s2-agent.sh cli pipeline pdf-to-vault page.pdf --out /tmp/pipe-out --pages 1
./s2-agent.sh cli pipeline pdf-to-vault page.pdf --out /tmp/pipe-out --pages 1   # resume

# deployed artifact (after `bun run --cwd bun-apps/s2-agent deploy`)
bun dist/s2-agent/s2-agent.js cli version
```

> The `distill` command referenced in the historical matrix above was renamed
> `zk-extract`; the substituted line is the current equivalent.

## Dynamic workflow regression (2026-06-27) — historical, not re-runnable

> **Not runnable today.** The driving script
> `.claude/workflows/verify-bun-s2-agent-cli.js` no longer exists, and neither
> does the dist bundle it targeted. The findings and the robustness matrix below
> are retained as the record of what was exercised and fixed; the *procedure* is
> history. The equivalent live surface today is the offline e2e suite
> (`bun test bun-apps/s2-agent/src/cli/__tests__/e2e/`) plus the manual live
> commands in [Reproduce (smoke)](#reproduce-smoke).

A reusable, cwd-independent workflow drove the full verify:
`.claude/workflows/verify-bun-s2-agent-cli.js` — phases **Resolve → Build →
Smoke → Robust → Regression**. Resolve canonicalized every path to absolute
form and minted a fresh `runDir`, so no agent depended on cwd or a hardcoded
worktree (mirroring the `pi-extension-obsidian-tool.js` resolve pattern). Build
produced the **dist bundle + external sourcemap**; all checks ran the **dist
bundle** (`dist/bun-s2-agent-cli/cli.js`), not `src/cli.ts`. Regression ran
against the `fixture/2025.emnlp-main.893.pdf` baseline (16-page EMNLP paper;
`--pages 1-3`).

### Iteration history (4 workflow runs → 7 fixes)

The workflow was run iteratively; each run surfaced defects that were fixed
and re-verified. The CLI was clean at every step (no crashes / stack traces);
the findings below are mostly VLM-output fidelity + a few genuine robustness
gaps, all now fixed.

| Run | Agents | Surfaced | Fix (commit) |
|-----|--------|----------|--------------|
| 1 | 9 | embed stray angle brackets `![[<…>]]`; English body → 繁中 translation | `normalizeEmbeds()` + literal embed in per-page msg (0eceb65) |
| 2 | 16 | wrong `page:` in frontmatter (page-003→1); resume re-classified (wasted VLM call) | `normalizeFrontmatter()` page/kind override + resume profile reuse (9bf7c61) |
| 3 | 16 | confirmed embed/resume fixes; **unclosed** frontmatter (gemma drops closing `---`); page-001 body `---` gobbled as closer | robust frontmatter repair — unified contiguous-kv parse (1305620) |
| 4 | 19 | **`--dpi` not validated** (`abc` silently→150, `-1` accepted → broken render + misleading exit 0) | up-front dpi validation 1–4096 + **3 new attack tests** |

Also fixed across runs: empty/invalid `--pages` now errors "matched no pages"
instead of silently skipping (0eceb65); top-level `try/catch` in `cli.ts` for
clean one-liner errors with no stack trace (0eceb65).

### Final run results (run 4, 19 agents, ~13 min) — all PASS

| Phase | Result |
|-------|--------|
| Build | ✅ bundle 6753 KB + `cli.js.map` |
| Smoke | ✅ 3/3 (offline-meta `Total: 53`; passthrough `PI-CLI-OK` via glm-5.3; distill 3 notes + MOC + wiki-links, via dist bundle) |
| Robust | ✅ **10/10** attack checks graceful (see matrix below) |
| Regression run | ✅ status `done`; stage1 3/3 pages; stage2 8 notes |
| stage1-vlm | ✅ ok · 4/5 — page fields all correct, embeds clean (no stray brackets), structure/equations faithful |
| stage2-distill | ✅ ok · 5/5 — 8 notes + MOC, all frontmatter, no dangling note links |
| coord-resume | ✅ ok · 5/5 — pipeline.json consistent; resume reused run dir (byte-identical), skipped done pages + stage 2 |

### Robustness matrix (10/10 graceful)

Every attack vector fails gracefully: non-zero exit, a clean human message, and
**no uncaught-exception stack trace**.

| # | Check | Input | Behavior |
|---|-------|-------|----------|
| 1 | bad-input-missing | nonexistent file | `error: Input not found` · exit 1 |
| 2 | bad-input-wrongtype | `.txt` file | `error: Unsupported input …` · exit 1 |
| 3 | page-spec-invalid | `--pages abc` / `5-2` | `error: --pages "…" matched no pages` · exit 1 (no silent skip) |
| 4 | bad-type-flag | `--type notaprofile` | `error: Invalid --type …` · exit 1, rejected before rasterize |
| 5 | unknown-pipeline | `pipeline bogus` / `pipeline` | `Unknown pipeline` / usage · exit 1 |
| 6 | distill-missing | nonexistent `.md` | `error: Input not found` · exit 1 |
| 7 | slug-traversal-safety | `../../etc/passwd.pdf` etc. | `slugify` basename-collapses → traversal-safe (exit 0) |
| 8 | **dpi-invalid** *(new)* | `--dpi abc/-1/0/99999` | `error: Invalid --dpi … 1–4096` · exit 1, before any render |
| 9 | **directory-input** *(new)* | a directory, not a file | `error: Input is not a regular file` · exit 1 |
| 10 | **corrupt-pdf** *(new)* | 0-byte / zip-magic fake PDF | `error: pdf2png failed (exit 3) …` · exit 1, caught cleanly |

### Known model-behavior findings (NOT CLI robustness bugs)

These are gemma-4-12b / LM-Studio **output-fidelity** characteristics surfaced
by a real multi-page paper. The CLI handles all of them gracefully (no crash,
clean exit, correct manifest); they are tracked as model/prompt follow-ups:

- **Output truncation** — dense pages occasionally end mid-sentence (e.g.
  `…例如或調用額外的工具…`), and a `(內容截斷)` placeholder sometimes appears.
  Root cause is the LM-Studio server-side output cap, **not** the CLI: the
  model registry already declares `maxTokens: 16384` / `contextWindow: 128000`,
  well above a single page (~2.5k chars). There is no per-call `maxTokens` knob
  on the SDK `session.prompt()` surface to raise it from the CLI.
- **`(模糊不可讀)` placeholders** — partly *by design*: the explain prompt
  instructs the VLM to mark illegible spots this way. gemma sometimes applies
  it where text was arguably recoverable → mild information loss.
- **Frontmatter `title` variance** — `normalizeFrontmatter()` enforces only
  `page`/`kind` (CLI-known); `title` is left to the VLM, which occasionally
  writes the bare slug instead of a real title.
- **Classifier non-determinism** — the page-1 profile classifier returns
  paper/NLP/BIOLOGY inconsistently across runs; `kind:` stays consistent with
  the chosen profile regardless.
- **繁中 output** — by design (the tool targets 繁中 notes); the verifier is
  instructed not to penalize language choice.

## Notes / gaps

- **CLI-level unit + offline e2e tests.** `src/cli/__tests__/` had 22 files, 332
  tests at the time of writing, all passing under plain `bun test`. Of those,
  `src/cli/__tests__/e2e/` is a
  self-contained OFFLINE subprocess suite (see below) — no API keys or LM Studio
  needed. Live end-to-end verification (env keys, LM Studio) is manual, per
  [Reproduce (smoke)](#reproduce-smoke).
- **Offline e2e suite (`src/cli/__tests__/e2e/`, 44 tests).** Spawns the CLI in
  source mode (`bun src/cli.ts cli …`, hermetic env, `PI_SKIP_MODELS_JSON=1`) and
  asserts exit code + stdout/stderr at the process boundary. Covers the surface
  that short-circuits BEFORE any model call, so it needs no keys / LM Studio:
  version / help / list / list-tools / completions (meta), pipeline / workflow
  bogus + missing-name (dispatch errors), `--dpi` / numeric / `--source`
  validation with a **no-stack-trace** contract (arg-validation), and the `--`
  separator / oneshot alias / global-flags-before-command (misc). It also guards
  two fixes it surfaced: `help <meta-command>` no longer executes the target,
  and `--dpi` rejects fractional values. Model-dependent paths (chat / agent /
  passthrough / zk-* happy paths) are deliberately NOT covered — they belong to
  the live smoke run. Run:
  `( cd bun-apps/s2-agent && bun test src/cli/__tests__/e2e/ )`.
- **`bun test` does not typecheck.** Run `bun run typecheck` (= `bunx tsc
  --noEmit`, added as a package script 2026-07-16) to catch type regressions.
  NOTE: this package's `tsconfig.json` has no `include`/`paths`, and Bun
  workspace symlinks resolve `@repo/*` deps to SOURCE (not built dist), so
  `tsc --noEmit` follows into sibling packages. As of 2026-07-16: **0 errors in
  the CLI's own `src/` (now `src/cli/`) + `workflows/lib/`** (was ~23, all fixed) — 448
  errors remain in sibling packages (`s2-agent-ext-obsidian` / `-web-access` /
  `-ltx` / `-movie-director` / …), unchanged and out of scope for this package.
  The real CI gate is `bun test` (green); `tsc` is a stricter, monorepo-wide
  concern, and `bun run typecheck` is deliberately **not** wired into CI here
  — the transitive errors would make it false-red until each sibling package
  fixes its own.
- **`--` end-of-options separator.** A bare `--` disables flag-parsing for the
  rest of argv, so extension sub-commands can pass their own flags through
  verbatim (`flux2 -- t2i --prompt "..."`) and passthrough prompts can include
  leading-dash operands (`-- "-5 degrees"`).
- **Live tests depend on external state** (env keys, LM Studio) — not hermetic.
