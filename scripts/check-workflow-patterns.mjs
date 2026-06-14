#!/usr/bin/env node
// check-workflow-patterns.mjs — drift guard for .claude/workflows/*.js
//
// The workflow runtime has no import/require, so shared helpers (saveHistory,
// markPhase, reliableWrite) are copy-pasted into every workflow. A schema bug in
// one (e.g. the saveHistory 0-bytes bug) silently exists in all siblings until
// someone remembers to sweep them. This script is the enforcement.
//
// Hard rules (exit 1 on violation):
//   1. meta.name must equal the filename without ".js".
//   2. Every workflow with a "persist-history" agent MUST carry a `schema:` in
//      that agent's options object. A schema-less persist agent returns text,
//      so callers reading .bytes/.written get undefined -> the 0-bytes bug.
//        (Per workflow-agent-schema-for-parsed-results memory.)
//
// Soft report (never exits, just surfaces drift for review):
//   - Normalized persist-history schema per workflow, grouped. A group of size 1
//     is flagged "unique schema - verify intentional" so legitimate variation
//     (e.g. schema-self-improve gates on .written not .bytes) is VISIBLE but
//     not false-failed.
//   - Coverage matrix: which workflows define saveHistory / markPhase /
//     reliableWrite. Absence is reported, not enforced (not every workflow needs
//     all three).
//
// Usage:  node scripts/check-workflow-patterns.mjs
// Exit:   0 clean, 1 hard-rule violation.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WF_DIR = resolve(__dirname, "..", ".claude", "workflows");

// --- helpers ----------------------------------------------------------------

function braceMatch(src, openIdx) {
  // Given index of an opening "{", return index of its matching "}" (handles
  // string literals + template literals so braces inside strings don't confuse
  // depth tracking). Returns -1 if unbalanced.
  let depth = 0;
  let i = openIdx;
  let quote = null;
  let inTemplate = false;
  let templateDepth = 0;
  while (i < src.length) {
    const ch = src[i];
    const prev = src[i - 1];
    if (quote) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1; continue;
    }
    if (inTemplate) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`" && templateDepth === 0) inTemplate = false;
      else if (ch === "$" && src[i + 1] === "{") { templateDepth++; i += 2; continue; }
      else if (ch === "}" && templateDepth > 0) templateDepth--;
      i += 1; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i += 1; continue; }
    if (ch === "`") { inTemplate = true; i += 1; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i; }
    i += 1;
  }
  return -1;
}

