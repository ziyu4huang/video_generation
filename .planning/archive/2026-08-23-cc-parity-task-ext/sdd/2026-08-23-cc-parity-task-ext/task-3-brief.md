## Task 3 (ticket 01): view layer — suffix-driven ⭐ + preview monospace box

**Files:**
- Modify: `bun-apps/s2-agent-ext-task/src/ask-user/ask-user-question.ts` (`buildItemsForQuestion`)
- Modify: `bun-apps/s2-agent-ext-task/src/ask-user/view/components/wrapping-select.ts:160-170`
- Modify: `bun-apps/s2-agent-ext-task/src/ask-user/view/components/preview/preview-block-renderer.ts`
- Test: rewrite `src/ask-user/__tests__/recommended-marker.test.ts`

**Interfaces:**
- Consumes: `hasRecommendedSuffix`, `RECOMMENDED_SUFFIX` (Task 1).
- Produces: `buildItemsForQuestion` sets `recommended` from the label suffix; the answer string keeps the authored label (suffix included) — CC parity.

- [ ] **Step 1: Rewrite the failing tests**

Replace `recommended-marker.test.ts` content with:

```typescript
/**
 * recommended marker, CC convention — the model suffixes the label with
 * "(Recommended)"; the view renders ⭐ and strips the suffix from DISPLAY only.
 * The stored label (and therefore the answer string) keeps the suffix, matching
 * Claude Code, where the answer carries the label as authored.
 */
import { test, expect, describe } from "bun:test";
import { validateQuestionnaire } from "../tool/validate-questionnaire.js";
import { buildItemsForQuestion } from "../ask-user-question.js";
import { WrappingSelect } from "../view/components/wrapping-select.js";
import { RECOMMENDED_SUFFIX, type QuestionData, type QuestionParams } from "../tool/types.js";

const theme = new Proxy(
	{},
	{
		get:
			() =>
			(...args: unknown[]) =>
				args.map((a) => (typeof a === "string" ? a : "")).join(""),
	},
) as never;

function q(labels: string[]): QuestionData {
	return { question: "q?", header: "hdr", options: labels.map((l) => ({ label: l, description: "d" })) } as never;
}
function params(data: QuestionData): QuestionParams {
	return { questions: [data] } as unknown as QuestionParams;
}

describe("recommended marker (CC suffix convention)", () => {
	test("validation rejects two suffixed labels", () => {
		const r = validateQuestionnaire(params(q([`A${RECOMMENDED_SUFFIX}`, `B${RECOMMENDED_SUFFIX}`])));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("too_many_recommended");
	});

	test("buildItemsForQuestion derives recommended from the suffix", () => {
		const items = buildItemsForQuestion(q([`Alpha${RECOMMENDED_SUFFIX}`, "Beta"]));
		expect((items[0] as { recommended?: boolean }).recommended).toBe(true);
		expect((items[1] as { recommended?: boolean }).recommended).toBeUndefined();
	});

	test("WrappingSelect renders ⭐ and strips the suffix from display", () => {
		const items = buildItemsForQuestion(q([`Alpha${RECOMMENDED_SUFFIX}`, "Beta"]));
		const ws = new WrappingSelect(items, 8, theme);
		ws.setSelectedIndex(0);
		const out = ws.render(80).join("\n");
		expect(out).toContain("⭐");
		expect(out).toContain("Alpha");
		expect(out).not.toContain("(Recommended)");
		// stored label keeps the suffix → answer parity with CC
		expect(items[0].label).toBe(`Alpha${RECOMMENDED_SUFFIX}`);
	});

	test("unsuffixed options render no star", () => {
		const items = buildItemsForQuestion(q(["Alpha", "Beta"]));
		const ws = new WrappingSelect(items, 8, theme);
		ws.setSelectedIndex(0);
		expect(ws.render(80).join("\n")).not.toContain("⭐");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/s2-agent-ext-task && bun test src/ask-user/__tests__/recommended-marker.test.ts )`
Expected: FAIL — `buildItemsForQuestion` still reads `o.recommended` (now always undefined), display still shows the raw label.

- [ ] **Step 3: Implement**

`ask-user-question.ts` `buildItemsForQuestion`:

```typescript
export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
		recommended: hasRecommendedSuffix(o.label),
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}
```

(Add `hasRecommendedSuffix` to the existing `./tool/types.js` import.)

`wrapping-select.ts` — the render line at ~166 currently:

```typescript
const star = item.kind === "option" && item.recommended ? "⭐ " : "";
```

Replace with suffix-aware display (import `RECOMMENDED_SUFFIX` from `../../../tool/types.js`):

```typescript
const isRec = item.kind === "option" && item.recommended === true;
const star = isRec ? "⭐ " : "";
```

and where the option label is rendered, use:

```typescript
const displayLabel =
	isRec && item.label.endsWith(RECOMMENDED_SUFFIX)
		? item.label.slice(0, item.label.length - RECOMMENDED_SUFFIX.length)
		: item.label;
```

(Keep every other use of `item.label` in that render path on `displayLabel` so the visible row is suffix-free; wrapping math already runs on the display string.)

`preview-block-renderer.ts` `render()`: replace the soft-wrap loop

```typescript
const previewLines = option.preview.split("\n");
for (const line of previewLines) {
	const wrapped = wrapTextWithAnsi(line, width);
	lines.push(...wrapped);
}
```

with monospace-verbatim rendering (CC: "rendered as markdown in a monospace box"; we keep verbatim lines — hard-clip, no re-wrap — and note in the ticket Result that full markdown rendering is deliberately not built):

```typescript
// Monospace-verbatim preview (CC parity): code and ASCII mockups must not
// re-wrap. Full markdown rendering is deliberately out of scope.
const clip = (line: string): string => (line.length > width ? line.slice(0, width) : line);
for (const line of option.preview.split("\n")) {
	lines.push(clip(line));
}
```

Remove the now-unused `wrapTextWithAnsi` import if nothing else in the file uses it.

- [ ] **Step 4: Run the full ask-user suite + typecheck**

Run: `( cd bun-apps/s2-agent-ext-task && bun run typecheck && bun test src/ask-user )`
Expected: PASS. If `cards-ux2-roundtrip.test.ts` or preview tests assert wrapped preview text, update the expectation to the verbatim form (they migrated in Task 1 Step 5 only for schema; preview-text assertions migrate here).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/s2-agent-ext-task/src/ask-user
git commit -m "feat(task): ask_user_question view — suffix-driven star, monospace preview box"
```

- [ ] **Step 6: Close ticket 01 + review**

Flip `tickets/01-ask-user-cc-parity.md` `status: closed`, append `## Result`; commit `docs(planning): close ticket 01 …`. Dispatch the requesting-code-review reviewer (BASE = commit before Task 1, HEAD = this commit).

---

