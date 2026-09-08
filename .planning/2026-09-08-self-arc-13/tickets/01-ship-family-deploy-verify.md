# Ticket 01 — Ship the family: pin deploy gap, deploy, verify bytes (T1)

Status: done · BLOCKER for t04/t05 deployed legs · no-choice first

## Problem

Planner F1 (measured 2026-09-08): the deployed tree
`~/proj/dist/s2-agent-sh/darwin-arm64/current/ext/ext-standalone.mjs` (mtime
2026-09-06 14:55) greps **0** for `arxiv_search` and `collect_videos`; the
per-ext listing under `current/ext/` shows 15 packages, no `research`. The
source registry DOES register the package (`bun-apps/s2-agent/src/registry-config.ts:535`,
`name: "s2-agent-ext-research-tool"`, entry `extensions/research-tool.ts`; the
manifest mentions it ×3; a comment at :129 groups it among "darwin-by-nature
ext"s). A user on the deployed leg cannot USE the family at all.

## Work

1. Pin the cause: `git log -S research-tool -- bun-apps/s2-agent/src/registry-config.ts`
   (when did it enter the registry, relative to the 2026-09-06 14:55 deploy?);
   read the entry's platform/load fields vs the crossos per-tree ext filtering
   (#2099 D5). Record the verdict in the effort map.
2. Deploy: `bun bun-apps/s2-agent-ext-devops/src/deploy-cli.ts`.
3. Verify BYTES not labels (learnings #1/#2): `grep -c arxiv_search` and
   `grep -c collect_videos` on the fresh `current/ext/ext-standalone.mjs` ≥ 1,
   `ls current/ext/ | grep research`.
4. Write `output/self-arc13-deploy-verify-<date>/receipt.json` with named checks
   `bundleHasResearchToolSymbols`, `extDirResearchPresent`,
   `versionLabelMatchesBytes` (deployed version label + on-disk bytes agree).

## Done when

Receipt PASSes all three named checks; root-cause verdict recorded in the map.
No production-code change expected (if the deploy STILL drops the package, the
filtering bug becomes an in-arc fix — escalate to the map immediately).
