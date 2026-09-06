# 02 — core-runtime write path + in-dialog create/edit/delete

## Done when
- core-runtime: `writeAgentDefinition(dir, def)` / `deleteAgentDefinition(dir, name)`
  — scope is a real dir (project `.pi/agents` / user `~/.pi/agents`), name
  validated (kebab-case, no collision with builtin/pack), frontmatter
  serialization round-trips (comma-separated `tools` string form preserved,
  ticket 14/decision 09), body = prompt. Round-trip unit tests.
- Dialog: `c` create (form: name/description/model/tier/tools/isolation →
  project scope default, `s` toggles user scope), `e` edit (preloads the
  selected project/user definition), `d` delete with explicit y/N confirm —
  builtin/pack rows render "view only" (c/e/d refused with a status line).
- Errors (invalid name, collision, fs failure) render inline, never throw
  (render-layer safety rule).
