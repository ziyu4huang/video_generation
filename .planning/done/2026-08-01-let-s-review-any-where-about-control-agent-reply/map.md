# Map — review reply-language control

## Destination

A complete audit of every site that controls the agent's reply/conversation
language (**narrow scope**), with current-state diagnosis and drift / propagation
findings — delivered as a resolved ticket. This effort does **not** decide or
build the enforcement mechanism; it hands the next effort a sharp target.

## Notes

- **Domain:** pi-agent reply-language control. Skills to consult: wayfinder
  (chart-the-map), grilling, domain-modeling.
- **This effort overrides the default "plan, don't do":** per the user's choice
  ("仍建地圖 + 單張 ticket 留痕"), execution — the audit itself — is carried into
  the map as a single research ticket. The map is the traceability layer; the
  ticket is the deliverable.
- **Standing preference:** conversation in 繁體中文; written artifacts in English.
- **Scope is NARROW:** reply-language control points only. The "written artifacts
  stay English" half of the policy, CLI/output i18n, and error-string
  localization are explicitly out of scope (see Out of scope).
- **Fact freshness:** charted on branch `video_generation__superpowers` (behind
  `origin/main`). The trailing commits are hermes-memory / watchdog work and do
  not touch language-control prose or the `getSystemPromptOptions` seam, so the
  audit facts hold.

## Decisions so far

- [Audit reply-language control sites](tickets/01-audit-reply-language-control-sites.md) — the rule is prose-only (`AGENTS.md` + `CLAUDE.md`), absent from `settings.json` and the `getSystemPromptOptions` seam. ⚠️ **Propagation claim corrected**: the rule *does* reach subagent/workflow sessions via the global `~/.pi/agent/AGENTS.md` context file (`resource-loader.js:86`); the real defect is **enforcement/priority**, not propagation (see ticket correction + follow-up map).

## Not yet specified

- The **enforcement mechanism** for the next effort is deliberately unspecified
  here — this map only audits. Graduated candidate destination: a first-class
  `responseLanguage` setting + forced injection via `getSystemPromptOptions` +
  propagation into subagent / workflow child sessions. Whether to build it
  in-repo vs upstream PR vs prose-consolidation is itself an open decision for
  that next effort.

## Out of scope

- **Written-artifact language policy** ("files stay English") — the other half
  of the current two-part rule. Audit in a separate effort if wanted.
- **CLI output / error-string / TUI-label localization (i18n)** — a different
  effort entirely.
- **Building any enforcement mechanism** — this effort is audit-only by user
  decision.
