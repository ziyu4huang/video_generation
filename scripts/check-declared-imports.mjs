#!/usr/bin/env node
// Declared-imports audit — ENFORCING (self-arc-20 ticket 04; was warn-only v1,
// issue #1645). Scans each bun-apps/*/ package's src/, extensions/ and root
// entry files for bare import specifiers not declared in its package.json
// (deps/devDeps/peerDeps/optionalDeps). Incidents of this class (#1589,
// #1591, #1642) were masked by hoisting variance across parallel worktrees and
// caught only late.
// Exit 0 clean / 1 findings / 2 usage. The baseline was cleaned in the same
// change that flipped enforcement, so the gate was born green.
// Allowances: bare Node builtins (node:module#builtinModules), self-deep-imports
// (@repo/<self>/... resolves to this very package), specs that are not
// module-id-shaped (string-artifact captures like ', ' from template literals),
// LINE-COMMENT lines (trimmed `//`, `*`, `/*` — prose like "Renamed from X"
// matched the import regex; same lesson as dep-guard's importedRepos), and the
// STRING_FIXTURE_ALLOWANCES map below for quoted literals that mimic import
// syntax by design (test fixtures for minified code).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = join(repoRoot, "bun-apps");
const ALWAYS_ALLOWED = new Set(["bun", "bun:test"]);
const NODE_BUILTINS = new Set(builtinModules);
const MODULE_ID_RE = /^[a-zA-Z@][a-zA-Z0-9@/._-]*$/;
const isRelative = (s) => s.startsWith(".") || s.startsWith("/");
const pkgName = (s) => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);

// Quoted literals that MIMIC import syntax on purpose (test fixtures for
// minified/bundled code). Key: repo-relative file; value: { specifier: reason }.
// Every entry MUST carry a reason naming the fixture — an allowance without a
// why is how this audit rots. Prefer fixing the fixture to adding entries.
const STRING_FIXTURE_ALLOWANCES = {
	"bun-apps/s2-agent-ext-devops/src/deploy/lib/ext-build.test.ts": {
		// Test TITLE quotes the minified shape `}from"spec"` — the regex reads
		// "…re-export with no space: }from"spec"" as an export-from. The actual
		// fixture code on the following lines uses real specifiers and is audited.
		spec: "test title quotes the minified `}from\"spec\"` shape (extractBareSpecifiers fixture)",
	},
};

/** Drop line-comment lines before the import regex runs — prose like
 *  "Renamed from "glm-lmstudio"" or `export{a}from"x"` inside a // comment
 *  matched as an import (dep-guard's importedRepos does the same skip). */
function stripLineComments(text) {
	return text
		.split("\n")
		.filter((raw) => {
			const t = raw.trim();
			return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
		})
		.join("\n");
}

function collectTsFiles(dir, out, depth = 0) {
	if (depth > 6) return out;
	let entries;
	try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		if (e.name === "node_modules" || e.name === "dist") continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) collectTsFiles(p, out, depth + 1);
		else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
	}
	return out;
}

const importRe = /(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;
function specifiersOf(text) {
	const out = new Set();
	for (const m of text.matchAll(importRe)) { const s = m[1] || m[2]; if (s) out.add(s); }
	return out;
}

const findings = [];
for (const app of readdirSync(appsDir, { withFileTypes: true })) {
	if (!app.isDirectory()) continue;
	const pkgPath = join(appsDir, app.name, "package.json");
	if (!existsSync(pkgPath)) continue;
	let pkg;
	try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { continue; }
	const declared = new Set([
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.devDependencies ?? {}),
		...Object.keys(pkg.peerDependencies ?? {}),
		...Object.keys(pkg.optionalDependencies ?? {}),
	]);
	const selfName = pkg.name;
	const files = [];
	for (const scope of ["src", "extensions"]) {
		const d = join(appsDir, app.name, scope);
		if (existsSync(d)) collectTsFiles(d, files);
	}
	for (const f of readdirSync(join(appsDir, app.name), { withFileTypes: true })) {
		if (f.isFile() && /\.(ts|mjs)$/.test(f.name) && !f.name.endsWith(".d.ts")) files.push(join(appsDir, app.name, f.name));
	}
	for (const file of files) {
		let text;
		try { text = readFileSync(file, "utf8"); } catch { continue; }
		const relFile = file.slice(repoRoot.length + 1);
		const allowance = STRING_FIXTURE_ALLOWANCES[relFile];
		for (const spec of specifiersOf(stripLineComments(text))) {
			if (isRelative(spec) || spec.startsWith("node:") || spec.startsWith("bun:") || spec.startsWith("data:")) continue;
			if (!MODULE_ID_RE.test(spec)) continue; // string artifacts, not module ids
			if (allowance && allowance[spec]) continue; // documented fixture literal (see map above)
			const name = pkgName(spec);
			if (ALWAYS_ALLOWED.has(name) || NODE_BUILTINS.has(name) || name === selfName || declared.has(name)) continue;
			findings.push(`${app.name}: ${relFile} imports '${spec}' — not declared in package.json`);
		}
	}
}

if (findings.length > 0) {
	console.error(`declared-imports audit: ${findings.length} UNDECLARED bare import(s)`);
	for (const f of findings) console.error(`  - ${f}`);
	console.error("  Declare the specifier in the package's package.json (deps/devDeps), or fix the import.");
	process.exit(1);
}
console.log("declared-imports audit: every bare import is declared (issue #1645 resolved; enforcing since self-arc-20)");
