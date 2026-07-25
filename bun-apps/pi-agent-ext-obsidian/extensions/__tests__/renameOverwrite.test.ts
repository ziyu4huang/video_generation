import { test, expect, mock } from "bun:test";
import { renameOverwrite } from "../../src/obsidian-lib.ts";

// Drive renameOverwrite against an in-memory fs double so we can inject
// EPERM/EEXIST (win32 rename-onto-existing) without a real Windows box.
const fakeErr = (code: string) => Object.assign(new Error(code), { code });

test("renameOverwrite: plain rename success (fast path)", async () => {
	const rename = mock(() => Promise.resolve());
	await renameOverwrite("/v/a.tmp", "/v/a.md", { rename });
	expect(rename).toHaveBeenCalledTimes(1);
});

test("renameOverwrite: EPERM on existing target → unlink+retry succeeds", async () => {
	// annotate `Promise<void>` so mockImplementation's resolve-branch type-checks
	const rename = mock((): Promise<void> => Promise.reject(fakeErr("EPERM")));
	const unlink = mock(() => Promise.resolve());
	// second rename attempt (after unlink) succeeds
	let calls = 0;
	rename.mockImplementation(() => (calls++ === 0 ? Promise.reject(fakeErr("EPERM")) : Promise.resolve()));
	await renameOverwrite("/v/a.tmp", "/v/a.md", { rename, unlink });
	expect(unlink).toHaveBeenCalledWith("/v/a.md");
	expect(rename).toHaveBeenCalledTimes(2);
});

test("renameOverwrite: EEXIST → unlink+retry succeeds", async () => {
	const unlink = mock(() => Promise.resolve());
	let calls = 0;
	const rename = mock(() => (calls++ === 0 ? Promise.reject(fakeErr("EEXIST")) : Promise.resolve()));
	await renameOverwrite("/v/a.tmp", "/v/a.md", { rename, unlink });
	expect(unlink).toHaveBeenCalledTimes(1);
});

test("renameOverwrite: EXDEV → copy+delete path (unchanged)", async () => {
	const cp = mock(() => Promise.resolve());
	const rm = mock(() => Promise.resolve());
	const unlink = mock(() => Promise.resolve());
	const rename = mock(() => Promise.reject(fakeErr("EXDEV")));
	await renameOverwrite("/v/a.tmp", "/v/a.md", { rename, cp, unlink, rm });
	expect(cp).toHaveBeenCalled();
	expect(rm).toHaveBeenCalledWith("/v/a.tmp", { force: true }); // source cleaned idempotently
});

test("renameOverwrite: unrelated error rethrows", async () => {
	const rename = mock(() => Promise.reject(fakeErr("EACCES")));
	await expect(renameOverwrite("/v/a.tmp", "/v/a.md", { rename })).rejects.toThrow();
});
