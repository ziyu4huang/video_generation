/**
 * bundle-mode-anchor.test.ts — the sh deploy's core is a bun-run ESM bundle
 * (deploy-platform-neutral-core ticket 01), and its ext discovery anchors on
 * deployRoot(import.meta.url). This test BUILDS a real bundle with the same
 * flags the deploy pipeline uses and boots it with bun, proving:
 *   - detectMode classifies the bundled module as "bundle" (not source)
 *   - deployRoot returns the bundle's own directory — where ext/ and
 *     package.json sit in a deploy — with no env override
 *
 * The probe entry imports the real mode.ts (bundled from source), so the
 * rewrite behavior of `import.meta.url` under `bun build --target=bun` is
 * exercised, not simulated with URL strings.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODE_TS = resolve(HERE, "..", "mode.ts");

describe("a bun-run bundle anchors on its own directory", () => {
	// skipIf(CI) per TEST-PORTABILITY: the probe shells out to `bun build` and
	// boots the artifact — a real-toolchain behavior probe, not a portable unit.
	test.skipIf(process.env.CI === "true" || process.env.CI === "1")("detectMode → bundle, deployRoot → bundle dir (no env)", () => {
		const outDir = mkdtempSync(join(tmpdir(), "s2-bundle-anchor-"));
		// The probe must live inside the package (a tmp-dir entry cannot resolve
		// ../mode.ts across project roots), so it is written beside mode.ts and
		// removed in the finally below. Named .probe. so nothing mistakes it for
		// a real module.
		const entry = resolve(HERE, "..", "mode.probe.tmp.ts");
		writeFileSync(
			entry,
			`import { detectMode, deployRoot } from "./mode.ts";\n` +
				`console.log(JSON.stringify({ mode: detectMode(import.meta.url), root: deployRoot(import.meta.url) }));\n`,
		);
		let build: ReturnType<typeof Bun.spawnSync> | undefined;
		try {
			build = Bun.spawnSync(["bun", "build", entry, "--target=bun", "--minify", "--outfile", join(outDir, "probe.js")], {
				cwd: dirname(MODE_TS),
				stdout: "pipe",
				stderr: "pipe",
			});
		} finally {
			rmSync(entry, { force: true });
		}
		expect(build.exitCode, `bun build failed: ${build.stderr?.toString() ?? ""}`).toBe(0);

		const boot = Bun.spawnSync(["bun", join(outDir, "probe.js")], { stdout: "pipe", stderr: "pipe" });
		expect(boot.exitCode, `bundle boot failed: ${boot.stderr.toString()}`).toBe(0);
		const got = JSON.parse(boot.stdout.toString()) as { mode: string; root: string };
		expect(got.mode).toBe("bundle");
		// realpath on both sides: macOS tmpdir answers /var/… while file URLs
		// resolve through the /private symlink.
		expect(realpathSync(got.root)).toBe(realpathSync(outDir));
	});
});
