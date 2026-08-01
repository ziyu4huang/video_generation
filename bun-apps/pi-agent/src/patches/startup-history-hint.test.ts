import { describe, expect, test } from "bun:test";
import { wrapInteractiveInitForHistoryHint } from "./startup-history-hint.ts";

test("appends the hint to the expanded header text, leaves collapsed unchanged", async () => {
	const header = {
		getCollapsedText: () => "COMPACT",
		getExpandedText: () => "EXPANDED",
	};
	const proto: any = { async init() {} };
	wrapInteractiveInitForHistoryHint(proto, "↑/↓ to browse history");
	const instance = Object.create(proto);
	instance.builtInHeader = header;
	await instance.init();
	expect(header.getExpandedText()).toBe("EXPANDED\n↑/↓ to browse history");
	expect(header.getCollapsedText()).toBe("COMPACT");
});

test("idempotent per-prototype — a second wrap returns false", () => {
	const proto: any = { async init() {} };
	expect(wrapInteractiveInitForHistoryHint(proto, "x")).toBe(true);
	expect(wrapInteractiveInitForHistoryHint(proto, "x")).toBe(false);
});

test("shape-change guard — missing init returns false", () => {
	expect(wrapInteractiveInitForHistoryHint({}, "x")).toBe(false);
});

test("no header → no throw", async () => {
	const proto: any = { async init() {} };
	wrapInteractiveInitForHistoryHint(proto, "x");
	const instance = Object.create(proto); // no builtInHeader
	await expect(instance.init()).resolves.toBeUndefined();
});
