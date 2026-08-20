/**
 * Characterization: gemini-web's file upload must reach the filesystem.
 *
 * This file shipped with `readFileSync` used but never imported. It sat behind
 * `// @ts-nocheck`, so no checker saw it and no test reached it — `uploadFile`
 * is only called after `fetchAccessToken`, i.e. behind a network round-trip.
 * Any Gemini Web query carrying `files` therefore died with a ReferenceError.
 *
 * `readFileSync` is the function's first statement, so an unreadable path fails
 * before any fetch. That makes the failure MODE the assertion: a filesystem
 * error proves the identity is bound; a ReferenceError proves it is not.
 */
import { test, expect, describe } from "bun:test";
import { uploadFile } from "../gemini-web.ts";

describe("uploadFile", () => {
	test("fails on the filesystem, not on an unbound identifier", async () => {
		const err = await uploadFile("/nonexistent/path/does-not-exist.bin", "", new AbortController().signal)
			.then(() => null)
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).name).not.toBe("ReferenceError");
		expect((err as Error).message).toMatch(/ENOENT|no such file/i);
	});
});
