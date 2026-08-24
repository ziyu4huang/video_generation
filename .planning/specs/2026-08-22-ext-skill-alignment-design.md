# Ext-skill bridge + package layout alignment

Date: 2026-08-22
Status: approved design (brainstormed in-session)

## Destination

Every `bun-apps/s2-agent-ext-*` package shares one canonical folder shape,
enforced by a contract test with a shrinking allowlist; the claude-code bridge
skill discovers ext skills from the s2-agent registry via a bun script (no
bash), so the two views of "~50 reusable skills" cannot drift apart.

## Context

Measured 2026-08-22 on this machine (`ls` sweep over all 27 `s2-agent-ext-*`
packages):

- **Orphan**: `s2-agent-ext-workflow/` contains only `node_modules` — dead.
- **Test-dir drift**: `s2-agent-ext-task` uses `__tests__/` and keeps
  `run-test.sh` at package root (every other package: `tests/`,
  `scripts/run-test.sh` where applicable).
- **Missing CONTEXT.md** (domain-owned packages without one):
  `sv-analyzer`, `prompt-history`, `hyperframes` (8 skills), `webui` (1 skill).
- **Unique-but-legitimate dirs**: wayfind `procedures/`; superpowers pinned
  fixtures under `tests/__fixtures__/upstream-skills/` (byte-pin,
  ADR-superpowers-0004 — never edited).
- **Bridge parser bug (fixed in-session)**:
  `.claude/skills/using-s2-agent-skills/list-ext-skills.sh` awk could not read
  YAML folded/literal description blocks — 5 skills showed `<no description>`.
  Root cause is structural: bash grepping YAML instead of reading the registry.
- Bridge SKILL.md prose hardcodes facts that already needed verifying once
  (deploy entry move, s2-agent.sh location) — drift-prone by construction.

## Decisions

- **D1 — Both goals, one effort**: improve the bridge AND unify package layout
  together; the contract test is what makes each half protect the other.
- **D2 — bun over bash**: user preference, portability beyond macOS/zsh. All
  new tooling is TypeScript run via `bun` from repo root.
- **D3 — Contract test + allowlist**: enforcement lives in CI
  (`bun-apps/s2-agent/tests/ext-package-layout.test.ts`), not docs. Allowlist
  entries carry reasons and fail when stale so the list only shrinks.
- **D4 — Registry is the source of truth**: the bridge derives its skill list
  from `the registry YAML`, never from its own glob assumptions; a
  registered-but-undiscoverable skill fails CI.
- **D5 — Fix known drift inline**, not per-ticket (user decision): delete the
  orphan package, rename `task/__tests__/`, add missing CONTEXT.md files in
  this effort.

## Canonical package layout

```
bun-apps/s2-agent-ext-<name>/
├── extensions/<name>.ts      # ONE registered entry (existing rule)
├── src/index.ts              # lib face (required iff package.json main points there)
├── skills/<skill>/SKILL.md   # frontmatter name+description REQUIRED; name === dir name
├── scripts/                  # top-level files = runnable entries (.ts/.sh/.mjs); lib code in scripts/lib/
├── tests/                    # never __tests__/ (superpowers fixtures exempt — pinned content)
├── procedures/               # allowed asset dir alongside skills/ (wayfind precedent)
├── CONTEXT.md                # ubiquitous-language glossary
└── docs/adr/                 # when ADRs exist
```

Forbidden registration entries (existing scaffold rule, now asserted):
`src/index.ts` as entry, root `index.ts`, `extensions/index.ts`,
`extensions/pi-<name>.ts`.

## Workstreams

### W1 — Bridge rewrite (bun + registry)

- New `list-ext-skills.ts` next to the existing SKILL.md in
  `.claude/skills/using-s2-agent-skills/`. Modes: `skills | cli | scripts`,
  same tab-separated output shape as today (nothing downstream changes).
- `skills` mode: parse `the registry YAML` (YAML parse, not regex) →
  entries with `skills: true` → glob `<pkg>/skills/*/SKILL.md` → real YAML
  frontmatter parse for name/description (handles `>` and `|` blocks).
- `cli`: glob `src/*-cli.ts`. `scripts`: list `scripts/` minus `lib/`.
- Keep a 2-line `list-ext-skills.sh` shim exec'ing the bun script so existing
  references keep working during transition.
- Update the bridge SKILL.md: bun invocation, remove bash-only gotchas, drop
  hand-maintained claims replaced by derivation.

### W2 — Layout contract test

- `bun-apps/s2-agent/tests/ext-package-layout.test.ts` derives registered
  packages from the registry and asserts, per package:
  - exactly one `extensions/*.ts` whose basename matches folder name;
  - forbidden entries absent;
  - every `SKILL.md` has non-empty frontmatter `name`/`description`,
    `name` === directory name;
  - top-level `scripts/*` files look runnable (shebang or executable body
    heuristic — same spirit as devops' `scripts-dir-contract.test.ts`);
  - `tests/` exists when the package has tests at all; never `__tests__/`.
- `tests/ext-layout-allowlist.json`: `{ "<pkg>": { "<rule>": "reason" } }`.
  Stale-entry check: an allowlisted violation that passes the rule fails the
  test ("remove the exception").
- Cross-check (W1 tie-in): the set of skills the bridge reports must equal the
  set derived from the registry — asserted in the same test file or a sibling.

### W3 — Inline drift fixes

| Package | Change |
|---|---|
| `s2-agent-ext-workflow` | delete package dir + any registry/package.json references |
| `s2-agent-ext-task` | `__tests__/` → `tests/`; `run-test.sh` → `scripts/run-test.sh`; fix script paths in package.json |
| `sv-analyzer`, `prompt-history` | minimal `CONTEXT.md` glossary |
| `hyperframes`, `webui` | `CONTEXT.md` glossaries (domain-owned, 9 skills total); add `CONTEXT-MAP.md` entries together |
| scaffold (`ext new`) | emit compliant layout incl. `CONTEXT.md` stub |

CONTEXT.md files follow the house shape (one `**Term**:` per concept +
`_Avoid:_` lines; reference specimen `bun-apps/s2-agent-ext-wayfind/CONTEXT.md`)
and land with their `CONTEXT-MAP.md` entries in the same commit.

## Error handling / testing

- All gates run offline: `bun run --cwd bun-apps/s2-agent check && typecheck && test`
  plus per-touched-package canonical `bun run test`.
- The contract test itself gets a golden case: an intentionally broken fixture
  package under `tests/__fixtures__/` proving each rule fires.
- No network egress; no behavior change for s2-agent runtime — W1/W2 are
  tooling-side, W3 moves files within packages.

## Out of scope

- Editing superpowers skill bodies (byte-pin, ADR-superpowers-0004).
- Consolidating the deploy asset-resolution ladder (decision D3 there,
  documented 2026-08-21 — deferred).
- Renaming/moving `procedures/` or upstream-pinned fixtures.
