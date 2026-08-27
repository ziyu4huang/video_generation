/**
 * deploy-report — the per-deploy HTML report and its YAML twin.
 *
 * Every deploy writes <outRoot>/<version>/deploy-report.html (immutable with
 * the tree it describes, written after the gates pass and before the freeze)
 * plus deploy-report.yaml — the SAME DeployReportData serialized as YAML for
 * machine consumption (diffing two deploys, tooling over the gate matrix)
 * — plus <outRoot>/index.html listing the retained versions. All files are
 * single-file self-contained: inline CSS only, zero external references —
 * the same offline discipline the deploy tree itself is gated on (Gate 5).
 *
 * The report freezes four analyses that used to be reconstructible only by
 * re-reading the source registry after the fact:
 *   1. the included/excluded decision table, with the excludeReason verbatim;
 *   2. per-extension vendored-closure stats (closure count / pruned platform
 *      binaries / deliberate vendorExclude drops) from each ext.json;
 *   3. the gate matrix (which gate ran, per-ext or whole-deploy, duration);
 *   4. the BAKED-IN provider/model layers of the core being deployed — the
 *      PROVIDERS catalog and BUILTIN_MODEL_DEFAULT — imported from the real
 *      s2-agent sources, never re-declared here.
 *
 * collectModelFacts() imports source modules rather than parsing text: the
 * workspace import is typechecked by the repo's cross-package tsc gate, so a
 * rename in s2-agent breaks this file's build instead of silently blanking a
 * report section the way a regex over the source would.
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS, BUILTIN_MODEL_DEFAULT } from "../../../../s2-agent/src/pre-load-providers.ts";
import { APP_NAME } from "./app-name.ts";

// ─── Data shapes ──────────────────────────────────────────────────────────────

export interface GateRecord {
	id: string;
	title: string;
	scope: "per-ext" | "deploy";
	/** "skip" = deliberately not run for this tree (crossos t05: non-host targets skip the boot gates; t06 owns that channel). */
	status: "pass" | "fail" | "skip";
	ms?: number;
	note?: string;
}

export interface ReportExtension {
	name: string;
	package: string;
	order: number;
	bytes: number;
	skills: string[];
	copy: string[];
	vendor: string[];
	externals: string[];
	vendorExclude: string[];
	closure: { count: number; pruned: string[]; excluded: string[] };
}

export interface ReportExcluded {
	name: string;
	package: string;
	reason: string;
}

export interface CatalogModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
}

export interface CatalogProvider {
	id: string;
	baseUrl: string;
	api: string;
	/** "literal" = hardcoded key (local servers); otherwise the env var name. */
	apiKey: "literal" | string;
	models: CatalogModel[];
}

export interface ModelFacts {
	catalog: CatalogProvider[];
	defaultModel: { provider: string; model: string; thinking: string; obsidianSubagentFloor: string };
}

export interface DeployReportData {
	version: string;
	builtAt: string;
	sourceSha: string;
	bunVersion: string;
	/** The registry module this deploy projected from (registry-code-as-config t03; was configPath). */
	registryModule: string;
	outRoot: string;
	target: string;
	freeze: boolean;
	current: boolean;
	core: { bytes: number; cached: boolean };
	/** The shipped bun runtime (bin/bun) — present since the bundle core (ticket 02). */
	runtime?: { bunVersion: string; platform: string; arch: string; bytes: number; cached: boolean };
	gates: GateRecord[];
	extensions: ReportExtension[];
	excluded: ReportExcluded[];
	providers: ModelFacts;
}

// ─── Provider/model facts (source-level, deterministic) ───────────────────────

