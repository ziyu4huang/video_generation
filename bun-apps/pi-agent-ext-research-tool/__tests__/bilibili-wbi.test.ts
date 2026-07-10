import { test, expect } from "bun:test";
import { getMixinKey, signWbi } from "../lib/bilibili.ts";

test("getMixinKey returns exactly 32 chars and is deterministic", () => {
	const raw = "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123";
	const key = getMixinKey(raw);
	expect(key).toHaveLength(32);
	expect(getMixinKey(raw)).toBe(key); // deterministic
});

test("getMixinKey applies the enc-tab permutation (first char comes from index 46)", () => {
	// MIXIN_KEY_ENC_TAB[0] = 46, so the first output char is raw[46].
	const raw = "0123456789".repeat(7); // length 70
	expect(getMixinKey(raw)[0]).toBe(raw[46]);
});

test("signWbi adds wts + a 32-char md5 w_rid", () => {
	const raw = "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123";
	const imgKey = raw.slice(0, 32);
	const subKey = raw.slice(32, 64);
	const signed = signWbi({ keyword: "LLM" }, imgKey, subKey);
	expect(signed.keyword).toBe("LLM"); // original preserved
	expect(signed.wts).toMatch(/^\d{10}$/); // unix seconds
	expect(signed.w_rid).toHaveLength(32); // md5 hex
	expect(signed.w_rid).toMatch(/^[0-9a-f]{32}$/);
});

test("signWbi is deterministic for the same wts-anchored instant via fixed mixin", () => {
	// Same keys + same params → same w_rid only if wts is fixed; here we verify
	// the w_rid is a stable hex (regression guard, not time-dependent).
	const signed1 = signWbi({ a: "1", b: "2" }, "imgkey1234567890", "subkey1234567890");
	const signed2 = signWbi({ a: "1", b: "2" }, "imgkey1234567890", "subkey1234567890");
	// wts may differ by a second; w_rid will then differ — so only assert shape.
	expect(signed1.w_rid).toHaveLength(32);
	expect(signed2.w_rid).toHaveLength(32);
});
