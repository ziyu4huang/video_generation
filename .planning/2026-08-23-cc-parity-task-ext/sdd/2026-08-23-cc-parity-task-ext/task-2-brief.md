## Task 2 (ticket 01): tool description CC rewrite

**Files:**
- Modify: `bun-apps/s2-agent-ext-task/src/ask-user/ask-user-question.ts:86-100` (description + snippet/guidelines)
- Test: extend `src/ask-user/__tests__/cc-parity-schema.test.ts`

**Interfaces:**
- Consumes: `RECOMMENDED_SUFFIX` from Task 1.
- Produces: `DEFAULT_PROMPT_SNIPPET` / `DEFAULT_PROMPT_GUIDELINES` strings used by `registerAskUserQuestionTool`.

- [ ] **Step 1: Write the failing test**

Append to `cc-parity-schema.test.ts`:

```typescript
import { DEFAULT_PROMPT_SNIPPET, DEFAULT_PROMPT_GUIDELINES } from "../ask-user-question.js";

describe("CC-parity tool description", () => {
	test("guidelines teach the CC recommended convention and plan-mode rule", () => {
		const all = DEFAULT_PROMPT_GUIDELINES.join("\n");
		expect(all).toContain("(Recommended)");
		expect(all).toContain("first");
		expect(DEFAULT_PROMPT_GUIDELINES.some((g) => g.toLowerCase().includes("plan"))).toBe(true);
		expect(all).not.toContain("recommended: true");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/s2-agent-ext-task && bun test src/ask-user/__tests__/cc-parity-schema.test.ts )`
Expected: FAIL — current guidelines say `recommended: true` and mention no plan rule.

- [ ] **Step 3: Rewrite description, snippet, guidelines**

Replace the `description` string in `registerAskUserQuestionTool` with (CC structure, adapted plan-mode paragraph):

```
Ask the user 1-4 structured questions to clarify requirements or get decisions. Each question has a short header, 2-4 options (label + description), and the user can always type a custom answer or press Esc to abandon.

Usage notes:
- Users will always be able to type a custom answer ("Type something." row is appended automatically to every question). Do NOT author "Other" / "Type something." labels yourself — duplicates are rejected at runtime.
- If you recommend a specific option, add "(Recommended)" to the end of its label and place it first in the list. At most one per question.
- Use multiSelect: true ONLY when multiple answers are valid; phrase the question accordingly. Do not use it for mutually exclusive choices.
- Preview feature: use the optional `preview` field on options when presenting concrete artifacts the user needs to visually compare — mockups, code snippets, diagram variations, config examples. Previews render as markdown in a monospace box with a side-by-side layout, and are only supported for single-select questions.
- Clarify requirements BEFORE finalizing a plan; when a plan-approval flow exists, ask clarifying questions before presenting the plan, and never use this tool to ask "is the plan ready" — that is the plan-approval flow's job.
```

Replace the two constants:

```typescript
export const DEFAULT_PROMPT_SNIPPET = `Ask the user 1-4 structured questions (2-4 options each) when requirements are ambiguous or a decision is needed`;

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Use when ambiguous (up to ${MAX_QUESTIONS} questions, ${MIN_OPTIONS}-${MAX_OPTIONS} options each). Each option needs a concise label + description. User can type a custom answer or Esc to quit.`,
	"Mark your recommended option by suffixing its label with \"(Recommended)\" and placing it first — at most one per question. Never add any other recommended marker.",
	"multiSelect only when several answers are valid; preview only on single-select questions (markdown, monospace box, side-by-side).",
	"Batch all questions in one call (don't stack). In planning work, clarify BEFORE presenting a plan; never ask \"is the plan ready\" with this tool.",
];
```

- [ ] **Step 4: Run tests, then the full ask-user suite**

Run: `( cd bun-apps/s2-agent-ext-task && bun test src/ask-user )`
Expected: PASS except `recommended-marker.test.ts` (Task 3 migrates it).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-task/src/ask-user
git commit -m "feat(task): ask_user_question tool description rewritten to CC semantics"
```

---

