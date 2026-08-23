import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAdHocExtensionArgs, loadAdHocExtensions } from "./adhoc-extensions.ts";
import { hostRequire } from "./host-modules.ts";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** Call an ad-hoc factory with a dummy pi — the factories are opaque here. */
function call(factory: ExtensionFactory, ...args: unknown[]): unknown {
	return (factory as (...a: unknown[]) => unknown)(...args);
}

describe("extractAdHocExtensionArgs", () => {
	test("intercepts -e and --extension pairs whose value exists on disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "adhoc-ext-"));
		const f1 = join(dir, "one.ts");
		const f2 = join(dir, "two.js");
		writeFileSync(f1, "export default () => {}");
		writeFileSync(f2, "export default () => {}");
		const { passthrough, files } = extractAdHocExtensionArgs([
			"-p",
			"hi",
			"-e",
			f1,
			"--extension",
			f2,
			"--no-session",
		]);
		expect(files).toEqual([f1, f2]);
		expect(passthrough).toEqual(["-p", "hi", "--no-session"]);
	});

	test("nonexistent paths and flag-less values pass through untouched", () => {
		const { passthrough, files } = extractAdHocExtensionArgs([
			"-e",
			"/definitely/not/here.ts",
			"-e",
			"--json", // value slot holds a flag — pi's parser should reject this, not us
			"-p",
			"hi",
		]);
		expect(files).toEqual([]);
		expect(passthrough).toEqual(["-e", "/definitely/not/here.ts", "-e", "--json", "-p", "hi"]);
	});

	test("-e at the end with no value passes through", () => {
		const { passthrough, files } = extractAdHocExtensionArgs(["-p", "hi", "-e"]);
		expect(files).toEqual([]);
		expect(passthrough).toEqual(["-p", "hi", "-e"]);
	});
});

describe("loadAdHocExtensions", () => {
	test("loads a -e file whose default export is a factory; reports the rest", async () => {
		const dir = mkdtempSync(join(tmpdir(), "adhoc-load-"));
		const good = join(dir, "good.ts");
		const noFactory = join(dir, "no-factory.ts");
		const broken = join(dir, "broken.ts");
		writeFileSync(good, "export default () => {}");
		writeFileSync(noFactory, "export const notDefault = 1");
		writeFileSync(broken, "export default () => { throw new Error('boom') };\nthrow new Error('boom at module scope');");
		const r = await loadAdHocExtensions([good, noFactory, broken]);
		expect(r.factories.map((f) => f.path)).toEqual([good]);
		expect(typeof r.factories[0]!.factory).toBe("function");
		expect(r.skipped.map((s) => s.path).sort()).toEqual([broken, noFactory].sort());
		expect(r.skipped.find((s) => s.path === noFactory)!.reason).toContain("no callable default export");
		expect(r.skipped.find((s) => s.path === broken)!.reason).toContain("boom");
	});

	test("a file importing a host-module specifier resolves to the HOST instance (the bundle-mode gap this closes)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "adhoc-host-"));
		const f = join(dir, "uses-host.ts");
		writeFileSync(
			f,
			'import { Overlay } from "@earendil-works/pi-tui";\nexport default () => ({ overlayCtor: Overlay });\n',
		);
		const r = await loadAdHocExtensions([f]);
		expect(r.skipped).toEqual([]);
		const got = call(r.factories[0]!.factory, {}) as { overlayCtor: unknown };
		// Member identity is what identity-sensitive code compares (classes,
		// singletons): the host's export, not a second copy.
		expect(got.overlayCtor).toBe((hostRequire("@earendil-works/pi-tui") as Record<string, unknown>).Overlay);
	}, 30_000);

	test("relative sibling imports are inlined by the runtime build", async () => {
		// Runs in a SUBPROCESS: a multi-module Bun.build (entry + relative
		// import) burns bun 1.4's one-shot native import of freshly-written tmp
		// .ts files for the WHOLE process (see adhoc-extensions.ts header) —
		// doing it here would break unrelated suites (schema-cost) that import
		// their own temp files in this same test process.
		const dir = mkdtempSync(join(tmpdir(), "adhoc-rel-"));
		writeFileSync(join(dir, "sibling.ts"), "export const marker = 1337;\n");
		const f = join(dir, "main.ts");
		writeFileSync(f, 'import { marker } from "./sibling.ts";\nexport default () => marker;\n');
		const script = `const { loadAdHocExtensions } = await import(${JSON.stringify(
			new URL("adhoc-extensions.ts", import.meta.url).pathname,
		)});
const r = await loadAdHocExtensions([${JSON.stringify(f)}]);
if (r.skipped.length) { console.error(r.skipped[0]!.reason); process.exit(1); }
console.log((r.factories[0]!.factory as (...a: unknown[]) => unknown)());`;
		const child = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		expect(child.stdout.toString().trim()).toBe("1337");
	}, 30_000);

	test("loading never poisons bun's native dynamic import", async () => {
		// Runs in a SUBPROCESS: bun 1.4 can natively import a freshly-written
		// tmp .ts roughly ONCE per process before "Cannot find module" sets in
		// (a runtime quirk unrelated to this module — see the no-build control
		// in the effort's spike), and burning this process's one shot breaks
		// unrelated suites (schema-cost) that import their own temp files.
		const dir = mkdtempSync(join(tmpdir(), "adhoc-native-"));
		const f = join(dir, "adhoc.ts");
		writeFileSync(f, "export default () => 1;\n");
		const r = await loadAdHocExtensions([f]);
		expect(r.skipped).toEqual([]);
		const native = join(dir, "native.ts");
		writeFileSync(native, "export default 2;\n");
		const child = Bun.spawnSync([process.execPath, "-e", `const m = await import(${JSON.stringify(native)}); console.log(m.default);`], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		expect(child.stdout.toString().trim()).toBe("2");
	}, 30_000);
});
