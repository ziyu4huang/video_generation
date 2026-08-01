## Question

Does `/response-language` formally join core-task's ubiquitous language (broaden `CONTEXT.md` to name reply-language / locale control), or does it sit as an adjacent self-contained command with only a one-line note — following the `ask-user` "entry-point consolidation" precedent?

type: grilling
status: closed
claimed: agent:main-session
blocked by: _(none)_

## Notes for the resolver

core-task's `CONTEXT.md` domain today is the **task-execution cockpit** (goal / todo / ask-user / loop). Reply-language shares none of the shared widget / hooks / plan-coordination infrastructure — like `ask-user`, it would be a self-contained command merged for entry-point consolidation. The framing choice decides whether `CONTEXT.md` gains a new term, or core-task's stated scope quietly broadens to "task cockpit + lightweight session-config commands." One-question grill via `grilling` + `domain-modeling`. Recommended lean: follow the `ask_user_question` precedent (note, don't rename the domain) — but confirm with the user.

## Resolution

**Follow the `ask_user_question` precedent.** When the command moves into core-task (ticket 05), edit `CONTEXT.md` to:

1. Add a relocation note to the opening paragraph, mirroring the `ask_user_question` wording — e.g. *"Also owns `/response-language` (relocated from its own `pi-agent-ext-response-language` package). It shares no code or state with goal/todo; relocated for core-task pi-ext consolidation, not because of a runtime coupling."*
2. Add a `## Language — response-language` subsection defining **`/response-language`** (shows/sets `responseLanguage` in `~/.pi/agent/settings.json`, triggers a prompt rebuild) and noting it pairs with the `force-response-language` patch in `pi-agent` (the injection half — out of scope to move).
3. Leave the core domain statement (*"the `/goal` objective driver and the `todo` step tracker ... task-execution cockpit"*) **unchanged** — response-language is a tenant command, not a redefinition of the domain.

Documentation decision only; no code-shape consequence beyond what [05-execute-migration](05-execute-migration.md) already captures.
