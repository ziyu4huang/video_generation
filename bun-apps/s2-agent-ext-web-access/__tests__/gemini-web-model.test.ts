import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGeminiWebModel } from "../gemini-web.ts";

let homeBackup: string | undefined;

beforeEach(() => {
	homeBackup = process.env.HOME;
});
afterEach(() => {
	if (homeBackup !== undefined) process.env.HOME = homeBackup;
});

function seedTierConfig(config: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "webaccess-web-model-"));
	process.env.HOME = dir;
	mkdirSync(join(dir, ".pi/workflows"), { recursive: true });
	writeFileSync(join(dir, ".pi/workflows/model-tiers.json"), JSON.stringify(config));
	return dir;
}

describe("defaultGeminiWebModel (central tier → web header bucket gate)", () => {
	test("uses the central google tier id when it has a web header bucket", () => {
		const dir = seedTierConfig({
			tiers: { small: "x/a", medium: "google/gemini-2.5-pro", big: "x/b" },
		});
		try {
			expect(defaultGeminiWebModel()).toBe("gemini-2.5-pro");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("falls back when the google tier id has NO web header bucket", () => {
		// gemini-3-flash-preview is a valid API model id but not a web bucket key —
		// the pre-fix callers passed it and it was silently normalised away.
		const dir = seedTierConfig({
			tiers: { small: "x/a", medium: "google/gemini-3-flash-preview", big: "x/b" },
		});
		try {
			expect(defaultGeminiWebModel()).toBe("gemini-2.5-flash");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("falls back when the tier points at a non-google provider", () => {
		const dir = seedTierConfig({
			tiers: { small: "x/a", medium: "zai/glm-5.3", big: "x/b" },
		});
		try {
			expect(defaultGeminiWebModel()).toBe("gemini-2.5-flash");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("falls back when no tier is configured", () => {
		const dir = mkdtempSync(join(tmpdir(), "webaccess-web-model-none-"));
		process.env.HOME = dir;
		try {
			expect(defaultGeminiWebModel()).toBe("gemini-2.5-flash");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
