---
type: task
blocking: 03, 04
status: closed
---

# 05 — Ship: fresh deploy + docs + effort close-out

## Question

Does the whole mechanism ship green on the real machine, and is the durable
record (docs, map status) in place?

## What to build

Run a fresh deploy on this machine (darwin-arm64) with the new shim +
AGENTS.md + `standalone-import` probe; verify the automatic post-deploy E2E
is green including the new probe; run `verify-deploy-e2e-cli` once
standalone as the post-hoc proof. Repo-side durable record: a short entry
in the devops-workflow SKILL.md's tool table (or its deploy row) pointing
to the dist `AGENTS.md` for standalone reuse, plus CLAUDE.md's DevOps
section one-liner if warranted — minimal, per the docs-minimalism policy.
Close the effort: map `status: complete`, tickets closed, version bump
(`version-bump-cli --package s2-agent --patch` — the shim entry is a
user-visible deploy-content change), PR via the devops chain
(`merge-pr-after-ci`), successor next-goal written.

## Acceptance

- [ ] Fresh deploy ships `ext/ext-standalone.cjs` + `AGENTS.md`; automatic
      post-deploy E2E green including `standalone-import` pass
- [ ] `verify-deploy-e2e-cli` standalone run green
- [ ] Measured shim bytes + cache behavior recorded in map Context
- [ ] Docs touch minimal and committed; s2-agent version bumped with the
      change; PR merged via the devops chain with local-CI gate
- [ ] Effort closed: map `status: complete`, successor next-goal written
      and `LATEST` repointed
