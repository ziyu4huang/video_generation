/**
 * resolvePiPkgDir on a WINDOWS build host (crossos follow-through, 2026-08-27).
 *
 * Measured failure: crossos-deploy-verify run 33075359667, windows row, ~3s
 * into the deploy step —
 *   ENOENT … open '\C:\Users\runneradmin\.bun\install\cache\links\
 *   @earendil-works+pi-coding-agent@0.84.2+…\node_modules\@earendil-works\
 *   pi-coding-agent\package.json'
 * The old `dirname(new URL(url).pathname)` kept the URL's posix `/C:/…`
 * pathname; path.win32.join then normalized it to the unopenable `\C:\…`.
 * `fileURLToPath` is the only spelling that yields a real `C:\…` path on
 * win32. On darwin both spellings agree, so no behavioral darwin test can
 * separate them — coverage is (a) the live resolution still works, (b) a
 * mechanism test pinning the artifact shape under path.win32, and (c) a
 * source-scan tripwire banning `.pathname` filesystem reads in deploy code
 * (same style as the artifact-leak tests). The integration gate that
 * actually exercises the win32 branch is the crossos-deploy-verify windows
 * row itself.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { resolvePiPkgDir } from "../src/deploy/run.ts";

describe("resolvePiPkgDir (win32 url→path trap)", () => {
	test("resolves THIS machine's real pi-coding-agent package dir", () => {
		const dir = resolvePiPkgDir();
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string };
		expect(pkg.name).toBe("@earendil-works/pi-coding-agent");
	});

	test("mechanism: url.pathname + path.win32.join reproduces the \\C:\\ artifact from run 33075359667", () => {
		const url =
			"file:///C:/Users/runneradmin/.bun/install/cache/links/@earendil-works+pi-coding-agent@0.84.2+c41fff0105edc355-bb9a7f2aa13c74d4/node_modules/@earendil-works/pi-coding-agent/package.json";
		// The OLD expression: posix pathname fed to a windows join → the exact
		// leading-backslash ENOENT shape. fileURLToPath instead anchors at the
		// drive letter (C:\…) on win32; on darwin it degenerates to the posix
		// pathname, which is correct HERE — the two only diverge on win32.
		const old = win32.join(new URL(url).pathname, "package.json");
		expect(old.startsWith("\\")).toBe(true);
	});

	test("tripwire: deploy sources never read url.pathname for filesystem paths", () => {
		for (const rel of ["src/deploy/run.ts", "src/deploy/lib/bun-acquire.ts"]) {
			const src = readFileSync(join(import.meta.dir, "..", rel), "utf8");
			expect(src.includes(").pathname")).toBe(false);
		}
	});
});