function nearestOpenBraceBack(src, fromIdx) {
  // Walk backward from fromIdx to the nearest "{" that opens an object/opts.
  // Skip braces that are closing "}" (we want the opener at depth 0 relative
  // to the walk). Naive: track depth backward.
  let depth = 0;
  for (let i = fromIdx; i >= 0; i--) {
    const ch = src[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

function extractMetaName(src) {
  const m = src.match(/export\s+const\s+meta\s*=\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

function findPersistHistoryOpts(src) {
  // Find every "persist-history" anchor; for each, locate the enclosing options
  // object (nearest "{" back) and the enclosing agent( call, and return the raw
  // text plus whether the agent's return value is ASSIGNED (consumed) vs awaited
  // and discarded.
  const results = [];
  let searchFrom = 0;
  while (true) {
    const idx = src.indexOf("persist-history", searchFrom);
    if (idx === -1) break;
    searchFrom = idx + 1;
    const objStart = nearestOpenBraceBack(src, idx);
    if (objStart === -1) continue;
    const objEnd = braceMatch(src, objStart);
    if (objEnd === -1) continue;
    // find the enclosing agent( call opener before the options object
    const agentOpen = src.lastIndexOf("agent(", objStart);
    const assigned = isReturnAssigned(src, agentOpen);
    results.push({ idx, objStart, objEnd, raw: src.slice(objStart, objEnd + 1), assigned });
  }
  return results;
}

function isReturnAssigned(src, agentIdx) {
  // True if the agent()'s return is assigned to a variable (consumed), e.g.
  // `const persist = await agent(...)` or `... = await agent(...)`. False for a
  // bare `await agent(...)` whose return is discarded (pure side-effect write).
  // Heuristic: the ~40 chars before agent(, whitespace-stripped, end with "=await".
  if (agentIdx === -1) return false;
  const prefix = src.slice(Math.max(0, agentIdx - 40), agentIdx).replace(/\s+/g, "");
  return /=await$/.test(prefix) || /=$/.test(prefix);
}

function extractSchemaFromOpts(raw) {
  // Within an options-object raw text, find "schema:" and brace-match its value.
  const schemaIdx = raw.search(/\bschema\s*:/);
  if (schemaIdx === -1) return null; // schema-less
  const openRel = raw.indexOf("{", schemaIdx);
  if (openRel === -1) return null;
  const openAbs = raw.indexOf("{", schemaIdx); // absolute within raw
  // braceMatch works on the raw string with the same indices
  const closeRel = braceMatch(raw, openRel);
  if (closeRel === -1) return null;
  return raw.slice(openRel, closeRel + 1);
}

function normalize(s) {
  // strip all whitespace for identity comparison (keys are unquoted JS literals,
  // so we cannot JSON.parse; whitespace-insensitive string compare suffices).
  return s.replace(/\s+/g, "");
}

// --- main -------------------------------------------------------------------

const files = readdirSync(WF_DIR)
  .filter((f) => f.endsWith(".js"))
  .sort();

const violations = [];
const rows = []; // { file, metaName, persistCount, schemaless, schemaNorm, hasSaveHistory, hasMarkPhase, hasReliableWrite }

for (const file of files) {
  const path = join(WF_DIR, file);
  const src = readFileSync(path, "utf8");
  const metaName = extractMetaName(src);

  const persistOpts = findPersistHistoryOpts(src);
  const persistSchemas = persistOpts.map((o) => extractSchemaFromOpts(o.raw));
  const schemalessAssigned = persistOpts.filter((o, i) => o.assigned && persistSchemas[i] === null).length;
  const schemalessDiscarded = persistOpts.filter((o, i) => !o.assigned && persistSchemas[i] === null).length;

  // meta.name <-> filename
  if (!metaName) {
    violations.push(`${file}: no export const meta = { name: ... } found`);
  } else if (metaName !== file.replace(/\.js$/, "")) {
    violations.push(`${file}: meta.name "${metaName}" != filename "${file.replace(/\.js$/, "")}"`);
  }

  // a persist-history agent that CONSUMES its return (assigned) MUST carry a
  // schema — otherwise agent() returns text and .bytes/.written parse to
  // undefined/0 (the 0-bytes bug). A discarded return (bare `await agent(...)`)
  // is a pure side-effect write and may legitimately be schema-less.
  if (schemalessAssigned > 0) {
    violations.push(`${file}: ${schemalessAssigned} persist-history agent(s) consume the return value but are MISSING schema: -> 0-bytes bug class`);
  }

  rows.push({
    file,
    metaName,
    persistCount: persistOpts.length,
    schemalessAssigned,
    schemalessDiscarded,
    schemaNorms: persistSchemas.map((s) => (s ? normalize(s) : null)),
    schemaLabels: persistSchemas.map((s) => (s ? normalize(s).slice(0, 12) + "..." : "NONE")),
    hasSaveHistory: /async function saveHistory\s*\(/.test(src),
    hasMarkPhase: /function markPhase\s*\(/.test(src),
    hasReliableWrite: /async function reliableWrite\s*\(/.test(src),
  });
}

// --- report -----------------------------------------------------------------

const W = 46;
const trim = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

console.log("\n═══ meta.name ↔ filename ═══");
console.log(rows.every((r) => r.metaName === r.file.replace(/\.js$/, "")) ? "✓ all match" : "✗ mismatch (see violations)");

console.log("\n═══ persist-history schema coverage ═══");
console.log("file".padEnd(W) + "persist  schema");
for (const r of rows) {
  const persist = `${r.persistCount}`;
  let schema;
  if (r.schemalessAssigned > 0) schema = `✗ ${r.schemalessAssigned} schema-less (CONSUMED)`;
  else if (r.schemalessDiscarded > 0) schema = `~ ${r.schemalessDiscarded} schema-less (discarded ok)`;
  else if (r.persistCount) schema = "✓ has schema";
  else schema = "— none";
  console.log(trim(r.file, W).padEnd(W) + persist.padEnd(8) + schema);
}

console.log("\n═══ persist-history schema drift (grouped) ═══");
const groups = new Map(); // norm -> [files]
for (const r of rows) {
  for (const n of r.schemaNorms) {
    if (n === null) continue;
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(r.file);
  }
}
const normToSig = new Map();
for (const r of rows) for (const n of r.schemaNorms) if (n) normToSig.set(n, r.schemaLabels[r.schemaNorms.indexOf(n)]);
let groupIdx = 0;
for (const [norm, members] of groups) {
  groupIdx++;
  const sig = normToSig.get(norm) || norm.slice(0, 16);
  const tag = members.length === 1 ? "  ⚠ UNIQUE — verify intentional" : "";
  console.log(`  group ${groupIdx} (${members.length} workflow${members.length > 1 ? "s" : ""})  ${sig}${tag}`);
  for (const m of members) console.log(`     - ${m}`);
}

console.log("\n═══ shared helper coverage ═══");
console.log("file".padEnd(W) + "saveHist  markPhase  reliableWrite");
for (const r of rows) {
  const sh = (r.hasSaveHistory ? "✓" : "—").padEnd(8);
  const mp = (r.hasMarkPhase ? "✓" : "—").padEnd(10);
  const rw = r.hasReliableWrite ? "✓" : "—";
  console.log(trim(r.file, W).padEnd(W) + sh + mp + rw);
}

// --- verdict ----------------------------------------------------------------

if (violations.length > 0) {
  console.log("\n═══ ✗ HARD-RULE VIOLATIONS ═══");
  for (const v of violations) console.log("  " + v);
  console.log(`\n${violations.length} violation(s). Fix the above.\n`);
  process.exit(1);
}
console.log("\n═══ ✓ no hard-rule violations ═══\n");
process.exit(0);
