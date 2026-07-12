# Contributing

Welcome to `video_generation__cli` — a monorepo for MLX-native video generation
on Apple Silicon, plus its Bun-based GUI and pi-agent integration layer.

## Quick start

```bash
git clone https://github.com/ziyu4huang/video_generation.git
cd video_generation
bash scripts/setup.sh
```

See [`CLAUDE.md`](CLAUDE.md) for the full environment setup (Python venv,
sibling-fork deps, Bun workspace configuration).

## Issue → PR workflow

### The rule: one issue, one PR (1:1)

Every PR must solve exactly **one issue**. This keeps reviews focused, changelogs
clean, and rollbacks safe.

| Scenario | Pattern |
|----------|---------|
| Bug fix | File a bug issue first → PR links with `Fixes #N` |
| Feature | File a feature issue first → PR links with `Closes #N` |
| Large feature (multi-step) | One tracking issue (epic) → one PR **per sub-issue**; only the last PR writes `Closes #N`; earlier PRs write `Ref #N` |
| Typo / doc fix / CI-only | Direct PR is OK — describe the change in the body |

### Why

- **Traceability:** An issue explains *what* and *why*; a PR explains *how*.
  Together they form a searchable record.
- **Review quality:** A PR that touches three issues is too big to review well.
- **Automation:** GitHub auto-closes issues from PR descriptions (`Closes #N`).

### What goes in the PR description

```markdown
Closes #42    ← exact phrase, on its own line

A brief description of the change.
```

For multi-PR epics:

```markdown
Ref #100     ← keeps the tracking issue open

Part of the Z-Image v2 migration.
```

---

## Branch naming

```
fix/<short-description>      # bug fix
feat/<short-description>     # feature
refactor/<short-description> # refactoring
doc/<short-description>      # documentation
chore/<short-description>    # CI, tooling, maintenance
```

---

## Environment checklist

- Python venv: `python/venv/bin/python` (never system `python3`)
- Bun workspace: `bun install` from repo root
- Sibling-fork deps installed: `bash scripts/setup-repo-deps.sh`
- Apple Silicon MPS (no CUDA)
- All MLX dtypes: `bfloat16` native, `mlx-8bit` (default), or `mlx-4bit`

---

## Testing

### Before pushing

```bash
# All Bun packages (CI-safe subset — machine-coupled tests skip):
CI=true bun test --cwd bun-apps/pi-agent
CI=true bun test --cwd bun-apps/gui-movie-director
# … or iterate over all packages

# Full local test (includes machine-coupled tests):
( cd bun-apps/<package> && bun test )

# Python tests (MLX pipeline):
python/venv/bin/python -m pytest python/mlx-movie-director/app/tests

# Schema validation (GUI):
bun run --cwd bun-apps/gui-movie-director check:schema
```

### Portability + determinism gates

CI runs on `ubuntu-latest` (x86_64, no Apple Silicon, no Python/MLX stack). New
tests must:

1. **Be portable** — gate machine-coupled tests with `*.skipIf(process.env.CI)`
   or an env-var opt-in.
2. **Be deterministic** — mock time, isolate host-state writes via tmpdir, mock
   network calls. No real `fetch()` in portable tests.

Run the audits locally:

```bash
bash scripts/test-portability-audit.sh
bash scripts/test-determinism-audit.sh
```

See [`.github/CI.md`](.github/CI.md#test-author-portability-guide) and
[`.github/TEST-DETERMINISM.md`](.github/TEST-DETERMINISM.md) for the full guide.

---

## Code style

- **Python** follows `python/mlx-movie-director/app/` conventions (no style
  guide file yet — match the surrounding code).
- **TypeScript / Bun** uses biome (lint runs as part of `bun test` in most
  packages; the canonical project-wide format is not enforced in CI yet —
  match the file around you).
- **No `package-lock.json`** — Bun monorepo; use `bun.lock` only.
- **No top-level `cd`** in scripts — use subshells or `--cwd`/`-C` flags
  (enforced by `no-cd-drift.sh`).

---

## Vendor dependencies

The repo depends on two sibling forks (not on PyPI):

- `../mflux` — Z-Image / Flux pipeline
- `../ltx-2-mlx` — LTX video pipeline

**Never edit these submodules directly.** Patches live in
`python/mlx-movie-director/app/vendor_patches.py` — add a `_patch_*()` function
and register it in `apply_all_patches()`.

---

## Pull request checklist

Before opening a PR:

- [ ] CI passes (all required checks green)
- [ ] New tests added for changed behavior
- [ ] Documentation updated (at minimum `CLAUDE.md` if a subcommand or flag changes)
- [ ] Schema updated + `check:schema` passes (GUI-affecting changes)
- [ ] File-size guard passes: `bash scripts/ci-file-size-guard.sh`
- [ ] Commit messages are clear and in English

---

## Getting help

Open a [discussion](https://github.com/ziyu4huang/video_generation/discussions)
or ask in the relevant issue. For pi-agent skill / extension development, see
the per-package README in `bun-apps/`.
