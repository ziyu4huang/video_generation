# 04 — Big-effort planning scope: wayfinder vs writing-plans

---
type: grilling
blocked by:
status: closed
claimed: pi-session (2026-07-21)
---

## Question

`wayfinder` (wayfind) and `writing-plans` (superpowers) both "plan work," at
different scales:

- `wayfinder` — "a huge chunk of work — more than one agent session can hold —
  whose route is still foggy"; produces a decision-ticket map.
- `writing-plans` — "a spec or requirements for a multi-step task, before
  touching code."

What's the scope threshold that picks one? Is the current distinction crisp
enough that the agent never waffles between "is this foggy enough to wayfind,
or clear enough to just write a plan?" — or is there a murky middle where both
fire? Decide the boundary rule (a one-line test the agent can apply), and
confirm the two don't need to merge.

This is a this-repo distinction (upstream has `writing-plans` but no
`wayfinder`), so it does not depend on ticket 01.

## Resolution

**The discriminator is fog (plan-writability), not size.** The one-line test
the agent applies: *"Can I write a plan right now from what's already settled?"*

- **Yes** (spec/requirements in hand, route clear) → `writing-plans`, at *any*
  size. Huge+clear is handled by `brainstorming`'s sub-project decomposition
  (split into independent sub-projects, each its own spec→plan→implementation).
- **No** (decisions still open, route foggy) → `wayfinder` if the effort is also
  huge / multi-session; `grilling` if small.

Three settled conclusions:

1. **No murky middle.** All three cells are covered: huge+foggy → `wayfinder`;
  small+foggy → `grilling`; any-size+clear → `writing-plans`. The case the
ticket worried about (huge+clear) is `writing-plans` territory via sub-project
decomposition — not a wayfinder trigger.

2. **No merge** — consistent with 02/03. `wayfinder` is the decide-phase
  (resolve fog into decisions); `writing-plans` is the plan-phase (decompose a
  settled spec). Size is a *secondary* threshold that only chooses the
decide-tool's weight (`grilling` vs `wayfinder`) within the foggy branch.

3. **Encoding — sharpen this-repo-owned surfaces only.** `wayfinder`'s
  description currently bundles "huge AND foggy" without signalling that fog is
  the *primary* gate and `writing-plans` handles huge+clear. Sharpen
  `wayfinder`'s `description` to make plan-writability the explicit test, and
  add the routing note to the `using-superpowers` bootstrap ("if the route is
  foggy — no spec yet — defer to wayfind's grilling/wayfinder before
  writing-plans"). Do NOT fork upstream-verbatim `writing-plans`.

**Completes the main axis** — all three collision points (A spec authorship, B
decomposition, C big-effort scope) are now decided. The entry-path rule is
fully sharp end-to-end: fog-discriminator (04) → pipeline choice → spec
authorship (02) → decomposition (03). The "encoding the resolved boundary" fog
is now fully specifiable (all substance decided) and graduates into the
downstream execution effort's encoding step.
