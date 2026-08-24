/**
 * deploy-report — the per-deploy HTML report written into the version dir
 * (<outRoot>/<version>/deploy-report.html) plus the outRoot index.html that
 * lists retained versions.
 *
 * The report exists because a deploy's only persisted record used to be
 * deploy.json (provenance) and per-ext ext.json (build manifest): the
 * included/excluded decision table, the vendored-closure stats, the gate
 * results, and the BAKED-IN provider/model catalog were all reconstructible
 * only by re-reading the source registry. The report freezes that analysis
 * with the version it describes — immutable like the tree it sits in.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectModelFacts,
	renderDeployReport,
	renderDeployReportYaml,
	renderOutRootIndex,
	type DeployReportData,
} from "../src/deploy/lib/deploy-report.ts";
import { excludedExtensions } from "../src/deploy/lib/config.ts";

const BUN_APPS_DIR = join(import.meta.dir, "..", "..");

function fixtureData(overrides: Partial<DeployReportData> = {}): DeployReportData {
	return {
		version: "0.1.0+gdeadbee",
		builtAt: "2026-08-22T00:00:00.000Z",
		sourceSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		bunVersion: "1.4.0",
		configPath: "/repo/bun-apps/s2-agent/s2-agent.registry.yaml",
		outRoot: "/dist/s2-agent-sh",
		target: "/dist/s2-agent-sh/0.1.0+gdeadbee",
		freeze: true,
		current: true,
		core: { bytes: 68_000_000, cached: true },
		gates: [
			{ id: "1", title: "scanForeignSpecifiers", scope: "per-ext", status: "pass", ms: 120 },
			{ id: "3", title: "verifyDualState", scope: "deploy", status: "pass", ms: 900 },
		],
		extensions: [
			{
				name: "hyperframes",
				package: "s2-agent-ext-hyperframes",
				order: 120,
				bytes: 25_000_000,
				skills: ["skills"],
				copy: [],
				vendor: ["@hyperframes/core", "sharp"],
				externals: [],
				vendorExclude: ["@fontsource/*"],
				closure: { count: 79, pruned: ["@img/sharp-win32-x64"], excluded: ["@fontsource/inter"] },
			},
		],
		excluded: [{ name: "archify", package: "s2-agent-ext-archify", reason: "not shipped in this fixture deploy" }],
		providers: collectModelFacts(),
		...overrides,
	};
}

describe("collectModelFacts — the baked-in provider/model layers of s2-agent", () => {
	test("catalog carries the active PROVIDERS with their models", () => {
		const facts = collectModelFacts();
		expect(facts.catalog.length).toBeGreaterThan(0);
		const lm = facts.catalog.find((p) => p.id === "lm-studio");
		expect(lm).toBeDefined();
		expect(lm?.models.map((m) => m.id)).toContain("google/gemma-4-12b");
	});

	test("default model facts come from the real sources", () => {
		const facts = collectModelFacts();
		expect(facts.defaultModel.provider).toBe("zai");
		expect(facts.defaultModel.model).toBe("glm-5.3");
	});
});

describe("renderDeployReport", () => {
	test("renders identity, gate matrix, included and excluded extensions", () => {
		const html = renderDeployReport(fixtureData());
		expect(html).toContain("0.1.0+gdeadbee");
		expect(html).toContain("deadbeefdeadbeef");
		expect(html).toContain("hyperframes");
		expect(html).toContain("25,000,000"); // byte count, thousands-separated
		expect(html).toContain("@fontsource/inter");
		// Excluded table: name + the reason, both visible.
		expect(html).toContain("archify");
		expect(html).toContain("not shipped in this fixture deploy");
		// Gate rows.
		expect(html).toContain("verifyDualState");
		// Provider analysis section.
		expect(html).toContain("lm-studio");
		expect(html).toContain("google/gemma-4-12b");
		expect(html).toContain("glm-5.3");
	});

	test("is self-contained: no external stylesheet, script, or link fetches", () => {
		const html = renderDeployReport(fixtureData());
		expect(html).not.toContain("<link");
		expect(html).not.toMatch(/src="http/);
		expect(html).not.toMatch(/href="http/);
	});

	test("escapes HTML in extension names and exclusion reasons", () => {
		const html = renderDeployReport(
			fixtureData({
				excluded: [{ name: "<script>", package: "x", reason: "a <b>reason</b> & more" }],
			}),
		);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&lt;b&gt;reason&lt;/b&gt;");
	});
});

describe("renderDeployReportYaml — the machine-readable twin", () => {
	test("round-trips through a real YAML parser back to the input data", () => {
		const data = fixtureData({
			// exercise the optional runtime field too (undefined-skipping below
			// covers its absence, this covers its presence)
			runtime: { bunVersion: "1.4.0", platform: "darwin", arch: "arm64", bytes: 63_000_000, cached: true },
		});
		const back = Bun.YAML.parse(renderDeployReportYaml(data)) as DeployReportData;
		expect(back).toEqual(data);
	});

	test("always-double-quoted strings survive YAML's implicit-scalar edge cases", () => {
		const hostile = fixtureData({
			excluded: [
				{ name: "no", package: "yes: on #comment", reason: 'quote " backslash \\ newline\n colon: dash - [bracket]' },
			],
			gates: [{ id: "1", title: "- not: a #map", scope: "deploy", status: "pass" }],
		});
		const back = Bun.YAML.parse(renderDeployReportYaml(hostile)) as DeployReportData;
		expect(back.excluded[0].name).toBe("no");
		expect(back.excluded[0].package).toBe("yes: on #comment");
		expect(back.excluded[0].reason).toBe('quote " backslash \\ newline\n colon: dash - [bracket]');
		expect(back.gates[0].title).toBe("- not: a #map");
	});

	test("drops undefined optionals and renders empty collections as flow []/{}", () => {
		const data = fixtureData(); // no runtime field
		const yaml = renderDeployReportYaml(data);
		expect(yaml).not.toContain("runtime:");
		const back = Bun.YAML.parse(yaml) as DeployReportData;
		expect(back.runtime).toBeUndefined();
		expect(back).toEqual(data);
		// empty lists stay structurally empty, not omitted
		expect(back.extensions[0].copy).toEqual([]);
	});

	test("is deterministic — same data, byte-identical output", () => {
		expect(renderDeployReportYaml(fixtureData())).toBe(renderDeployReportYaml(fixtureData()));
	});
});

describe("renderOutRootIndex", () => {
	function seedOutRoot(): string {
		const outRoot = mkdtempSync(join(tmpdir(), "report-index-"));
		for (const v of ["0.1.0+gaaaaaaa", "0.1.0+gbbbbbbb"]) {
			const dir = join(outRoot, v);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "deploy.json"),
				`${JSON.stringify({ version: v, builtAt: "2026-08-21T00:00:00Z", sourceSha: v }, null, 2)}\n`,
			);
		}
		mkdirSync(join(outRoot, ".cores"), { recursive: true });
		return outRoot;
	}

	test("lists every version dir, marks current, links each report relatively", () => {
		const outRoot = seedOutRoot();
		try {
			symlinkSync("0.1.0+gbbbbbbb", join(outRoot, "current"));
			writeFileSync(join(outRoot, "0.1.0+gbbbbbbb", "deploy-report.html"), "<html></html>");
			writeFileSync(join(outRoot, "0.1.0+gbbbbbbb", "deploy-report.yaml"), "# yaml\n");
			const html = renderOutRootIndex(outRoot);
			expect(html).toContain("0.1.0+gaaaaaaa");
			expect(html).toContain("0.1.0+gbbbbbbb");
			// The current marker sits on bbbbbbb's row, never on aaaaaaa's.
			expect(html).toMatch(/gbbbbbbb[^\n]*current/s);
			expect(html).not.toMatch(/gaaaaaaa[^\n]*current/s);
			expect(html).toContain(`href="0.1.0+gbbbbbbb/deploy-report.html"`);
			// the yaml twin links beside the html when present, silently absent
			// for pre-yaml versions (aaaaaaa has none)
			expect(html).toContain(`href="0.1.0+gbbbbbbb/deploy-report.yaml"`);
			expect(html).not.toContain("0.1.0+gaaaaaaa/deploy-report.yaml");
		} finally {
			rmSync(outRoot, { recursive: true, force: true });
		}
	});

	test("a version dir without deploy.json is skipped, not fatal", () => {
		const outRoot = seedOutRoot();
		try {
			mkdirSync(join(outRoot, "0.1.0+garbage"));
			const html = renderOutRootIndex(outRoot);
			expect(html).toContain("0.1.0+gaaaaaaa");
			expect(html).not.toContain("garbage");
		} finally {
			rmSync(outRoot, { recursive: true, force: true });
		}
	});
});

describe("excludedExtensions — the not-shipped half of the registry", () => {
	test("the real registry: excluded names carry their reasons, shipped ones do not appear", () => {
		const text = readFileSync(join(BUN_APPS_DIR, "s2-agent", "s2-agent.registry.yaml"), "utf8");
		const excluded = excludedExtensions(text, { bunAppsDir: BUN_APPS_DIR });
		const names = excluded.map((e) => e.name);
		// Facts current at the time this test was written; the point is the
		// projection works on the real file, not pinning the exact set. Note
		// dynamic entries carry package-style names in the registry verbatim.
		expect(names).toContain("s2-agent-ext-movie-director");
		// file2md flipped into the deploy set with ticket 05 (smart-enhance).
		expect(names).not.toContain("file2md");
		expect(names).not.toContain("task");
		expect(names).not.toContain("hyperframes");
		for (const e of excluded) expect(e.reason.length).toBeGreaterThan(0);
	});
});
