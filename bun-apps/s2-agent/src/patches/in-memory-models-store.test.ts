/**
 * in-memory-models-store — wrap behavior tests.
 *
 * Tests the exported pure helper wrapCreateWithInMemoryStore() against a
 * recording fake factory — no auth, no network, no real ModelRuntime. Testing
 * the helper (instead of re-importing the patch module against a substituted
 * ModelRuntime.create) sidesteps `bun test`'s shared module registry: another
 * test file's applyPatches() may have already imported and bound the patch,
 * so an import-time capture cannot be re-staged reliably mid-run. The import
 * -time binding itself is covered by applyPatches' own failure reporting
 * (patchApplied) in ./index.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { wrapCreateWithInMemoryStore } from "./in-memory-models-store.ts";

type CreateFn = typeof ModelRuntime.create;

/** Recording fake the wrap delegates to. */
function fakeCreate(): { seen: Array<Record<string, unknown>>; fn: CreateFn } {
	const arr: Array<Record<string, unknown>> = [];
	const fn = (async (options = {}) => {
		arr.push(options as Record<string, unknown>);
		return {} as Awaited<ReturnType<CreateFn>>;
	}) as CreateFn;
	return { seen: arr, fn };
}

describe("wrapCreateWithInMemoryStore", () => {
	test("injects InMemoryModelsStore when the caller omitted one", async () => {
		const { seen, fn } = fakeCreate();
		const wrapped = wrapCreateWithInMemoryStore(fn);
		await wrapped({} as Parameters<CreateFn>[0]);
		expect(seen[0]?.modelsStore).toBeInstanceOf(InMemoryModelsStore);
	});

	test("explicit caller modelsStore is respected, never replaced", async () => {
		const { seen, fn } = fakeCreate();
		const wrapped = wrapCreateWithInMemoryStore(fn);
		const mine = new InMemoryModelsStore();
		await (wrapped as unknown as (o: unknown) => Promise<unknown>)({ modelsStore: mine });
		expect(seen[0]?.modelsStore).toBe(mine);
	});

	test("passes all other options through untouched", async () => {
		const { seen, fn } = fakeCreate();
		const wrapped = wrapCreateWithInMemoryStore(fn);
		const opts = { authPath: "/x/auth.json", modelsPath: "/x/models.json" };
		await (wrapped as unknown as (o: unknown) => Promise<unknown>)(opts);
		expect(seen[0]?.authPath).toBe("/x/auth.json");
		expect(seen[0]?.modelsPath).toBe("/x/models.json");
	});
});
