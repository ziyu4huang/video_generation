# 01 — Panel content + element→function mapping

## Question

When the selector panel opens (triggered per [02](02-trigger-mechanism.md)), **what does it list, and what does selecting each element do?** This is the feature's value — without it the panel is just a passive list.

### Sub-questions to resolve (grill)

1. **Interaction model** — one of:
   - **Flat-trigger:** list goal / todo / wayfind; select one → immediately runs its action.
   - **Detail-expand:** select one → expands that element's detail inline (read-only drill-down; no action run).
   - **Sub-action menu:** select one → opens its sub-actions (e.g. wayfind → {status, validate, next-ticket}; todo → {list, toggle}; goal → {show, edit}).
2. **Per-element actions** (if flat-trigger / sub-action): concretely, what command/function does each map to? Candidates:
   - **wayfind** → `/wayfind status` (effort manifest + frontier), or `/wayfind validate`, or open the active effort's map.
   - **todo** → open the todo list / pick a task / toggle.
   - **goal** → show the active `/goal` (read-only), or edit it.
3. **Empty/absent elements** — if there's no active effort (no wayfind section) or no goal, does the element show greyed-out, hide, or offer a "start one" action?

## Notes

- The composite widget already has the sections (goal/todo/wayfind/plan-coordinator); the panel can render them as a selectable list sourced from the same `StatusSection` data.
- Reuse `ui.select()` or a `ui.custom()` `ExtensionSelectorComponent` for the panel — no new component machinery needed.

type: grilling
blocked by: (none — independent of 02)

---

## Resolution (2026-08-07)

**Decided:**
- **Interaction model:** flat-trigger — selecting an element immediately runs its command (no detail-expand, no sub-action menu).
- **Per-element actions:** `goal → /goal`, `todo → /todos`, `wayfind → /wayfind status`.
- **Empty/absent elements:** **hidden** (not greyed; no "start one" affordance).
- **`plan-coordinator`:** excluded from this build (trivial to add later).

Inherited from PR #1019's `presence.ts` design. Closed — recorded in `spec.md`.
