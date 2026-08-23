## Task 1 (ticket 01): schema + validation parity

**Files:**
- Modify: `bun-apps/s2-agent-ext-task/src/ask-user/tool/types.ts`
- Modify: `bun-apps/s2-agent-ext-task/src/ask-user/tool/validate-questionnaire.ts`
- Test: `bun-apps/s2-agent-ext-task/src/ask-user/__tests__/cc-parity-schema.test.ts` (new)

**Interfaces:**
- Produces: `MAX_HEADER_LENGTH = 12`, `RECOMMENDED_SUFFIX = " (Recommended)"`, `hasRecommendedSuffix(label): boolean`, error kind `"preview_on_multiselect"`; `recommended` field REMOVED from `OptionSchema`; label `maxLength` REMOVED. Tasks 2–3 consume `RECOMMENDED_SUFFIX` / `hasRecommendedSuffix`.

- [ ] **Step 1: Write the failing tests**

Create `src/ask-user/__tests__/cc-parity-schema.test.ts`:

```typescript
/** CC-parity schema — header 12, suffix-based recommended, preview single-select. */
import { test, expect, describe } from "bun:test";
import { validateQuestionnaire } from "../tool/validate-questionnaire.js";
import {
	MAX_HEADER_LENGTH,
	RECOMMENDED_SUFFIX,
	hasRecommendedSuffix,
	type QuestionParams,
} from "../tool/types.js";

function params(questions: unknown[]): QuestionParams {
	return { questions } as unknown as QuestionParams;
}

describe("CC parity schema", () => {
	test("header over 12 chars is rejected", () => {
		const r = validateQuestionnaire(
			params([{ question: "q?", header: "13-char header", options: [{ label: "a", description: "d" }, { label: "b", description: "d" }] }]),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("12");
	});

	test("header of exactly 12 chars passes", () => {
		const r = validateQuestionnaire(
			params([{ question: "q?", header: "12 characters", options: [{ label: "a", description: "d" }, { label: "b", description: "d" }] }]),
		);
		expect(r.ok).toBe(true);
	});

	test("label longer than 60 chars is accepted (no hard limit)", () => {
		const long = `${"word ".repeat(20)}end`;
		const r = validateQuestionnaire(
			params([{ question: "q?", header: "hdr", options: [{ label: long, description: "d" }, { label: "b", description: "d" }] }]),
		);
		expect(r.ok).toBe(true);
	});

	test("preview on a multiSelect question is rejected", () => {
		const r = validateQuestionnaire(
			params([{
				question: "q?", header: "hdr", multiSelect: true,
				options: [
					{ label: "a", description: "d", preview: "x" },
					{ label: "b", description: "d" },
				],
			}]),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("preview_on_multiselect");
	});

	test("preview on a single-select question still passes", () => {
		const r = validateQuestionnaire(
			params([{
				question: "q?", header: "hdr",
				options: [
					{ label: "a", description: "d", preview: "x" },
					{ label: "b", description: "d" },
				],
			}]),
		);
		expect(r.ok).toBe(true);
	});

	test("more than one (Recommended)-suffixed label is rejected", () => {
		const r = validateQuestionnaire(
			params([{
				question: "q?", header: "hdr",
				options: [
					{ label: `Alpha${RECOMMENDED_SUFFIX}`, description: "d" },
					{ label: `Beta${RECOMMENDED_SUFFIX}`, description: "d" },
				],
			}]),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("too_many_recommended");
	});

	test("hasRecommendedSuffix matches only the exact CC suffix", () => {
		expect(hasRecommendedSuffix(`A${RECOMMENDED_SUFFIX}`)).toBe(true);
		expect(hasRecommendedSuffix("A (recommended)")).toBe(false);
		expect(hasRecommendedSuffix("A (Recommended) ")).toBe(false);
		expect(hasRecommendedSuffix("A")).toBe(false);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/s2-agent-ext-task && bun test src/ask-user/__tests__/cc-parity-schema.test.ts )`
