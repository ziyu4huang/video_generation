# Spec — slash-surface consistency

Scope decision: D2 in map.md (user multi-select, 2026-08-29). Non-goals:
reimplementing `/autocompact` (done, #2144, lives in s2-agent-ext-power-tool
and is available in the `./s2-agent.sh` TUI — D1); renaming upstream
wayfind/superpowers skill names wholesale (upstream-sync families keep their
names by design; only OUR repo-owned surfaces change).

## 01-compact-collision

Measure which `/compact` (pi 0.84.4 builtin vs s2-agent-ext-compact's
registered command) answers in the TUI command registry, and whether the
extension's CC-style semantics still hold after 0.84.3's compaction-routing
changes. Then EITHER rename the extension's command (e.g. `/compact-cc`) OR
document + test that it deliberately shadows the builtin. Acceptance: a
measurement receipt (which command wins, where in the registry), the chosen
naming recorded as a map decision, and a regression test pinning the outcome.

## 02-pi-residue-rename

Rename the skill dir `pi-memory-bulk-dedup` → `memory-bulk-dedup`
(hermes-memory) and fix `grill-memory`'s description ("pi memory" → s2-agent
wording). `research-pi-packages` gets an explicit keep/rename verdict: its
"pi" names the upstream Pi.dev ecosystem it researches — rename only if the
verdict says the ecosystem reference reads as residue. Acceptance: renamed
dirs re-registered (manifest regen), all references updated, package gates
green.

## 03-family-prefix-convention

One decision, two deliverables: (a) the convention (candidate: flat names
are the default; a prefix is added only when a bare name would collide or is
ambiguous in the TUI listing) written into the devops `extension-naming`
skill; (b) the devops family's stragglers resolved under it (either prefix
the 9 unprefixed ones or record why flat is right). Acceptance: the skill
doc carries the rule + one-line rationale; no devops skill violates it.

## 04-help-banner-adjudication

Decide which "pi" identity strings we own. Options: patch the `--help` face
through the patches seam (cost: one more patch to carry across bumps) vs
document-only (our own docs/quickstart own the naming story). Acceptance: a
map decision with the maintenance-cost rationale, plus the minimal
implementation if "patch" wins (banner + usage lines only).

## 05-doctor-family-doc

One doc surface enumerating the five diagnostic entry points (`s2-agent
doctor`, `ext doctor`, `cli doctor`, `session-doctor-cli.ts`,
`debug-s2-session` skill) with a "which one when" table. Lives in domain-docs
(CONTEXT.md / docs surface of s2-agent + devops). Acceptance: `bun run
test:adr`-clean, the table answers "which doctor do I run" in one glance.

## 06-tui-command-grouping

Check upstream first (pi-coding-agent 0.84.x skills.md / TUI command
registry) for existing grouping/listing support. If none: a manifest-driven
listing (e.g. a `/skills` command or grouped help) fed by
registry-config.ts data — no hand-maintained list. Acceptance: one command
answers "what can I invoke and what family is it in"; data source is
derived, freshness-gated.
