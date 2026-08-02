/**
 * Augmentation-agreement test (FOLLOWUPS #9).
 *
 * Each of the 3 pilot packages owns an identical copy of `types/tool-gating.d.ts`
 * (duplicated deliberately so no cross-package TYPE dependency is introduced —
 * each package's tsconfig `types` glob picks up its own copy). They agree TODAY
 * (byte-identical) but nothing pinned it; the `.d.ts` header comment even
 * overclaims "a drift-guard test asserts structural agreement". A silent
 * divergence would split the `ToolDefinition.gating` augmentation across
 * packages (one package's `gating` could vanish, or its `Gating` shape could
 * drift), and TypeScript would not flag it.
 *
 * This test pins the agreement: every copy is read at test time and asserted
 * (a) to exist, (b) to be byte-identical to the others, and (c) to declare the
 * expected augmentation shape (`gating?: Gating` on `ToolDefinition` + the
 * `Gating` interface with `keywords` / `requires` / `core`). A future
 * intentional divergence must update every copy in lock-step (or update this
 * test's canonical deliberately) — exactly the friction we want so a one-off
 * edit to a single package can't silently split the augmentation.
 *
 * (This is a dev-time cross-package file read, not a runtime ext↔ext dependency
 * — the same allowance ticket 03 made for test-time cross-extension imports.)
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Each pilot's `types/tool-gating.d.ts`, resolved from this test file's dir. */
const HERE = import.meta.dir; // …/pi-agent-ext-tool-gate/extensions
const COPIES = [
	{ pkg: "pi-agent-ext-tool-gate", path: join(HERE, "..", "types", "tool-gating.d.ts") },
	{ pkg: "pi-agent-ext-core-task", path: join(HERE, "..", "..", "pi-agent-ext-core-task", "types", "tool-gating.d.ts") },
	{ pkg: "pi-agent-ext-power-tool", path: join(HERE, "..", "..", "pi-agent-ext-power-tool", "types", "tool-gating.d.ts") },
] as const;

function readCopy(p: string): string {
	return readFileSync(p, "utf8");
}

describe("augmentation agreement — the 3 tool-gating.d.ts copies declare the SAME augmentation", () => {
	test(`pinned count: exactly ${COPIES.length} copies are asserted (one per pilot)`, () => {
		// Guard against a 4th pilot's copy being added without wiring it in here
		// (and against a copy being deleted without removing its row). Update this
		// array — and COPIES — together when the pilot set changes.
		expect(COPIES.length).toBe(3);
		expect(COPIES.map((c) => c.pkg).sort()).toEqual(
			["pi-agent-ext-core-task", "pi-agent-ext-power-tool", "pi-agent-ext-tool-gate"].sort(),
		);
	});

	test("every copy exists on disk", () => {
		for (const c of COPIES) {
			expect(() => readCopy(c.path), `${c.pkg}: ${c.path} should exist`).not.toThrow();
		}
	});

	test("all copies are byte-identical (the strongest pin — any divergence fails)", () => {
		const contents = COPIES.map((c) => readCopy(c.path));
		const canonical = contents[0];
		for (let i = 1; i < contents.length; i++) {
			expect(
				contents[i],
				`${COPIES[i].pkg} diverges from ${COPIES[0].pkg} — keep the copies in lock-step`,
			).toBe(canonical);
		}
	});

	test("the shared augmentation declares `gating?: Gating` on ToolDefinition", () => {
		const canonical = readCopy(COPIES[0].path);
		// The augmentation lives inside `declare module "…pi-coding-agent"`:
		//   interface ToolDefinition { gating?: Gating; }
		expect(canonical).toMatch(/interface\s+ToolDefinition\s*\{[\s\S]*?gating\?\s*:\s*Gating/);
	});

	test("the shared Gating shape declares keywords / requires / core", () => {
		const canonical = readCopy(COPIES[0].path);
		// The Gating interface lives inside `declare global`:
		//   interface Gating { keywords?: …; requires?: { nouns; verbs }; core?: boolean; }
		expect(canonical).toMatch(/interface\s+Gating\s*\{/);
		expect(canonical).toMatch(/keywords\?\s*:/);
		expect(canonical).toMatch(/requires\?\s*:/);
		expect(canonical).toMatch(/core\?\s*:/);
	});

	test("NEGATIVE: a diverged copy would fail the byte-identical pin (sanity for the guard itself)", () => {
		// Prove the byte-identical assertion is non-vacuous: splice in a one-char
		// divergence and confirm it is detected (so we know a real divergence
		// would be caught, not silently pass).
		const a = readCopy(COPIES[0].path);
		const b = a.replace("core?: boolean;", "core?: boolean; // diverged");
		expect(b).not.toBe(a);
	});
});
