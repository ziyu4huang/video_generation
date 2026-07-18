# Pi Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "read a file"). On Pi these resolve to the tools below.

| Action skills request | Pi equivalent |
| --- | --- |
| Dispatch a subagent (`Subagent (general-purpose):` template) | Use the `subagent` tool provided by `pi-agent-ext-workflow` — `subagent({ task, model, tools, excludeTools, cwd })` |
| Task tracking ("create a todo", "mark complete") | Use an installed todo/task tool if available, otherwise track tasks in the plan or `TODO.md` |

## Subagents

Pi core does not ship a standard subagent tool. This repo's `pi-agent-ext-workflow` provides a `subagent` tool — a single-agent, isolated-context dispatch (`subagent({ task, model, tools, excludeTools, cwd })`) backed by `spawnSubagent()`. It covers SDD's implementer/reviewer dispatch; it does NOT provide chains/parallel/async/clarify in v1. If no `subagent` tool is available, do not fabricate `Task` calls; execute sequentially in the current session or explain that the subagent capability is not installed.

## Task lists

Pi core does not ship a standard task-list tool. If a todo/task extension is installed, use its documented tool. Otherwise use Superpowers plan files, checklists in Markdown, or a repo-local `TODO.md` for task tracking. Older Superpowers docs may refer to `TodoWrite`; treat that as the task-tracking action above.
