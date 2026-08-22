# Spec — portable Bun scripts: skill-embedded tools + tier launchers

> STATUS: drafted 2026-08-23. Design approved by the user the same day ("Approve design as presented",
> with scope A+B / rename-everywhere / golden-fixture A/B decisions). Every runtime claim in §2 was
> measured on this machine on this date; file:line references are from the worktree at `b69d3e3d`.

## §1 Goal

Every **skill-facing** bash script in `bun-apps/s2-agent-ext-*` and the **test-tier launchers**
becomes a portable Bun script (`bun <name>.ts`), with behavior proven by an A/B against the
old bash implementation and pinned permanently by golden-fixture parity tests. Bash stays only
where it is load-bearing or by-design (wizard template, bootstraps, s2-agent core — see D6/D7).

1. **Skill-embedded tools** (class A): `dedup.sh`, `smoke.sh`, `find-polluter.sh`,
   `hitl-loop.template.sh`, `smoke-e2e.sh`, `update-superpowers.sh` → sibling `.ts` twins, old
   `.sh` deleted on green.
2. **Tier launchers** (class B): 13× `run-test.sh` + `scripts/ci-local.sh` → `.ts`,
   **renamed everywhere** — every site that names the old path (probe, argv builder, tests,
   docs, hints) updated.
3. **Portability proof**: each conversion ships a normalized golden-parity test (stdout +
   exit codes pinned from the old bash run); B-class additionally proven at integration level
   (deploy probe E2E + `verify_pi_agent_deploy` tier run + `ci-workflow-references` guard).
4. **Documentation**: the 7 SKILL.md docs that reference `.sh` updated so no *active* skill
   names a bash path; deliberate exceptions documented in the skill docs and in this effort.

**Non-goals** (explicit): s2-agent core (`run.sh`, 4× `scripts/run-*-e2e.sh` incl.
`run-self-improve-loop.sh`, `update-pi.sh`, root `s2-agent.sh`); root bootstraps (`setup*.sh`, embed-mlx-server service); external
`dsh-plugin/sv-analyzer/build.sh` (cargo+zig, not Bun); `wizard/template.sh` (human-run
artifact — D6). No generic sh→ts transpiler (heterogeneous scripts; YAGNI).

## §2 Background (measured, not quoted)

Measured 2026-08-23 on this machine, detached worktree `video_generation__dsh` at `b69d3e3d`
(= origin/main tip, `rev-list HEAD..origin/main` = 0).

- **Inventory**: `git ls-files 'bun-apps/**/*.sh'` (excl node_modules) → **27 files**, three classes.
  - **A — skill-embedded tools + package updater (6)**:
    - `s2-agent-ext-hermes-memory/skills/pi-memory-bulk-dedup/dedup.sh` — **299 lines**;
      destructive dedup of pi memory targets (DB rows + `.md` §-entries); flags
      `--target|--db|--commit|--prune-stubs|--keep-backups|--prefix-len|--stub-maxlen`;
      `bash dedup.sh --help` is its SKILL.md's reference surface.
    - `s2-agent-ext-power-tool/skills/playwright-cli/scripts/smoke.sh` — doc: `bash skills/playwright-cli/scripts/smoke.sh`.
    - `s2-agent-ext-superpowers/skills/systematic-debugging/find-polluter.sh` — doc: helper.
    - `s2-agent-ext-superpowers/skills/systematic-debugging/scripts/hitl-loop.template.sh` —
      doc SKILL.md:269: the loop stays structured via this template; it is **copied, not run**.
    - `s2-agent-ext-ultracode/samples/smoke-e2e.sh` — sample.
    - `s2-agent-ext-wayfind/skills/wizard/template.sh` — **D6 exception, stays bash**.
    - `s2-agent-ext-superpowers/scripts/update-superpowers.sh` — 40 lines, package maintenance.
  - **B — tier launchers (14)**:
    - `s2-agent-ext-devops/scripts/run-test.sh` (~250 lines): tiers quick/medium/smoke/full
      (monotonic), `--list` tier table, `--list-siblings` **machine-readable** (consumed by
      `bun-apps/tests/ci-workflow-references.test.ts` — no other executor exists), `step()` prints
      `✓ <name>  (Ns)` / `✗ <name>  (Ns)` summary lines, per-run log at
      `/tmp/s2-agent-runtest.log`, exit 0/1 overall, exit 2 unknown effort. Sibling packages
      (`s2-agent-ext-obsidian|knowledge-card|file2md`) run via canonical `bun run test`.
    - `s2-agent-ext-devops/scripts/ci-local.sh` — **449 lines**; executes the workflow matrix
      (referenced from `local-ci-cli.ts:7`, `ci-matrix.ts:18`, `ci-gates.ts:16`).
    - **12 per-package `run-test.sh`** (btw, file2md, flux2, hermes-memory, knowledge-card,
      krea2, ltx, movie-director, obsidian, power-tool, research-tool, task): near-identical
      mechanical wrappers (`tier parse → bun test`, same `step()` shape, `--list`).
  - **C — s2-agent core (6)** — deferred by decision D7: `bun-apps/s2-agent/run.sh`,
    `scripts/run-ext-e2e.sh`, `scripts/run-image-agent-e2e.sh`, `scripts/run-self-improve-loop.sh`,
    `scripts/run-sh-agent-e2e.sh`, `update-pi.sh`.
