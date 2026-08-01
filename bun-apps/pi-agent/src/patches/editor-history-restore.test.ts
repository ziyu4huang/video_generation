import { describe, expect, test } from "bun:test";
import { wrapInteractiveInitForHistoryRestore } from "./editor-history-restore.ts";

function makeStubProto(): object {
	return {
		async init() {},
	};
}

test("hydrates editor.history newest-first from the reader after orig init", async () => {
	const proto: any = makeStubProto();
	expect(wrapInteractiveInitForHistoryRestore(proto, () => ["old", "new"])).toBe(true);
	const instance = Object.create(proto);
	instance.sessionManager = { getCwd: () => "/proj" };
	instance.editor = { history: [], exitHistoryBrowsing() {} };
	await instance.init();
	expect(instance.editor.history).toEqual(["old", "new"]);
	expect(instance.editor.exitHistoryBrowsing).toBeDefined();
});

test("idempotent per-prototype — a second wrap returns false", () => {
	const proto: any = makeStubProto();
	expect(wrapInteractiveInitForHistoryRestore(proto, () => [])).toBe(true);
	expect(wrapInteractiveInitForHistoryRestore(proto, () => [])).toBe(false);
});

test("shape-change guard — missing init returns false", () => {
	expect(wrapInteractiveInitForHistoryRestore({}, () => [])).toBe(false);
});

test("never throws when editor or cwd is missing", async () => {
	const proto: any = { async init() {} };
	wrapInteractiveInitForHistoryRestore(proto, () => ["x"]);
	const instance = Object.create(proto); // no sessionManager / editor
	await expect(instance.init()).resolves.toBeUndefined();
});

test("caps the restored history at 100", async () => {
	const proto: any = makeStubProto();
	const many = Array.from({ length: 150 }, (_, i) => `p${i}`);
	wrapInteractiveInitForHistoryRestore(proto, () => many);
	const instance = Object.create(proto);
	instance.sessionManager = { getCwd: () => "/proj" };
	instance.editor = { history: [], exitHistoryBrowsing() {} };
	await instance.init();
	expect(instance.editor.history.length).toBe(100);
});
