# 01 — Audit reply-language control sites

type: research
claimed: claude (chart-the-map session, 2026-08-01)
closed: 2026-08-01

## Question

Audit every site that controls what language the agent converses/replies in
(**narrow scope: reply-language control points only**). Deliver:

1. a complete inventory (the "list them all"),
2. a current-state diagnosis per site — is each site *enforced prose* or *forced*?
3. drift risk, and
4. where the rule silently fails to propagate.

This effort is audit-only; it does **not** decide or build an enforcement mechanism.

## Resolution

Scope re-confirmed (user decision): **reply-language control points only**.
The "written artifacts stay English" half of the policy, CLI/output i18n, and
error-string localization are out of scope (see map → Out of scope).

### Inventory — all control sites

| #  | Site | Layer | Mechanism | Status |
|----|------|-------|-----------|--------|
| 1  | `~/.pi/agent/AGENTS.md` — "Default conversation language" | Global user instructions | Prose injected into the **main** session system prompt | Prose, drift-able |
| 2  | `./CLAUDE.md` — "Conversation language: 繁體中文" | Per-project instructions | Prose injected into the **main** session system prompt | Prose, drift-able |
| 3  | `~/.pi/agent/settings.json` | Global config | **No** `responseLanguage` / `locale` key exists | Gap — absent |
| 4  | `getSystemPromptOptions()` seam — `bun-apps/pi-agent/src/patches/ext-context-get-system-prompt-options.ts` | pi-core injection point | Monkey-patched onto `ExtensionContext` (upstream 0.80.3 added it to command ctx only). The **only** place a FORCED system-prompt block could be wired today | Available, **unused** for language |
| 5a | Subagent dispatch — `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts:559` | Child-session system prompt | Composed from role-label (`"You are the ${agent}…"`) + `agentDef.prompt` **only** | Does **not** include AGENTS.md / CLAUDE.md |
| 5b | Workflow agents — `bun-apps/pi-agent-ext-workflow/src/workflow-tool.ts:350` (`{ systemPrompt: base + "\n\n" + block }`) | Child-session system prompt | `base` = workflow runtime base; `block` = per-agent. Neither carries the rule | Does **not** include the language rule |
| 5c | hermes-memory prompt-context — `bun-apps/pi-agent-ext-hermes-memory/src/prompt-context.ts:35` | Memory block in main session | `formatForSystemPrompt()` injects **memory content** only | No language rule (runs inside main session, so the main rule still covers the main agent) |

### Diagnosis

- The reply-language rule is **prose-only**, present in the **main session** via
  two files (1, 2), and **completely absent** from the one place that could make
  it "official / forced" (3 — settings.json key) and the one seam that could
  inject it (4 — `getSystemPromptOptions`).
- **Nothing is "forced" today.** Even the main-session prose is drift-able —
  enforcement relies entirely on model compliance.
- **The rule does not propagate.** The moment work fans out to subagents (5a) or
  workflow agents (5b), those child sessions run **without the rule** and default
  to the model's default (English). This is the silent, guaranteed failure — not
  drift, but absence. Experienced as "subagent / workflow replies come back in
  English."

### Drift / failure risk per site

- Sites 1, 2 (prose): **HIGH** — compliance-dependent, no enforcement.
- Site 3 (gap): the missing key is *why* no forced mechanism can exist today.
- Sites 5a, 5b (propagation): **GUARANTEED failure** — a rule the child never
  receives cannot be obeyed.

### Target state (graduated — for the NEXT effort, not this one)

A first-class `responseLanguage` setting in `settings.json` (global default +
per-project override) that pi-agent injects as a **forced** system-prompt block
via the `getSystemPromptOptions()` seam, **and** propagates into the subagent
instructions composition (`subagent-tool.ts:559`) and the workflow agent base
(`workflow-tool.ts:350`) so the rule holds across fan-out. Sites 1–2 then retire
as the *load-bearing* control (they may remain as human-readable docs).

## Correction (2026-08-01 — superseded by the follow-up map's research ticket)

The propagation claim above (rows 5a/5b, the Diagnosis, and the "GUARANTEED
failure" risk) is **wrong** and is retracted. It conflated the subagent's
`--append-system-prompt` argument (role-label + `agentDef.prompt`, composed at
`subagent-tool.ts:559`) with the **total** system prompt.

The accurate finding (verified in `resource-loader.js`):

- `loadProjectContextFiles()` loads the **global** context file from
  `resolvedAgentDir` (= `~/.pi/agent/`) for **every** session (line 86), and the
  subagent subprocess passes **no** `--agent-dir` (`buildSubagentArgs`), so it
  uses the default `~/.pi/agent/` and **does** load `~/.pi/agent/AGENTS.md`.
- Therefore the language rule **is present** in subagent / workflow / child
  sessions — as a **context file** fed into `buildSystemPrompt()`.

So the real defect is **not propagation** (that already works via the global
`AGENTS.md`) but **enforcement / priority**: the rule sits as a low-priority,
drift-able context file that loses to the strong role-label append
("You are the implementer…") and the model's English default. The follow-up map
reframes the destination accordingly: **elevate** the rule to a forced,
high-priority injection — not propagate it.

Sites 1–4 of this audit stand unchanged.

---

**Assets:** none created beyond this ticket and the map.