- **Call sites that name `run-test.sh` (rename-everywhere list, grep-verified)**:
  `s2-agent-ext-devops/src/deploy-run.ts:34` (`existsSync(join(pkg,"scripts","run-test.sh"))` — a
  deploy **probe**; a missing file aborts deploy), `verify-tool.ts:2-3` (builds `./run-test.sh <tier>`
  argv, parses step summary), `deploy-argv.ts:5,19` (argv tail + comment), `s2-agent/src/__tests__/e2e-harness.ts:11`
  (PI_AGENT_E2E contract), `s2-agent/src/doctor.ts:493` (hint text `./run-test.sh medium`),
  `s2-agent/src/__tests__/e2e-launcher.test.ts:20` (comment), `bun-apps/tests/ci-workflow-references.test.ts`
  (shells out to `--list-siblings`), `ci-matrix.ts:18` / `ci-gates.ts:16` / `local-ci-cli.ts:7` (comments),
  devops-workflow SKILL.md (tier table + ci-local.sh + historical `scripts/sync-repo.sh`).
- **Docs referencing `.sh`**: 7 SKILL.md files — devops-workflow, pi-memory-bulk-dedup
  (incl. frontmatter description "Ships with dedup.sh"), s2-agent-model-catalog-update (external
  `dsh-plugin/sv-analyzer/build.sh` — D6 exception), playwright-cli, systematic-debugging,
  librarian, wizard.