/** Project the three baked-in layers of s2-agent into report-facing facts. */
export function collectModelFacts(): ModelFacts {
	const catalog: CatalogProvider[] = Object.entries(PROVIDERS).map(([id, p]) => ({
		id,
		baseUrl: p.baseUrl,
		api: p.api,
		apiKey: typeof p.apiKey === "string" ? "literal" : p.apiKey.env,
		models: p.models.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: [...m.input],
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
	}));
	return {
		catalog,
		defaultModel: {
			provider: BUILTIN_MODEL_DEFAULT.provider,
			model: BUILTIN_MODEL_DEFAULT.model,
			thinking: BUILTIN_MODEL_DEFAULT.thinking,
			obsidianSubagentFloor: BUILTIN_MODEL_DEFAULT.obsidianSubagentFloor,
		},
	};
}

// ─── HTML rendering ───────────────────────────────────────────────────────────

function esc(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function fmtBytes(n: number): string {
	return n.toLocaleString("en-US");
}

const REPORT_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; margin: 0 auto; max-width: 1080px; padding: 2rem 1.5rem 4rem; }
h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
h2 { font-size: 1.1rem; margin-top: 2.25rem; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); padding-bottom: 0.3rem; }
table { border-collapse: collapse; width: 100%; margin-top: 0.75rem; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 0.3rem 0.6rem; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); vertical-align: top; }
th { font-weight: 600; }
code { font: 0.92em ui-monospace, "SF Mono", Menlo, monospace; background: color-mix(in srgb, currentColor 8%, transparent); padding: 0.05rem 0.3rem; border-radius: 4px; }
.meta { color: color-mix(in srgb, currentColor 65%, transparent); font-size: 0.92rem; }
.pass { color: #1a7f37; }
.fail { color: #cf222e; font-weight: 600; }
.kv td:first-child { white-space: nowrap; color: color-mix(in srgb, currentColor 65%, transparent); width: 14rem; }
details summary { cursor: pointer; margin-top: 0.4rem; }
ul.tight { margin: 0.25rem 0; padding-left: 1.2rem; }
`;

function gateRow(g: GateRecord): string {
	const ms = g.ms === undefined ? "" : `${g.ms.toFixed(0)} ms`;
	const note = g.note === undefined || g.note === "" ? "—" : esc(g.note);
	return `<tr><td>${esc(g.id)}</td><td><code>${esc(g.title)}</code></td><td>${esc(g.scope)}</td>` +
		`<td class="${g.status}">${g.status}</td><td>${esc(ms)}</td><td>${note}</td></tr>`;
}

function extRow(e: ReportExtension): string {
	const lists = [
		["skills", e.skills],
		["copy", e.copy],
		["vendor", e.vendor],
		["externals", e.externals],
		["vendorExclude", e.vendorExclude],
	] as const;
	const parts = lists.filter(([, v]) => v.length > 0).map(([k, v]) => `${k}: ${v.join(", ")}`);
	const closureDetail =
		e.closure.excluded.length > 0 || e.closure.pruned.length > 0
			? `<details><summary>closure ${e.closure.count} — ${e.closure.excluded.length} excluded, ${e.closure.pruned.length} pruned</summary>` +
				`<p class="meta">deliberately excluded (vendorExclude):</p><ul class="tight">${e.closure.excluded.map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>` +
				`<p class="meta">pruned (not installed / wrong platform):</p><ul class="tight">${e.closure.pruned.map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>` +
				`</details>`
			: `closure ${e.closure.count}`;
	return `<tr><td>${esc(e.name)}</td><td>${e.order}</td><td>${fmtBytes(e.bytes)}</td><td>${closureDetail}</td>` +
		`<td>${parts.length > 0 ? parts.map(esc).join("<br>") : "—"}</td></tr>`;
}

function providerSection(facts: ModelFacts): string {
	const catalogRows = facts.catalog
		.map(
			(p) =>
				`<tr><td><code>${esc(p.id)}</code></td><td><code>${esc(p.baseUrl)}</code></td><td>${esc(p.api)}</td>` +
				`<td>${esc(p.apiKey)}</td><td>${p.models.map((m) => `<code>${esc(m.id)}</code>`).join("<br>")}</td></tr>`,
		)
		.join("\n");
	const d = facts.defaultModel;
	return `
<h2>Providers &amp; models — baked into this core</h2>
<p class="meta">Source-level facts from <code>s2-agent/src/pre-load-providers.ts</code>
(PROVIDERS catalog and BUILTIN_MODEL_DEFAULT), as baked into the deployed core bundle. User-side <code>~/.pi/agent</code> configuration is
deliberately NOT reflected here — this section says what the artifact ships, not what one machine overlays on it.</p>

<h3>Pre-load provider catalog (always registered)</h3>
<table>
<tr><th>provider</th><th>baseUrl</th><th>api</th><th>apiKey</th><th>models</th></tr>
${catalogRows}
</table>

<h3>Built-in default model</h3>
<table class="kv">
<tr><td>provider</td><td><code>${esc(d.provider)}</code></td></tr>
<tr><td>model</td><td><code>${esc(d.model)}</code></td></tr>
<tr><td>thinking</td><td>${esc(d.thinking)}</td></tr>
<tr><td>obsidian subagent floor</td><td><code>${esc(d.obsidianSubagentFloor)}</code></td></tr>
<tr><td>precedence</td><td>explicit flag &gt; <code>PI_MODEL</code>/<code>PI_PROVIDER</code>/<code>PI_THINKING</code> &gt; <code>~/.pi/agent/settings.json</code> &gt; built-in (fill-gaps — personal config always wins)</td></tr>
</table>`;
}

/** Render the version-dir report. Self-contained HTML, no external references. */
export function renderDeployReport(data: DeployReportData): string {
	// "skip" gates (non-host targets) don't fail the banner — but the wording
	// must not claim they ran. A skipped gate is a topology statement recorded
	// with its reason, never a silent pass.
	const failed = data.gates.some((g) => g.status === "fail");
	const skipped = data.gates.some((g) => g.status === "skip");
	const gateSummary = failed ? '<span class="fail">FAILED</span>' : skipped ? "pass (with skips)" : '<span class="pass">all pass</span>';
	const totalExtBytes = data.extensions.reduce((n, e) => n + e.bytes, 0);
	const excludedRows = data.excluded
		.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.package)}</td><td>${esc(x.reason)}</td></tr>`)
		.join("\n");
	const extRows = data.extensions.map(extRow).join("\n");
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>s2-agent-sh deploy report — ${esc(data.version)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<h1>deploy-report — <code>${esc(data.version)}</code></h1>
<p class="meta">${data.extensions.length} extensions included · ${data.excluded.length} excluded · gates ${gateSummary}</p>

<h2>Overview</h2>
<table class="kv">
<tr><td>version</td><td><code>${esc(data.version)}</code></td></tr>
<tr><td>built at</td><td>${esc(data.builtAt)}</td></tr>
<tr><td>source sha</td><td><code>${esc(data.sourceSha)}</code></td></tr>
<tr><td>launcher</td><td>${esc(data.target)}/${esc(APP_NAME)}.sh</td></tr>
<tr><td>registry</td><td><code>${esc(data.registryModule)}</code></td></tr>
<tr><td>bun</td><td>${esc(data.bunVersion)}</td></tr>
<tr><td>core</td><td>${fmtBytes(data.core.bytes)} ${data.core.cached ? "(cached hardlink)" : "(fresh bundle)"} — bun-run ESM bundle</td></tr>
${data.runtime ? `<tr><td>runtime (bin/bun)</td><td>${esc(data.runtime.bunVersion)} ${esc(data.runtime.platform)}/${esc(data.runtime.arch)}, ${fmtBytes(data.runtime.bytes)} ${data.runtime.cached ? "(cached hardlink)" : "(fresh copy)"}</td></tr>` : ""}
<tr><td>extensions total</td><td>${fmtBytes(totalExtBytes)}</td></tr>
<tr><td>freeze / current</td><td>${data.freeze ? "frozen (a-w)" : "writable"} · ${data.current ? "current → this version" : "current untouched"}</td></tr>
</table>

<h2>Gate matrix</h2>
<table>
<tr><th>gate</th><th>check</th><th>scope</th><th>status</th><th>time</th><th>note</th></tr>
${data.gates.map(gateRow).join("\n")}
</table>
<p class="meta">Per-ext gates (1, 1b, 2, 4) ran inside each extension's build; a failed gate aborts the deploy before this
report is written, so every row above records a passing run's timings.</p>

<h2>Extensions — included (${data.extensions.length})</h2>
<table>
<tr><th>extension</th><th>order</th><th>bytes</th><th>vendored closure</th><th>deploy fields</th></tr>
${extRows}
</table>

<h2>Extensions — excluded (${data.excluded.length})</h2>
<table>
<tr><th>extension</th><th>package</th><th>reason (registry excludeReason)</th></tr>
${excludedRows}
</table>
${providerSection(data.providers)}
</body>
</html>
`;
}

// ─── YAML rendering (the machine-readable twin) ───────────────────────────────

/**
 * Every string is double-quoted, unconditionally: YAML's implicit-scalar edge
 * cases (": ", " #", leading "-", "no"/"yes"-shaped tokens, unicode) all live
 * in exactly the fields this report carries — paths, reasons, gate titles —
 * and a report that only parses until the first odd string is worse than a
 * slightly noisier one that always round-trips.
 */
function yamlQuote(s: string): string {
	return `"${s
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		.replaceAll("\t", "\\t")
		.replaceAll("\r", "\\r")}"`;
}

function yamlScalar(v: string | number | boolean): string {
	return typeof v === "string" ? yamlQuote(v) : String(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Emit a plain-JSON-shaped value as block-style YAML lines at `level`.
 * Insertion order is preserved (the data objects are built as literals), so
 * output is deterministic run over run. Optional (`undefined`) fields drop.
 */
function emitYaml(value: unknown, level: number): string[] {
	const pad = "  ".repeat(level);
	const lines: string[] = [];
	if (Array.isArray(value)) {
		for (const item of value) {
			if (isPlainObject(item)) {
				// "- key: v" head line: emit the mapping one level deeper, then
				// swap the first line's pad for the sequence dash — the head's
				// content lands where the deeper pad put it, and the tail lines
				// keep that pad, which is exactly YAML's inline-item shape.
				const nested = emitYaml(item, level + 1);
				if (nested.length === 0) {
					lines.push(`${pad}- {}`);
					continue;
				}
				lines.push(`${pad}- ${nested[0].slice(pad.length + 2)}`, ...nested.slice(1));
			} else {
				lines.push(`${pad}- ${yamlScalar(item as string | number | boolean)}`);
			}
		}
		return lines;
	}
	if (!isPlainObject(value)) return [`${pad}${yamlScalar(value as string | number | boolean)}`];
	for (const [k, v] of Object.entries(value)) {
		if (v === undefined) continue;
		const key = /^[A-Za-z0-9_-]+$/.test(k) ? k : yamlQuote(k);
		if (Array.isArray(v)) {
			if (v.length === 0) lines.push(`${pad}${key}: []`);
			else lines.push(`${pad}${key}:`, ...emitYaml(v, level));
		} else if (isPlainObject(v)) {
			const nested = emitYaml(v, level + 1);
			if (nested.length === 0) lines.push(`${pad}${key}: {}`);
			else lines.push(`${pad}${key}:`, ...nested);
		} else {
			lines.push(`${pad}${key}: ${yamlScalar(v as string | number | boolean)}`);
		}
	}
	return lines;
}

/** Render the version-dir report's YAML twin — same DeployReportData, block-style YAML. */
export function renderDeployReportYaml(data: DeployReportData): string {
	return (
		"# s2-agent-sh deploy-report — machine-readable twin of deploy-report.html.\n" +
		"# Same DeployReportData, YAML serialization; written and frozen together.\n" +
		`${emitYaml(data, 0).join("\n")}\n`
	);
}

// ─── outRoot index ────────────────────────────────────────────────────────────

interface IndexEntry {
	version: string;
	builtAt: string;
	sourceSha: string;
	isCurrent: boolean;
	hasReport: boolean;
	hasYaml: boolean;
}

const VERSION_DIR = /^\d+\.\d+\.\d+\+g[0-9a-f]+$/;

/**
 * Scan the outRoot for retained version dirs. Anything that is not a
 * version-shaped dir with a readable deploy.json is skipped (staging dirs,
 * .cores, .reloc-* temp trees, a half-written dir) — the index is a view over
 * provenance, never a gate.
 */
function scanOutRoot(outRoot: string): { entries: IndexEntry[]; current: string | null } {
	let current: string | null = null;
	const currentLink = join(outRoot, "current");
	if (existsSync(currentLink)) {
		try {
			current = readlinkSync(currentLink);
		} catch {
			current = null; // a real dir, not a symlink — nothing to mark
		}
	}
	const entries: IndexEntry[] = [];
	for (const name of readdirSync(outRoot)) {
		if (!VERSION_DIR.test(name)) continue;
		const deployJson = join(outRoot, name, "deploy.json");
		if (!existsSync(deployJson)) continue;
		try {
			const j = JSON.parse(readFileSync(deployJson, "utf8")) as {
				version?: string;
				builtAt?: string;
				sourceSha?: string;
			};
			if (!j.version) continue;
			entries.push({
				version: j.version,
				builtAt: j.builtAt ?? "",
				sourceSha: j.sourceSha ?? "",
				isCurrent: current === name || current === j.version,
				hasReport: existsSync(join(outRoot, name, "deploy-report.html")),
				hasYaml: existsSync(join(outRoot, name, "deploy-report.yaml")),
			});
		} catch {
			// unreadable deploy.json — skip, not fatal
		}
	}
	entries.sort((a, b) => b.builtAt.localeCompare(a.builtAt));
	return { entries, current };
}

/** Render <outRoot>/index.html — the retained-version table linking each report. */
export function renderOutRootIndex(outRoot: string): string {
	const { entries } = scanOutRoot(outRoot);
	const rows = entries
		.map((e) => {
			const report = e.hasReport
				? `<a href="${esc(e.version)}/deploy-report.html">html</a>${e.hasYaml ? ` · <a href="${esc(e.version)}/deploy-report.yaml">yaml</a>` : ""}`
				: "—";
			return `<tr><td><code>${esc(e.version)}</code></td><td>${esc(e.builtAt)}</td><td><code>${esc(e.sourceSha.slice(0, 8))}</code></td>` +
				`<td>${e.isCurrent ? '<span class="pass">current</span>' : ""}</td><td>${report}</td></tr>`;
		})
		.join("\n");
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>s2-agent-sh deploys</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<h1>s2-agent-sh deploy index</h1>
<p class="meta">${entries.length} retained version(s) under <code>${esc(outRoot)}</code> · open a version's deploy-report.html for what shipped and why.</p>
<table>
<tr><th>version</th><th>built at</th><th>source</th><th></th><th>report</th></tr>
${rows}
</table>
</body>
</html>
`;
}

// ─── Writers (used by deploy.ts) ──────────────────────────────────────────────

/** Write the version-dir report; returns its path. */
export function writeDeployReport(dir: string, data: DeployReportData): string {
	const p = join(dir, "deploy-report.html");
	writeFileSync(p, renderDeployReport(data));
	return p;
}

/** Write the report's YAML twin next to the HTML; returns its path. */
export function writeDeployReportYaml(dir: string, data: DeployReportData): string {
	const p = join(dir, "deploy-report.yaml");
	writeFileSync(p, renderDeployReportYaml(data));
	return p;
}

/** Write/refresh <outRoot>/index.html from the version dirs on disk. */
export function writeOutRootIndex(outRoot: string): string {
	const p = join(outRoot, "index.html");
	writeFileSync(p, renderOutRootIndex(outRoot));
	return p;
}
