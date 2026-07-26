---
type: grilling
status: closed
claimed: superpowers-simplify-2026-07-26
resolved: 2026-07-26
---

# 04 — Decide the skill-content compression plan

## Question

Which skills get compressed, how aggressively, and is there a weight target?

Research (ticket 01) ranks the heaviest skills:
`writing-skills` (2589, 30% of all skill weight), `systematic-debugging` (1017),
`subagent-driven-development` (936), `test-driven-development` (619),
`brainstorming` (491) — together ~71% of skill weight.

The decisions to grill (one at a time):
1. **Target shape** — pure "cut all genuine redundancy" (qualitative), or a hard
   prompt-weight budget (e.g. "≤ N tok/req", "halve writing-skills")?
2. **Scope** — all five heavy skills, or just `writing-skills` first?
3. **Aggressiveness per skill** — behavior-preserving trim only, or allow
   restructuring/condensing the guidance as long as the capability survives?
4. **Divergence posture** — compress in-place (fork from upstream), or keep a
   diff/patch so upstream re-sync stays feasible?

Resolving this graduates the per-skill compression tactics currently in the
map's **Not yet specified**, and unblocks ticket 06 (fixtures).

## Resolution (2026-07-26)

Grilled three decisions; all settled.

1. **Scope** — **Pilot on `writing-skills` first.** Its ~2589 lines are ~30% of
   all skill weight (the whale). Prove the approach + measure the win before
   extending to the other four heavy skills. *Caveat discovered while grilling:*
   writing-skills' weight is almost entirely **on-demand** (SKILL.md 679 +
   `anthropic-best-practices.md` 1150 + support files); its **per-request** cost
   is just the 1-line description. The real per-request lever is the
   `using-superpowers` bootstrap (~1.3k tok injected every session: 62-line
   SKILL.md + piToolMapping/piBoundaryOverrides helpers) + whole-skill
   retirement (ticket 05). So this pilot optimizes **surface area /
   maintainability**, not baseline per-request weight.
2. **Aggressiveness** — **Medium, behavior-preserving.** Target the
   whale-within-the-whale `anthropic-best-practices.md` (1150 lines, 44% of
   writing-skills) for a redundancy trim, plus tighten SKILL.md (679). Keep the
   on-demand file structure; no guidance rewrites — capability must survive
   intact.
3. **Divergence posture** — **In-place fork.** writing-skills permanently
   diverges from upstream (a hundreds-of-lines trim is too big to live as a
   migration patch). The rebaseline toolchain is retained for the other skills.
   writing-skills is marked **intentionally forked** → it leaves the upstream
   fidelity-fixture set (this narrows ticket 06 to the *other* skills).

**Handoff:** pilot execution is now unblocked — compress
`anthropic-best-practices.md` + tighten `writing-skills/SKILL.md`, then drop
writing-skills from `tests/__fixtures__/upstream-skills/` + adjust
`skills-fidelity.test.ts`. Verify: `bun run check && bun run build && bun test`.

### Pilot result (2026-07-26) — behavior-preserving trim yields ~nil (net 0)

A subagent proposed an **8-line cut** to `anthropic-best-practices.md` (the
1150-line whale, 44% of writing-skills), claiming it restated existing prose.
**On pre-commit inspection the cut was reverted — it was NOT cleanly
behavior-preserving.** The removed "How agents access Skills" block carried,
alongside two genuinely-redundant points, the **unique access-model
explanation** (metadata pre-loaded → system prompt; files read on-demand) — i.e.
the very per-request mechanism this effort identified as the real lever — plus a
"use forward slashes" rule with no replacement elsewhere. A surgical keep-only-
redundant trim wasn't worth a structural tear; **net change: 0 lines.**

The lesson is the same, only sharper: the doc is **dense and interwoven**, not
padded — what reads like duplication is usually a deliberate contrast (the
GOOD/BAD "duplicate headings") or an explanation a nearby bullet depends on.
The prior compression sweep (`30773d5d`) already took the easy wins, and a
conservative subagent trim can't safely net anything on top of that.

Because nothing was edited (and no pinned `SKILL.md` was ever touched), the
Handoff's fixture drop was never triggered — ticket 06 resolved as **moot**.

➡️ **Implication for the optimization direction**: behavior-preserving
redundancy removal has effectively **nothing** left to give across the skills.
The real ROI levers are (a) **whole-skill retirement** (ticket 05 — resolves to
*nothing* under the strict bar), (b) the **always-injected `using-superpowers`
bootstrap** (~1.3k tok/session — the one per-request weight lever in skills),
or (c) **aggressive guidance rewrite** (a scope escalation beyond
"behavior-preserving"). Under the conservative posture the extension is already
lean; the audit's deliverable is that finding, not a line count.
