/**
 * deck-pack CLI — the --inline-ir transport end to end (envelope arc T3).
 *
 * Flow per test: CLI pack --inline-ir -> CLI unpack into an empty dir ->
 * buildDeck({manifestDir: <unpacked>}) — the real user pipeline, end to end.
 * The `..` escape lands IR files OUTSIDE the unpacked dir (inside `work`),
 * which the suite cleans up. Assessor-facing refusals (missing IR file) run
 * through spawnSync because fail() exits the CLI process.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDeck } from "../src/deck-build.ts";

const PKG_ROOT = join(import.meta.dir, "..");
const DECK_CLI = join(PKG_ROOT, "scripts", "deck.ts");
const EXAMPLES = join(PKG_ROOT, "examples");

function run(cmd: string[]) {
	const r = spawnSync("bun", [DECK_CLI, ...cmd], { encoding: "utf8", timeout: 120_000 });
	return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** CLI pack --inline-ir + CLI unpack into a bare dir -> build from it. */
async function expectStandaloneBuild(cfgRel: string, expectedSlides: number): Promise<void> {
	const work = mkdtempSync(join(tmpdir(), "deck-inline-"));
	const unpacked = join(work, "unpacked");
	try {
		const configPath = join(EXAMPLES, cfgRel);
		const pack = run(["pack", configPath, "--inline-ir", "--out", join(work, "e.deckl")]);
		expect(pack.code, "pack failed: " + pack.stderr.slice(0, 200)).toBe(0);

		const unpack = run(["unpack", join(work, "e.deckl"), "--out", unpacked]);
		expect(unpack.code, "unpack failed: " + unpack.stderr.slice(0, 200)).toBe(0);
		expect(existsSync(join(unpacked, "deck.config.json"))).toBe(true);

		// The headline acceptance: the landed folder builds standalone.
		const result = await buildDeck({
			manifest: JSON.parse(
				readFileSync(join(unpacked, "deck.config.json"), "utf8"),
			) as unknown as Parameters<typeof buildDeck>[0]["manifest"],
			manifestDir: unpacked,
			outputPath: join(work, "out.pptx"),
			cwd: PKG_ROOT,
			slidesDir: null,
		});
		expect(result.slides.length).toBe(expectedSlides);
		expect(result.bytes).toBeGreaterThan(0);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

describe("deck pack --inline-ir — standalone build from one envelope", () => {
	test(
		"deck-composed (escape-form authored paths): CLI unpack into an empty tree -> builds",
		async () => {
			expectStandaloneBuild(join("deck-composed", "deck.config.json"), 6);
		},
		120_000,
	);

	test(
		"deck (in-dir authored paths): CLI unpack into an empty tree -> builds",
		async () => {
			expectStandaloneBuild(join("deck", "deck.config.json"), 5);
		},
		120_000,
	);

	test("CLI pack --inline-ir -> unpack -> pack is byte-identical", async () => {
		const work = mkdtempSync(join(tmpdir(), "deck-inline-idem-"));
		try {
			const deckl = join(work, "e.deckl");
			const first = run(["pack", join(EXAMPLES, "deck", "deck.config.json"), "--inline-ir", "--out", deckl]);
			expect(first.code).toBe(0);
			const unpackedDir = join(work, "unpacked");
			const back = run(["unpack", deckl, "--out", unpackedDir]);
			expect(back.code).toBe(0);
			const repacked = join(work, "repacked.deckl");
			const again = run(["pack", join(unpackedDir, "deck.config.json"), "--inline-ir", "--out", repacked]);
			expect(again.code).toBe(0);
			expect(readFileSync(repacked, "utf8")).toBe(readFileSync(deckl, "utf8"));
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}, 120_000);
});

// -- assessor-facing refusals (spawnSync -- fail() exits the CLI process) ----
describe("deck pack -- assessor-facing refusals", () => {
	test("pack --inline-ir refuses a missing IR file, naming the slide and path", () => {
		const work = mkdtempSync(join(tmpdir(), "deck-inline-missing-"));
		try {
			const manifest = {
				output: "x.pptx",
				slides: [{ layout: "diagram", title: "t", ir: "ir/nowhere.json" }],
			};
			const configPath = join(work, "deck.config.json");
			writeFileSync(configPath, JSON.stringify(manifest));
			const r = run(["pack", configPath, "--inline-ir"]);
			expect(r.code).not.toBe(0);
			expect(r.stderr).toContain("nowhere.json");
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}, 60_000);
});
