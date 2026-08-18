#!/usr/bin/env node
// Declared-imports audit (warn-only v1) — issue #1645.
// Scans each bun-apps/*/ package's src/, extensions/ and root entry files for
// bare import specifiers not declared in its package.json (deps/devDeps/
// peerDeps/optionalDeps). Incidents of this class (#1589, #1591, #1642) were
// masked by hoisting variance across parallel worktrees and caught only late.
// WARN-ONLY v1: findings print; exit is always 0. Flip to exit 1 after the
// baseline is clean (tracked in #1645).
// Allowances: bare Node builtins (node:module#builtinModules), self-deep-imports
// (@repo/<self>/... resolves to this very package), and specs that are not
// module-id-shaped (string-artifact captures like ', ' from template literals).

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
		for (const spec of specifiersOf(text)) {
			if (isRelative(spec) || spec.startsWith("node:") || spec.startsWith("bun:") || spec.startsWith("data:")) continue;
			if (!MODULE_ID_RE.test(spec)) continue; // string artifacts, not module ids
			const name = pkgName(spec);
			if (ALWAYS_ALLOWED.has(name) || NODE_BUILTINS.has(name) || name === selfName || declared.has(name)) continue;
			findings.push(`${app.name}: ${file.slice(repoRoot.length + 1)} imports '${spec}' — not declared in package.json`);
		}
	}
}

if (findings.length > 0) {
	console.warn(`declared-imports audit (warn-only v1): ${findings.length} finding(s) — issue #1645`);
	for (const f of findings) console.warn(`  - ${f}`);
	console.warn("  (warn-only v1: exit 0. Clean the baseline then flip to exit 1 — see #1645.)");
	process.exit(0);
}
console.log("declared-imports audit: every bare import is declared (issue #1645)");
