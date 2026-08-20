/**
 * offline-gate — Gate 5, "the deploy tree is offline-contained".
 *
 * Gates 1–4 police the BUNDLE; nothing policed the TREE. Three blind spots,
 * each a way a "self-contained" deploy could still reach off itself:
 *   - a symlink left by a vendoring bug points back at ~/.bun (the isolated
 *     linker's link farm — the stale repo-root dist/pi-agent tree carried a
 *     live one for months);
 *   - the compiled binary bakes build-machine paths Gate 4 never sees (it
 *     scans ext.cjs only);
 *   - a vendored package whose hard deps are not in the tree dangles at
 *     runtime with no offline remediation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	scanBinaryForeignPaths,
	scanSymlinkEscapes,
	verifyVendoredClosure,
	verifyVendoredCompleteness,
} from "../scripts/lib/offline-gate.ts";

const dirs: string[] = [];
function makeDir(): string {
	const d = mkdtempSync(join(tmpdir(), "sh-offline-gate-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writePkg(dir: string, name: string, pkgJson: Record<string, unknown>): string {
	const pkgDir = join(dir, name);
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkgJson));
	return pkgDir;
}

describe("scanSymlinkEscapes", () => {
	test("a tree with no symlinks is clean", () => {
		const root = makeDir();
		mkdirSync(join(root, "ext", "hyperframes", "node_modules", "sharp"), { recursive: true });
		expect(scanSymlinkEscapes(root)).toEqual([]);
	});

	test("an in-tree symlink passes — only escapes are violations", () => {
		const root = makeDir();
		mkdirSync(join(root, "real"));
		symlinkSync(join(root, "real"), join(root, "link"), "dir");
		expect(scanSymlinkEscapes(root)).toEqual([]);
	});

	test("a symlink into the global store is flagged, relative or absolute, even dangling", () => {
		const root = makeDir();
		// Absolute escape (the ~/.bun link-farm shape).
		symlinkSync("/definitely/outside/store/pkg", join(root, "pkg"), "dir");
		// Relative escape: ../../ escapes root even though the target is dead.
		symlinkSync("../../elsewhere", join(root, "rel-escape"), "dir");
		const escapes = scanSymlinkEscapes(root);
		expect(escapes).toHaveLength(2);
		expect(escapes.join("\n")).toContain("/definitely/outside/store/pkg");
	});
});

describe("scanBinaryForeignPaths", () => {
	const ROOTS = { home: "/Users/builder", repo: "/Users/builder/proj/repo" };

	function binaryWith(content: string): string {
		const dir = makeDir();
		const f = join(dir, "pi-agent");
		writeFileSync(f, content);
		return f;
	}

	test("home/repo paths in the binary are FOREIGN; the documented bun cache artifact is allowed", () => {
		const f = binaryWith(
			`x="/Users/builder/.bun/install/cache/links/@silvia-odwyer+photon-node@0.3.4-8d80a350999f4618/node_modules/@silvia-odwyer/photon-node";` +
				`y="/Users/builder/proj/repo/bun-apps/x.ts";`,
		);
		const r = scanBinaryForeignPaths(f, "/deploy/v1", ROOTS);
		expect(r.foreign).toEqual(["/Users/builder/proj/repo/bun-apps/x.ts"]);
		expect(r.allowed).toHaveLength(1);
	});

	test("allowlisted prefix over its hit cap is FOREIGN — a vendoring defect bursts, not trickles", () => {
		const f = binaryWith(
			["a", "b", "c", "d"]
				.map((k) => `v${k}="/Users/builder/.bun/install/cache/links/pkg-${k}/x.js";`)
				.join(""),
		);
		const r = scanBinaryForeignPaths(f, "/deploy/v1", ROOTS);
		expect(r.foreign.length).toBeGreaterThan(0);
	});
});

describe("verifyVendoredCompleteness", () => {
	test("every ext.json vendored entry must have its node_modules/<pkg> present", () => {
		const root = makeDir();
		const extDir = join(root, "ext", "hyperframes");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "ext.json"),
			JSON.stringify({ vendored: ["@hyperframes/core", "sharp"] }),
		);
		writePkg(join(extDir, "node_modules"), "@hyperframes", { name: "@hyperframes", version: "0" });
		mkdirSync(join(extDir, "node_modules", "@hyperframes", "core"), { recursive: true });
		writeFileSync(
			join(extDir, "node_modules", "@hyperframes", "core", "package.json"),
			JSON.stringify({ name: "@hyperframes/core" }),
		);
		// sharp: declared but absent.
		const missing = verifyVendoredCompleteness(root);
		expect(missing).toEqual([{ ext: "hyperframes", pkg: "sharp" }]);
	});

	test("an ext dir without vendored entries contributes nothing", () => {
		const root = makeDir();
		const extDir = join(root, "ext", "task");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "ext.json"), JSON.stringify({ vendored: [] }));
		expect(verifyVendoredCompleteness(root)).toEqual([]);
	});
});

describe("verifyVendoredClosure", () => {
	test("a vendored package with an unshipped HARD dep is flagged; builtins and present deps are fine", () => {
		const root = makeDir();
		const nm = join(root, "ext", "hyperframes", "node_modules");
		mkdirSync(nm, { recursive: true });
		writePkg(nm, "producer", {
			name: "producer",
			dependencies: { puppeteer: "*", "node:fs": "*" },
		});
		writePkg(nm, "puppeteer", { name: "puppeteer" });
		writePkg(nm, "fonts", { name: "fonts", dependencies: { "not-shipped": "*" } });

		const violations = verifyVendoredClosure(root);
		expect(violations).toEqual([{ pkg: "fonts", missing: ["not-shipped"] }]);
	});

	test("a nested node_modules dir satisfies a dep — and is audited too", () => {
		const root = makeDir();
		const nm = join(root, "ext", "hyperframes", "node_modules");
		mkdirSync(nm, { recursive: true });
		const producer = writePkg(nm, "producer", {
			name: "producer",
			dependencies: { "nested-dep": "*" },
		});
		writePkg(join(producer, "node_modules"), "nested-dep", {
			name: "nested-dep",
			dependencies: { "also-missing": "*" },
		});

		const violations = verifyVendoredClosure(root);
		expect(violations).toEqual([{ pkg: "nested-dep", missing: ["also-missing"] }]);
	});
});
