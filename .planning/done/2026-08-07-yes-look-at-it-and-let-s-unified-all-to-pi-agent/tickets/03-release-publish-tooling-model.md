---
type: grilling
status: closed
---

# 03 — Release/publish tooling model

## Question

All `pi-agent-ext-*` packages are `private: true` (never npm-published), so "release tooling" can't mean `npm publish`. What IS a release in this repo, and should devops own it? Candidate models: (a) git tags + GitHub Releases on `main` as milestone markers; (b) version-bump the `package.json` versions for traceability + a generated changelog; (c) artifact cuts — but note `pi-agent-ext-deploy`'s `pi_deploy` already builds bundle/snapshot/standalone/exe artifacts, so "release" may OVERLAP with (not duplicate) deploy's build concern. Pin the release model AND whether it lives in devops (gh/tag/release) vs deploy (artifact build) before building any tool. Relates to the keep-separate decision: gh/tag/release flavor → devops; artifact-build flavor → deploy.

## Resolution

**Decision: No release tooling. `main` + PRs suffices.** All pi-agent-ext-* packages are `private: true` and consumed as live source (Bun workspace + manifest) — no consumer ever reads a version, so a release (tag, version-bump, or artifact cut) adds ceremony with zero consumer benefit. Confirms keep-separate: deploy owns artifact builds (pi_deploy); devops owns gh PR-ops; neither needs a release concept. Closed as not-needed; no tool to build. (If milestone/rollback markers become wanted later, reopen and consider git tags + GitHub Releases — the lightweight option, not version bumps or artifacts.)
