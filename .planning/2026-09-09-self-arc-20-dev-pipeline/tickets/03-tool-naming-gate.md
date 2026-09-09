# Ticket 03 — tool-naming contract gate

## Goal

Turn the `extension-naming` SKILL.md convention (snake_case `verb_object` or
`ns_verb` tool names; `<tool>_help` companion; kebab-case skill dirs) into an
enforced workspace gate `bun-apps/tests/tool-naming-contract.test.ts`, wired
into CI the same way `test:seam`/`test:routing` are.

## Why

The convention is prose-only today; outliers are documented but nothing
fails when a new tool violates the convention or a `<tool>_help` companion
goes missing. A gate makes the naming structure an interface contract,
matching the seam/routing gate family.

## Constraints

- STATIC analysis only — no runtime import of any package (copy the
  seam/routing gates' approach: read source as text; ground assertions so a
  moved dir fails loud, not vacuous).
- NO wire renames (effort D5): the gate encodes the convention AND the
  documented outlier set as an explicit, commented baseline. Known outliers
  (bare nouns, pre-convention): `memory`, `browser`, `webui`, `file2md`,
  `flux2`, `krea2`, `ltx`, `movie`, `obsidian`, zk namespace tools, and
  zai-mcp's external dynamic tools (not ours — exempt with a comment).
  A NEW tool name not fitting the convention and not in the baseline fails
  the gate — that is the point.
- `<tool>_help` companion rule: check the pairing where mechanically
  checkable (grep the `<tool>_help` registrations) — do not over-engineer;
  if pairing cannot be derived statically, assert the known set and say so.
- Skill names: assert skill dir names are kebab-case across
  `bun-apps/s2-agent-ext-*/skills/` (cheap, mechanical).
- Wire-in: add a `test:tool-naming` script to `bun-apps/package.json` AND
  register the gate in the regression-gates job of
  `.github/workflows/ci.yml.disabled` so `run_local_ci` picks it up
  automatically (that file is disabled but is the runtime source for the
  gate list — see devops-workflow SKILL.md §2).
- NO git mutations. Do not run `bun install`.

## Steps

1. Read `bun-apps/tests/routing-contract.test.ts` + `seam-contract.test.ts`
   (style, grounding, comment discipline).
2. Read `bun-apps/s2-agent-ext-devops/skills/extension-naming/SKILL.md`
   fully (the convention + outlier history table).
3. Derive the tool-name inventory statically: read 2-3 exts to find the
   actual registration call shape (extensions/*.ts, src/tools/*); if tool
   names are only computable at runtime, use the `name:` fields /
   `<name>_help` string literals greppable in source — state the mechanism
   in the gate header.
4. Write the gate: kebab-case skill-dir check; tool-name convention check
   against baseline; `<tool>_help` presence for baseline tools that have
   companions.
5. Wire `test:tool-naming` into `bun-apps/package.json` + ci.yml.disabled
   regression-gates job (copy how test:routing is registered there).
6. Run: `cd bun-apps && bun test tests/tool-naming-contract.test.ts` green;
   `bun run test:routing` still green (you did not break the family).

## Acceptance

- New gate green on main's tree; a deliberate violation fails (verify by
  temporarily editing + reverting, or by unit-testing the classifier
  function directly in the gate file).
- `bun run test:tool-naming` exists and passes; ci.yml.disabled contains
  the gate step.
- Report: gate mechanism, baseline contents, any convention violations
  discovered that were NOT in the SKILL.md outlier list.
