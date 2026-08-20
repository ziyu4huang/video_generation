import { describe, expect, test } from "bun:test";
import { formatExtList } from "./ext-list.ts";
import type { LoadResult } from "./ext-loader.ts";

const empty: LoadResult = { factories: [], skillPaths: [], loaded: [], skipped: [] };

describe("formatExtList", () => {
	test("emits parseable JSON with the counts", () => {
		const r: LoadResult = {
			...empty,
			loaded: ["task", "power-tool"],
			skillPaths: ["/d/ext/power-tool/skills"],
			skipped: [{ name: "old", reason: "built for hostApi 0, host provides 1" }],
		};
		const parsed = JSON.parse(formatExtList("/d/ext", 1, r));
		expect(parsed).toEqual({
			extRoot: "/d/ext",
			hostApi: 1,
			loadedCount: 2,
			loaded: ["task", "power-tool"],
			skillPaths: ["/d/ext/power-tool/skills"],
			skipped: [{ name: "old", reason: "built for hostApi 0, host provides 1" }],
		});
	});

	test("zero extensions is a valid, non-error report", () => {
		const parsed = JSON.parse(formatExtList("/d/ext", 1, empty));
		expect(parsed.loadedCount).toBe(0);
		expect(parsed.loaded).toEqual([]);
		expect(parsed.skipped).toEqual([]);
	});
});