Expected: FAIL — `MAX_HEADER_LENGTH` is 16 (13-char header passes), `RECOMMENDED_SUFFIX`/`hasRecommendedSuffix` not exported, no `preview_on_multiselect` error.

- [ ] **Step 3: Implement schema changes**

In `tool/types.ts`:

1. `export const MAX_HEADER_LENGTH = 12;` (was 16). Update its two description strings that interpolate it — they stay correct automatically.
2. Delete `export const MAX_LABEL_LENGTH = 60;` and the `maxLength: MAX_LABEL_LENGTH` + hard-limit sentence from `OptionSchema.label`; new description: `"The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice."` (CC wording).
3. Add after `MAX_OPTIONS`:

```typescript
/** CC convention: the recommended option carries this label suffix and sits first. */
export const RECOMMENDED_SUFFIX = " (Recommended)";

export function hasRecommendedSuffix(label: string): boolean {
	return label.endsWith(RECOMMENDED_SUFFIX);
}
```

4. DELETE the whole `recommended` field from `OptionSchema`.
5. `preview` description → `"Optional preview content, rendered as markdown in a monospace box next to the options (side-by-side layout). Use for ASCII mockups of UI layouts or components, code snippets, diagrams, graphs, or configuration examples. Only supported for single-select questions."` (CC wording).
6. `QuestionSchema.header` description → `` `Very short label displayed as a chip/tag next to the question. Max ${MAX_HEADER_LENGTH} characters.` `` (examples line CC keeps: `Examples: "Auth method", "Library".`).
7. `QuestionSchema.multiSelect` description → `"Set to true to allow the user to select multiple options instead of just one. Use for questions where multiple answers are valid; phrase the question accordingly. Do not use for mutually exclusive choices."` (CC wording).
8. `QuestionnaireError` union: replace nothing, ADD `"preview_on_multiselect"`.

In `tool/validate-questionnaire.ts`:

1. Remove `MAX_LABEL_LENGTH` from the import; add `hasRecommendedSuffix`.
2. Replace the `recommendedCount` block:

```typescript
const recommendedCount = opts.filter((o) => hasRecommendedSuffix(o.label)).length;
if (recommendedCount > 1) {
	return {
		ok: false,
		message: `Error: question ${qi + 1} has ${recommendedCount} options labeled "(Recommended)" (at most one allowed).`,
		error: "too_many_recommended",
	};
}
```

3. Delete the `opt.label.length > MAX_LABEL_LENGTH` rejection block.
4. After the `MIN_OPTIONS/MAX_OPTIONS` check, add:

```typescript
if (q.multiSelect === true && opts.some((o) => typeof o.preview === "string" && o.preview.length > 0)) {
	return {
		ok: false,
		message: `Error: question ${qi + 1} is multiSelect but has a preview — previews are only supported for single-select questions.`,
		error: "preview_on_multiselect",
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/s2-agent-ext-task && bun test src/ask-user/__tests__/cc-parity-schema.test.ts )`
Expected: PASS (7 tests).

- [ ] **Step 5: Migrate existing tests that authored the old shapes**

`( cd bun-apps/s2-agent-ext-task && bun test src/ask-user 2>&1 | grep -E "^\(fail\)|fail.*test" | head -20 )` — fix each failure:
- Anywhere `recommended: true` was authored → replace with `label: "X (Recommended)"`.
- Anywhere a header of 13–16 chars was authored → shorten to ≤12.
- `config.test.ts` / `rpc-fallback.test.ts` / `cards-ux2-roundtrip.test.ts`: check for `recommended` or >12-char headers with `grep -rn "recommended\|header:" src/ask-user/__tests__/` and fix the same way.

Leave `recommended-marker.test.ts` for Task 3 (it tests the view layer this task just orphaned).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/s2-agent-ext-task/src/ask-user
git commit -m "feat(task): ask_user_question CC-parity schema — header 12, suffix recommended, preview single-select"
```

---