- **Precedent (this session)**: `list-ext-skills.sh → list-ext-skills.ts` converted with an
  A/B — per-mode diff parity (`skills`/`cli`/`scripts` identical; block-scalar descriptions now
  full text instead of the old awk's first line), exit-code parity (0/1/2), same-dir twin
  deletion of the `.sh`, SKILL.md refs updated. That pattern is the unit of conversion here.

## §3 Decisions

- **D1 — Scope: classes A+B; s2-agent core deferred.** Skill-facing scripts are where portable-Bun
  pays off (agent consumption; the list-ext-skills precedent); `run.sh` is the product entry that
  `./s2-agent.sh` boots — converting it needs its own design + deployed-dist A/B. User-confirmed.
- **D2 — B-class: rename everywhere, never shim.** User chose the clean end state over filename
  shims; every name consumer is call-site-updated and proven by deploy-probe E2E + verify tool.
  A shim would leave a second entry contract alive forever.
- **D3 — A/B = transient byte-diff while both alive + committed golden-parity tests.** The old
  `.sh` runs against fixtures; stdout+exit codes captured and *normalized* (strip `\033[*m`,
  strip `(Ns)` elapsed, normalize `/tmp/*-runtest.log` and inline package names); the new `.ts`
  must byte-match after normalization; the same expectations are then committed as a permanent
  parity test in the owning package (provenance comment: `captured from <name>.sh@<sha>`).
  Transient A/B alone degrades to session trust; user asked "A/B test ensure it works".
- **D4 — Conversion unit: same-directory `name.ts` twin, exact contract.** Same flags, argv,
  stdout shape (ANSI colors included), exit codes 0/1/2; consumers (verify-tool step-summary
  parse, doctor hint, `--list-siblings` guard test) pin those shapes.
- **D5 — `dedup.sh` internals may switch `sqlite3` CLI → `bun:sqlite`** (built-in, zero deps);
  the *output* is the contract and the golden pins it, not the DB access method.
- **D6 — By-design bash stays**: `wizard/template.sh` (human-run artifact; cross-platform incl.
  WSL; Bun not guaranteed on the human's machine; "library above STAGES marker identical" is the
  wizard's consistency contract), root bootstraps (`setup*.sh`, embed service — Bun may not exist
  yet when they run), external `dsh-plugin/sv-analyzer/build.sh` (cargo+zig, not Bun).
- **D7 — s2-agent core files** (`run.sh`, 4× run-*-e2e.sh, `update-pi.sh`, root `s2-agent.sh`):
  stays bash this effort; candidate for a future dedicated effort.
- **D8 — Artifacts**: `.planning/2026-08-23-portable-bun-scripts/` effort folder; one ticket per
  wave (01 A-class, 02 rest-of-A + docs, 03 B-class); each ticket is one PR through the devops chain.

## §4 Design

**Wave 1 — tracer (one hard case, full harness):** `dedup.sh` → `dedup.ts`.
1. Capture goldens while the `.sh` is alive: `--help`, `--dry-run` and `--commit` runs against a
   fixture (temp dir: crafted per-target `.md` with `§`-entries + a small DB with candidate rows),
   exit codes included. Destructive runs against **copies**.
2. Convert (same flags, same `§`-filter, `bun:sqlite` for DB by D5), keep stdout/exit contract.
3. A/B diff (normalized) — zero diff required; then delete `dedup.sh`; update its SKILL.md
   (body refs + frontmatter description) and the `DEDUP=…` path.
4. Commit parity test in `s2-agent-ext-hermes-memory` (fixture-based, DB + `.md` in tmpdirs).

**Wave 2 — rest of class A + docs:** `smoke.sh`, `find-polluter.sh`, `hitl-loop.template.sh`
(copy-template; golden = structural, the `STAGES`-marker shape and helpers, not execution),
`ultracode/samples/smoke-e2e.sh`, `update-superpowers.sh`; SKILL.md updates across the 7 docs;
`wizard/template.sh` gets its exception documented in its SKILL.md (stays bash by design D6).

**Wave 3 — class B, rename everywhere:**
1. Port `scripts/run-test.sh` + `ci-local.sh` + 12 per-package `run-test.sh` to `.ts` (one shape
   for the 12; keep `--list`, `--list-siblings`, `--effort=`, extra-flag forwarding, log path,
   step summary line format, exit codes).
2. Rename everywhere: the §2 call-site list (deploy-run probe, verify-tool argv+parse,
   deploy-argv, e2e-harness + e2e-launcher comments, doctor.ts hint, ci-matrix/ci-gates/local-ci
   comments, `ci-workflow-references.test.ts` shell-out, devops-workflow SKILL.md).
3. Goldens: `--list` + `--list-siblings` output captured from old (normalized); parity test
   asserts the `.ts` reproduces them and exit codes (unknown tier → 2).
4. Integration A/B: local CI via devops chain green; deploy E2E `verify-deploy-e2e-cli` (exercises
   the run-test.ts probe); `verify_pi_agent_deploy` tier run (exercises argv + summary parse).

**Remaining bash surface after all waves** (expected): `wizard/template.sh`, s2-agent core
(wave-3 files deferred), root bootstraps, external build.sh — all documented exceptions.

## §5 Testing

- Per conversion: owning package canonical `bun run test` + tsc/check gates (per CLAUDE.md gate
  rules), plus the new parity test (golden fixtures, normalized expectations).
- Wave 3 additionally: `bun-apps/tests/ci-workflow-references.test.ts` (already shells out —
  renamed target must stay the only executor), deploy E2E suite, and the full local-CI matrix via
  the devops chain (`local-ci-cli` gate resolution may itself reference the renamed scripts).
- Reviewer subagent (independent, per CLAUDE.md the real quality gate) on each wave-PR; devops
  chain end-to-end (prepare → local-ci → PR → merge → verify-merge).

## §6 Gate

- [ ] Wave 1–3 PRs merged via the devops chain, each with verify verdict CLEAN.
- [ ] `grep -rn '\.sh' bun-apps/s2-agent-ext-*/skills/*/SKILL.md` names only documented
      exceptions (wizard template, external build.sh) or historical notes.
- [ ] `git ls-files 'bun-apps/**/*.sh'` = wizard template + s2-agent core set (deferred) only.
- [ ] All parity tests green on main post-merge; deploy E2E pass post-deploy.
