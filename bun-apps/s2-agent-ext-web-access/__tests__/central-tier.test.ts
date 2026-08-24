import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { centralTierModel, centralTierModelFor, parseModelSpec } from "../central-tier.ts";

let homeBackup: string | undefined;

beforeEach(() => {
	homeBackup = process.env.HOME;
});
afterEach(() => {
	if (homeBackup !== undefined) process.env.HOME = homeBackup;
});

function seedTierConfig(config: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "webaccess-tier-"));
	process.env.HOME = dir;
	mkdirSync(join(dir, ".pi/workflows"), { recursive: true });
	writeFileSync(join(dir, ".pi/workflows/model-tiers.json"), JSON.stringify(config));
	return dir;
}

describe("parseModelSpec", () => {
	test("parses provider/model-id", () => {
		expect(parseModelSpec("zai/glm-5.3")).toEqual({ provider: "zai", id: "glm-5.3" });
	});

	test("keeps inner slashes in the id (lm-studio convention)", () => {
		expect(parseModelSpec("lm-studio/prism-ml/bonsai-27b")).toEqual({
			provider: "lm-studio",
			id: "prism-ml/bonsai-27b",
		});
	});

	test("strips a trailing :thinking suffix", () => {
		expect(parseModelSpec("zai/glm-5.3:high")).toEqual({ provider: "zai", id: "glm-5.3" });
	});

	test("returns null for a bare id without provider prefix", () => {
		expect(parseModelSpec("glm-5.3")).toBeNull();
	});
});

describe("centralTierModel (default tier: medium)", () => {
	test("resolves tiers.medium from the central config", () => {
		const dir = seedTierConfig({
			tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
		});
		try {
			expect(centralTierModel()).toEqual({ provider: "zai", id: "glm-5.3" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns null when unconfigured", () => {
		const dir = mkdtempSync(join(tmpdir(), "webaccess-tier-none-"));
		process.env.HOME = dir;
		try {
			expect(centralTierModel()).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("centralTierModelFor (provider-family gate)", () => {
	test("returns the id when the tier model's provider is in the family", () => {
		const dir = seedTierConfig({
			tiers: { small: "x/a", medium: "google/gemini-3-flash-preview", big: "x/b" },
		});
		try {
			expect(centralTierModelFor(["google"])).toBe("gemini-3-flash-preview");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns null when the tier model's provider is NOT in the family", () => {
		const dir = seedTierConfig({
			tiers: { small: "x/a", medium: "zai/glm-5.3", big: "x/b" },
		});
		try {
			expect(centralTierModelFor(["google", "openai", "openai-codex"])).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
