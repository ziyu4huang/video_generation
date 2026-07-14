# bun-pi-agent-cli — verification report

End-to-end verification that the self-contained pi-agent CLI works on the
current `main`. Re-run the commands below to reproduce.

> Verified: 2026-06-27 · branch `verify/bun-pi-agent-cli` (off `main@9a3f0ec`)

## Environment

| Item | Value |
|------|-------|
| Runtime | Bun `1.3.14` on macOS (Darwin 25.5.0) |
| Deps | `bun install` → 502 packages |
| Config | `~/.pi/agent/{settings,models,auth}.json` |
| Credentials | **from env** (`ZAI_API_KEY`, `DEEPSEEK_API_KEY`); `auth.json` is `{}` |
| Default model | `zai/glm-5.2` (from `settings.json`) |
| Local VLM | LM Studio `localhost:1234` — `google/gemma-4-26b-a4b-qat` loaded |
| `list` | 53 models resolve with valid credentials |

## Test matrix (all PASS)

| # | Path | Model | Result |
|---|------|-------|--------|
| 1 | `scripts/build.ts` (bundle + minify) | — | ✓ `dist/bun-pi-agent-cli/cli.js` + sourcemap |
| 2 | bundle `version` / `help` | — | ✓ runs from `dist/` |
| 3 | meta: `version` / `-v` / `help` / `help <cmd>` / `list` | — | ✓ |
| 4 | passthrough (core agent loop) | zai/glm-5.2 | ✓ `PI-CLI-OK` |
| 5 | `distill` (markdown → Zettelkasten) | zai/glm-5.2 | ✓ 5 notes + MOC, 14 wiki-links |
| 6 | `vlm-describe` (image → Obsidian md) | lm-studio/gemma-4-26b | ✓ OCR+describe, 397 chars |
| 7 | `pipeline pdf-to-vault` (PDF → md → vault) | stage1 gemma / stage2 glm-5.2 | ✓ 1/1 page → 4 notes |
| 8 | `pipeline pdf-to-vault` resume | — | ✓ skips done page + stage 2 |

## Key behaviors confirmed

- **Self-contained architecture** — the parent agent invokes `obsidian_distill`,
  which spawns an isolated subagent that **re-invokes this binary** in
  pi-compatible JSON mode and writes notes via `obsidian_create`. Observed in
  both `distill` and pipeline stage 2 (`[tool] obsidian_distill` →
  `[tool done] (ok)`).
- **VLM path** — magic-number sniff (`kind: image|pdf`), profile classifier
  (VLM on page 1), per-page explain wrapped in `withRetry` (429/transient
  aware). gemma-4-26b correctly read a hand-rendered "Photosynthesis" image.
- **Pipeline coordination** — timestamped+slug run dir, `pipeline.json` with
  per-stage status (`vlm-describe` / `distill`), options captured for resume.
- **Resume** — re-run reuses the run dir: stage 1 skips pages already `done`,
  stage 2 skipped unless `--force-distill`.

## Reproduce (smoke)

```bash
cd bun-pi-agent-cli && bun install            # at root

# offline
bun scripts/build.ts                           # bundle
bun ../dist/bun-pi-agent-cli/cli.js version
bun src/cli.ts list

# live — passthrough (needs ZAI_API_KEY)
bun src/cli.ts -p --no-session "Reply with: PI-CLI-OK"

# live — distill (needs ZAI_API_KEY)
bun src/cli.ts distill input.md --vault /tmp/v --folder Zettelkasten --max-notes 6

# live — vlm-describe + pipeline (needs LM Studio on :1234)
bun src/cli.ts vlm-describe page.png --out /tmp/vlm-out
bun src/cli.ts pipeline pdf-to-vault page.pdf --out /tmp/pipe-out --pages 1
bun src/cli.ts pipeline pdf-to-vault page.pdf --out /tmp/pipe-out --pages 1   # resume
```

## Dynamic workflow regression (2026-06-27)

A reusable, cwd-independent workflow drives the full verify:
`.claude/workflows/verify-bun-pi-agent-cli.js` — phases **Resolve → Build →
Smoke → Robust → Regression**. Resolve canonicalizes every path to absolute
form and mints a fresh `runDir`, so no agent depends on cwd or a hardcoded
worktree (mirrors the `pi-extension-obsidian-tool.js` resolve pattern). Build
produces the **dist bundle + external sourcemap**; all checks run the **dist
bundle** (`dist/bun-pi-agent-cli/cli.js`), not `src/cli.ts`. Regression runs
against the `fixture/2025.emnlp-main.893.pdf` baseline (16-page EMNLP paper;
`--pages 1-3`).

Run: `Workflow({ scriptPath: '.claude/workflows/verify-bun-pi-agent-cli.js', args: { regPages: '1-3' } })`.

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
| Smoke | ✅ 3/3 (offline-meta `Total: 53`; passthrough `PI-CLI-OK` via glm-5.2; distill 3 notes + MOC + wiki-links, via dist bundle) |
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

These are gemma-4-26b / LM-Studio **output-fidelity** characteristics surfaced
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

- **CLI-level unit + offline e2e tests.** `src/__tests__/` has 22 files, 332
  tests, all passing under plain `bun test`. Of those, `src/__tests__/e2e/` is a
  self-contained OFFLINE subprocess suite (see below) — no API keys or LM Studio
  needed. Live end-to-end verification (env keys, LM Studio) remains the
  responsibility of the dynamic workflow below.
- **Offline e2e suite (`src/__tests__/e2e/`, 44 tests).** Spawns the CLI in
  source mode (`bun src/cli.ts …`, hermetic env, `PI_SKIP_MODELS_JSON=1`) and
  asserts exit code + stdout/stderr at the process boundary. Covers the surface
  that short-circuits BEFORE any model call, so it needs no keys / LM Studio:
  version / help / list / list-tools / completions (meta), pipeline / workflow
  bogus + missing-name (dispatch errors), `--dpi` / numeric / `--source`
  validation with a **no-stack-trace** contract (arg-validation), and the `--`
  separator / oneshot alias / global-flags-before-command (misc). It also guards
  two fixes it surfaced: `help <meta-command>` no longer executes the target,
  and `--dpi` rejects fractional values. Model-dependent paths (chat / agent /
  passthrough / zk-* happy paths) are deliberately NOT covered — they belong to
  the live workflow. Run: `bun test src/__tests__/e2e/`.
- **`bun test` does not typecheck.** Run `bunx tsc --noEmit` from this package
  to catch type regressions. NOTE: this package's `tsconfig.json` has no
  `include`/`paths`, and Bun workspace symlinks resolve `@repo/*` deps to SOURCE
  (not built dist), so `tsc --noEmit` follows into sibling packages and currently
  reports ~470 errors — ~448 transitive (`pi-agent-ext-obsidian` / `-web-access` /
  `-ltx` / `-movie-director` / `-knowledge-card` / …) + ~23 pre-existing in this
  package's own commands/tests (none in `cli.ts` / `args.ts` / `sessions/`). The
  earlier "fully clean (0 errors)" note (2026-06-27) is STALE — the transitive
  packages have since drifted. The real CI gate is `bun test` (green); `tsc` is
  a stricter, monorepo-wide concern. The files touched by the e2e/help/dpi work
  are type-clean.
- **`--` end-of-options separator.** A bare `--` disables flag-parsing for the
  rest of argv, so extension sub-commands can pass their own flags through
  verbatim (`flux2 -- t2i --prompt "..."`) and passthrough prompts can include
  leading-dash operands (`-- "-5 degrees"`).
- **Live tests depend on external state** (env keys, LM Studio) — not hermetic.
