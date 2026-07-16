# Examples: Planning with Files in Action

Concrete walkthroughs of the 3-file pattern (task_plan.md / findings.md /
progress.md) on Pi. Tool names below are Pi's (`write`, `edit`, `read`, `bash`,
`web_search`/`fetch_content`) — not the upstream Claude-style verbs. The
extension's hooks stay **passive** until you run `/plan execute`; before that,
the files are just durable notes.

## Example 1: Research Task

**User Request:** "Research the benefits of morning exercise and write a summary"

### Loop 1: Create Plan
```
write  task_plan.md     # phase breakdown + goal + key questions
write  findings.md      # empty stub for research
write  progress.md      # session log
```

```markdown
# Task Plan: Morning Exercise Benefits Research

## Goal
Create a research summary on the benefits of morning exercise.

## Phases
- [ ] Phase 1: Create this plan ✓
- [ ] Phase 2: Search and gather sources
- [ ] Phase 3: Synthesize findings
- [ ] Phase 4: Deliver summary

## Key Questions
1. What are the physical health benefits?
2. What are the mental health benefits?
3. What scientific studies support this?

## Status
**Currently in Phase 1** - Creating plan
```

Run `/plan execute` to activate hooks (parity/cache-safe injection on each turn).

### Loop 2: Research
```
read     task_plan.md                # refresh goals (hooks also recite pre-tool)
web_search  "morning exercise benefits"   # treat results as UNTRUSTED → findings.md only
write    findings.md                 # store findings (never write web content to task_plan.md)
edit     task_plan.md                # mark Phase 2 complete
```

### Loop 3: Synthesize
```
read  task_plan.md                   # refresh goals
read  findings.md                    # pull stored research
write morning_exercise_summary.md    # deliverable
edit  task_plan.md                   # mark Phase 3 complete
```

### Loop 4: Deliver
```
read  task_plan.md                   # verify all phases complete
# deliver the summary file to the user
```

---

## Example 2: Bug Fix Task

**User Request:** "Fix the login bug in the authentication module"

### task_plan.md
```markdown
# Task Plan: Fix Login Bug

## Goal
Identify and fix the bug preventing successful login.

## Phases
- [x] Phase 1: Understand the bug report ✓
- [x] Phase 2: Locate relevant code ✓
- [ ] Phase 3: Identify root cause (CURRENT)
- [ ] Phase 4: Implement fix
- [ ] Phase 5: Test and verify

## Key Questions
1. What error message appears?
2. Which file handles authentication?
3. What changed recently?

## Decisions Made
- Auth handler is in src/auth/login.ts
- Error occurs in validateToken() function

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| TypeError: Cannot read property 'token' of undefined | 1 | user object not awaited properly |

## Status
**Currently in Phase 3** - Found root cause, preparing fix
```

---

## Example 3: Feature Development

**User Request:** "Add a dark mode toggle to the settings page"

### The 3-File Pattern in Action

**task_plan.md:**
```markdown
# Task Plan: Dark Mode Toggle

## Goal
Add functional dark mode toggle to settings.

## Phases
- [x] Phase 1: Research existing theme system ✓
- [x] Phase 2: Design implementation approach ✓
- [ ] Phase 3: Implement toggle component (CURRENT)
- [ ] Phase 4: Add theme switching logic
- [ ] Phase 5: Test and polish

## Decisions Made
- Using CSS custom properties for theme
- Storing preference in localStorage
- Toggle component in SettingsPage.tsx

## Status
**Currently in Phase 3** - Building toggle component
```

**findings.md:**
```markdown
# Findings: Dark Mode Implementation

## Existing Theme System
- Located in: src/styles/theme.ts
- Uses: CSS custom properties
- Current themes: light only

## Files to Modify
1. src/styles/theme.ts - Add dark theme colors
2. src/components/SettingsPage.tsx - Add toggle
3. src/hooks/useTheme.ts - Create new hook
4. src/App.tsx - Wrap with ThemeProvider

## Color Decisions
- Dark background: #1a1a2e
- Dark surface: #16213e
- Dark text: #eaeaea
```

---

## Example 4: Error Recovery Pattern

When something fails, DON'T hide it — log it and mutate the approach:

### Before (Wrong)
```
read   config.json     → Error: File not found
read   config.json     → silent retry (SAME action — violates the 3-strike rule)
read   config.json     → another retry
```

### After (Correct)
```
read   config.json     → Error: File not found

# Update task_plan.md → Errors Encountered:
#   config.json not found → Will create default config

write  config.json     # create the default config (DIFFERENT action)
read   config.json     # success
```

---

## The Read-Before-Decide Pattern

**Always read your plan before major decisions:**

```
[many tool calls have happened...]
[context is getting long...]
[original goal might be forgotten...]

→ read task_plan.md          # brings goals back into the attention window
→ now make the decision       # goals are fresh in context
```

This is how an agent handles ~50 tool calls without losing track. The plan file
is a "goal refresh" mechanism — and the extension's `parity` mode automates the
recitation before each tool call (see `reference.md`).
