/**
 * ext-new — pure scaffold builder for `s2-agent ext new <name>` (PR B, Phase D).
 * Covers parseExtNewArgs / buildScaffoldFiles / validateName; the writer
 * (runExtNew) lands in Task B3 and adds the end-to-end spawn test below.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScaffoldFiles, parseExtNewArgs, validateName } from "../ext-new.ts";

/** bun-apps/s2-agent — the cwd the spawned `src/cli.ts` needs. */
const PI_AGENT_DIR = join(import.meta.dir, "..", "..");

describe("parseExtNewArgs", () => {
	test("defaults: dynamic registration, in-file entry, install on", () => {
		expect(parseExtNewArgs(["foo"])).toEqual({
			name: "foo",
			libFace: false,
			register: "dynamic",
			install: true,
			outRoot: "bun-apps/",
		});
	});

	test("--lib selects the lib-face layout", () => {
		expect(parseExtNewArgs(["foo", "--lib"]).libFace).toBe(true);
	});

	test("--register static / none", () => {
		expect(parseExtNewArgs(["foo", "--register", "static"]).register).toBe("static");
		expect(parseExtNewArgs(["foo", "--register", "none"]).register).toBe("none");
	});

	test("--no-install skips the workspace install", () => {
		expect(parseExtNewArgs(["foo", "--no-install"]).install).toBe(false);
	});

	test("--out-root overrides the packages root (hidden, for tests)", () => {
		expect(parseExtNewArgs(["foo", "--out-root", "/tmp/x"]).outRoot).toBe("/tmp/x");
	});

	test("throws on unknown flag", () => {
		expect(() => parseExtNewArgs(["foo", "--bogus"])).toThrow();
	});

	test("throws on missing name", () => {
		expect(() => parseExtNewArgs([])).toThrow();
		expect(() => parseExtNewArgs(["--lib"])).toThrow();
	});

	test("throws on bad name casing", () => {
		expect(() => parseExtNewArgs(["My-Ext"])).toThrow();
	});

	test("throws when the s2-agent-ext- prefix is supplied by the user", () => {
		expect(() => parseExtNewArgs(["s2-agent-ext-foo"])).toThrow();
	});
});

describe("validateName", () => {
	test("accepts kebab-case suffixes", () => {
		expect(validateName("foo")).toBe(true);
		expect(validateName("foo-bar2")).toBe(true);
	});

	test("rejects non-kebab input", () => {
		expect(validateName("My-Ext")).toBe(false);
		expect(validateName("2foo")).toBe(false);
		expect(validateName("foo_bar")).toBe(false);
		expect(validateName("")).toBe(false);
	});

	test("rejects the s2-agent-ext- prefix and reserved dir names", () => {
		expect(validateName("s2-agent-ext-foo")).toBe(false);
		expect(validateName("s2-agent")).toBe(false);
		expect(validateName("node_modules")).toBe(false);
	});
});

describe("buildScaffoldFiles (default in-file layout)", () => {
	const files = buildScaffoldFiles("foo-bar", { libFace: false });

	test("file set", () => {
		expect(Object.keys(files).sort()).toEqual(
			[
				"package.json",
				"tsconfig.json",
				"README.md",
				"extensions/foo-bar.ts",
				"extensions/__tests__/entry-smoke.test.ts",
			].sort(),
		);
	});

	test("package.json content", () => {
		const pkg = JSON.parse(files["package.json"]!);
		expect(pkg.name).toBe("@repo/s2-agent-ext-foo-bar");
		expect(pkg.pi.extensions).toEqual(["./extensions"]);
		expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("0.84.2");
		expect(pkg.scripts.test).toBe("bun test");
		expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
	});

	test("tsconfig include covers extensions + src (extension-entry-typechecked guard)", () => {
		const tsconfig = JSON.parse(files["tsconfig.json"]!);
		expect(tsconfig.include).toContain("extensions/**/*.ts");
		expect(tsconfig.include).toContain("src/**/*.ts");
	});

	test("entry is in-file and mentions the self-gate env", () => {
		const entry = files["extensions/foo-bar.ts"]!;
		expect(entry).toContain("BUN_PI_FOO_BAR");
		expect(entry).toContain("ExtensionFactory");
		expect(entry).not.toContain('from "../src/index.ts"');
	});

	test("smoke test imports the entry and exercises the self-gate", () => {
		const smoke = files["extensions/__tests__/entry-smoke.test.ts"]!;
		expect(smoke).toContain('from "../foo-bar.ts"');
		expect(smoke).toContain("BUN_PI_FOO_BAR");
	});

	test("README documents test/typecheck/registration/self-gate", () => {
		const readme = files["README.md"]!;
		expect(readme).toContain("s2-agent-ext-foo-bar");
		expect(readme).toContain("bun test");
		expect(readme).toContain("typecheck");
		expect(readme).toContain("BUN_PI_FOO_BAR");
	});
});

describe("buildScaffoldFiles (--lib layout)", () => {
	const files = buildScaffoldFiles("foo-bar", { libFace: true });

	test("adds src/index.ts and swaps the entry for the shim", () => {
		expect(Object.keys(files).sort()).toEqual(
			[
				"package.json",
				"tsconfig.json",
				"README.md",
				"extensions/foo-bar.ts",
				"extensions/__tests__/entry-smoke.test.ts",
				"src/index.ts",
			].sort(),
		);
	});

	test("shim is exactly the 1-line re-export after its doc comment", () => {
		const shim = files["extensions/foo-bar.ts"]!;
		expect(afterDocComment(shim)).toBe('export { default } from "../src/index.ts";');
	});

	test("package.json gains the lib face (main + '.' export)", () => {
		const pkg = JSON.parse(files["package.json"]!);
		expect(pkg.main).toBe("./src/index.ts");
		expect(pkg.exports["."]).toBe("./src/index.ts");
	});

	test("impl lives in src/index.ts with the self-gate env", () => {
		expect(files["src/index.ts"]!).toContain("BUN_PI_FOO_BAR");
	});
});

/** Everything after the leading block doc comment, trimmed. */
function afterDocComment(src: string): string {
	const end = src.indexOf("*/");
	return src.slice(end + 2).trim();
}

describe("runExtNew end-to-end (temp root, no repo mutation)", () => {
	// Host-binary spawn probe (bun × 2) — CI-gated per the test-portability audit
	// (.github/TEST-PORTABILITY.md P2): hermetic and fast locally, skipped under CI.
	test.skipIf(process.env.CI === "1" || process.env.PI_AGENT_E2E === "0")(
		"ext new scaffolds a loadable, self-testing package into a temp root",
		async () => {
		const tmp = mkdtempSync(join(tmpdir(), "ext-new-"));
		try {
			const proc = Bun.spawn(
				[
					"bun",
					"src/cli.ts",
					"ext",
					"new",
					"smoke-test-ext",
					"--out-root",
					tmp,
					"--register",
					"none",
					"--no-install",
				],
				{ cwd: PI_AGENT_DIR, stdout: "pipe", stderr: "pipe" },
			);
			const code = await proc.exited;
			expect(code).toBe(0);
			const pkgDir = join(tmp, "s2-agent-ext-smoke-test-ext");
			expect(existsSync(join(pkgDir, "package.json"))).toBe(true);

			// The scaffolded package's own gate must be green out of the box:
			// its entry-smoke test needs only bun:test (the entry's only import
			// is a type-only ExtensionFactory), so it runs without an install.
			const self = Bun.spawn(["bun", "test"], { cwd: pkgDir, stdout: "pipe", stderr: "pipe" });
			expect(await self.exited).toBe(0);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}, 30_000);
});
