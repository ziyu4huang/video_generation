# Reference: Manus Context Engineering Principles (Pi-native adaptation)

This skill is based on context engineering principles from Manus. This document
adapts them to Pi's runtime: where Manus relies on logit masking or a Python
sidecar, this port uses Pi's Layer-3 extension API (lifecycle events + injection
modes) and a pure-TypeScript attestation — no Python, no shell sidecar.

## The 6 Manus Principles

### Principle 1: Design Around KV-Cache

> "KV-cache hit rate is THE single most important metric for production AI agents."

**Why it matters here:** the extension's `cache-safe` mode exists precisely for
this. It injects a FIXED reminder string (stable prefix → cache-friendly) rather
than the dynamic plan recitation that `parity` mode uses. Choose `cache-safe`
when the provider bills cache misses heavily and the plan is simple; choose
`parity` when you need the full plan in attention at the cost of cache churn.

**Implementation (Pi):**
- `parity` mode: dynamic plan + progress block (re-recited each turn — breaks cache but maximizes attention).
- `cache-safe` mode: fixed reminder strings (stable prefix, KV-cache friendly).
- `notify` mode: status-bar only, zero prompt injection (maximum cache stability).
- Set via `PWF_MODE` env, `.pi/settings.json`, or `~/.pi/agent/settings.json`.

### Principle 2: Mask, Don't Remove → Inject, Don't Mutate

Manus avoids dynamically removing tools (breaks KV-cache) and uses logit masking
instead. Pi does not expose logit masking to extensions, so this port takes a
different route: it never removes or reorders tools. It ADDS context via
`before_agent_start` / `tool_call` message injection, leaving the tool set and
its ordering untouched. The plan context is wrapped in `===BEGIN PLAN DATA===` /
`===END PLAN DATA===` delimiters and tagged as data (see the Security Boundary
in `SKILL.md`).

### Principle 3: Filesystem as External Memory

> "Markdown is my 'working memory' on disk."

**The Formula:**
```
Context Window = RAM (volatile, limited)
Filesystem     = Disk (persistent, unlimited)

→ Anything important gets written to disk.
```

**Compression Must Be Restorable:**
- Keep URLs even if web content is dropped.
- Keep file paths when dropping document contents.
- Never lose the pointer to full data.

### Principle 4: Manipulate Attention Through Recitation

> Re-read `task_plan.md` before each decision to push the global plan into the
> model's recent attention span.

**Problem:** after ~50 tool calls, models forget original goals ("lost in the
middle").

**Solution (manual):** `read task_plan.md` before major decisions.

**Solution (automated):** in `parity` mode, the extension recites the plan
head + recent progress before each tracked tool call (`write`/`edit`/`bash`/
`read`), so the goal stays in the attention window without a manual read.

### Principle 5: Keep the Wrong Stuff In

> "Leave the wrong turns in the context."

- Failed actions with stack traces let the model implicitly update beliefs.
- Reduces mistake repetition.
- Error recovery is "one of the clearest signals of TRUE agentic behavior."

This is why the `## Errors Encountered` table in `task_plan.md` is required, not
optional — it persists the wrong turns to disk so they survive compaction.

### Principle 6: Don't Get Few-Shotted

> "Uniformity breeds fragility."

Repetitive action-observation pairs cause drift and hallucination. Introduce
controlled variation: vary phrasings, don't copy-paste patterns blindly,
recalibrate on repetitive tasks.

---

## The 3 Context Engineering Strategies

### Strategy 1: Context Reduction (compaction)

Pi's `session_before_compact` hook fires before context compaction. The
extension uses it to remind the agent to flush `progress.md` and `task_plan.md`
status BEFORE compaction completes — so the durable files capture what the
volatile context is about to lose. After compaction, `session_start` (reason
`resume`) re-surfaces the plan.

### Strategy 2: Context Isolation

Manus shifted from a single `todo.md` to a planner + executor sub-agents. On Pi,
the equivalent is parallel plans under `.planning/<slug>/` (see `SKILL.md`):
each isolated plan directory is a self-contained context boundary, and
`$PLAN_ID` pins a session to one plan.

### Strategy 3: Context Offloading

Store full results in filesystem, not context. Use `read`/`bash` (`grep`, `find`,
`ls`) for progressive disclosure — load information only as needed. The
`findings.md` file is the offload sink for research; `progress.md` for the
session log.

---

## The Agent Loop

```
1. ANALYZE CONTEXT   — understand intent, assess state, review observations
2. THINK             — should I update the plan? next action? blockers?
3. SELECT TOOL       — choose tool + assemble params
4. EXECUTE           — tool runs
5. OBSERVE           — result appended to context
6. ITERATE           — return to step 1 until complete
7. DELIVER           — send results + attach relevant files
```

The extension's `agent_end` hook checks plan completeness at step 7: if phases
remain, it can auto-continue (up to `AUTO_CONTINUE_LIMIT`) by sending a
follow-up that asks the agent to update `progress.md` and continue.

---

## File Types

| File | Purpose | When Created | When Updated |
|------|---------|--------------|--------------|
| `task_plan.md` | Phase tracking, progress, decisions | Task start | After each phase |
| `findings.md` | Discoveries, decisions, research | After ANY discovery | After viewing images/PDFs/web |
| `progress.md` | Session log, what's done | At breakpoints | Throughout session |
| Code files | Implementation | Before execution | After errors |

---

## Critical Constraints

- **Plan is required:** the agent must ALWAYS know goal, current phase, remaining phases.
- **Files are memory:** context = volatile, filesystem = persistent.
- **Never repeat failures:** `if action_failed: next_action != same_action`.
- **Parallel calls:** Pi supports parallel tool calls; the plan file (not a
  one-call-per-turn rule) is the coordination point. Parallel calls and
  sub-agents share state through the durable markdown plan on disk.
- **Attestation is opt-in:** run `/plan-attest` after finalizing the plan to
  SHA-256 lock it. A later silent edit fails the hash check and blocks
  injection with a `[PLAN TAMPERED]` warning (pure TS — no Python sidecar).

---

## Key Quotes

> "Context window = RAM (volatile, limited). Filesystem = Disk (persistent, unlimited). Anything important gets written to disk."

> "if action_failed: next_action != same_action. Track what you tried. Mutate the approach."

> "Error recovery is one of the clearest signals of TRUE agentic behavior."

> "KV-cache hit rate is the single most important metric for a production-stage AI agent."

> "Leave the wrong turns in the context."

---

## Source

Based on Manus's official context engineering documentation:
https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus

Adapted for Pi's Layer-3 extension API (pure TypeScript, no Python runtime).
