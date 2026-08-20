#!/usr/bin/env node
/**
 * wire-publish-knowledge.mjs — injects the default-on `publishKnowledge` helper
 * and call into every self-improve workflow that doesn't have it.
 *
 * The generation workflows (mlx-image, mlx-ltx, gui-*, mlx/gui review-optimize,
 * lora-quality-gate) are publish-only per the Step-4 decision: they WRITE to the
 * graph but don't READ (their content-tuning tags cross with the code-health graph
 * on the wrong axis).
 *
 * This script ensures each workflow:
 *   1. Has the publishKnowledge helper function defined (copied from _shared-patterns.md).
 *   2. Calls `await publishKnowledge(KB_FILE, <workflow_name_var>)` after each
 *      `await extractKnowledge(KB_FILE, ...)` call.
 *
 * Usage: bun scripts/wire-publish-knowledge.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WF_DIR = join(__dirname, "..", ".claude", "workflows");
const dryRun = process.argv.includes("--dry-run");

const PUBLISH_CALL_MARKER = "await publishKnowledge(KB_FILE";
const EXTRACT_CALL_MARKER = "await extractKnowledge(KB_FILE";
const HELPER_FUNC_NAME = "async function publishKnowledge(";
const EXTRACT_FUNC_NAME = "async function extractKnowledge(";

// ─── Read publishKnowledge helper from _shared-patterns.md ──────────────────

function extractPublishHelper() {
  const shared = readFileSync(join(WF_DIR, "_shared-patterns.md"), "utf8");
  // Match the publishKnowledge function block (multiline).
  const m = shared.match(
    /^(\/\/ ── publishKnowledge[\s\S]*?^async function publishKnowledge\(kbFile, workflowName\) \{\n[\s\S]*?^\}[\t ]*(?:\n|$))/m
  );
  if (!m) {
    console.error("ERROR: Could not extract publishKnowledge helper from _shared-patterns.md");
    process.exit(1);
  }
  return m[1];
}

const PUBLISH_HELPER = extractPublishHelper();

// ─── Helper: find the end of a function by tracking brace depth ────────────

function findFunctionEnd(content, startIdx) {
  // Find the opening { of the function body.
  const braceIdx = content.indexOf("{", startIdx);
  if (braceIdx === -1) return -1;
  let depth = 1;
  let i = braceIdx + 1;
  while (depth > 0 && i < content.length) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) return i + 1; // right after the closing }
    }
    i++;
  }
  return -1;
}

// ─── Helper: determine the best workflow name variable in a file ───────────

function detectWorkflowNameVar(content) {
  // Check meta.name first (used in s2-agent-ext-flux2 style workflows).
  if (content.includes("meta.name")) return "meta.name";
  // Check explicit NAME constant.
  const nameMatch = content.match(/(?:const\s+)?(NAME|_WF_NAME)\s*=\s*["']/);
  if (nameMatch) return nameMatch[1];
  return null;
}

// ─── Main ──────────────────────────────────────────────────────────────────

const files = readdirSync(WF_DIR).filter((f) => f.endsWith(".js"));
let wired = 0;
let skipped = 0;

for (const file of files) {
  const path = join(WF_DIR, file);
  let content = readFileSync(path, "utf8");
  const original = content;

  // Skip if already fully wired.
  if (content.includes(PUBLISH_CALL_MARKER)) {
    console.log(`✓ ${file} — already wired`);
    skipped++;
    continue;
  }

  // Skip files with no knowledge infrastructure.
  if (!content.includes(EXTRACT_CALL_MARKER) && !content.includes("extractKnowledge")) {
    console.log(`- ${file} — no knowledge infrastructure (skip)`);
    skipped++;
    continue;
  }

  const nameVar = detectWorkflowNameVar(content);
  if (!nameVar) {
    console.log(`⚠ ${file} — cannot determine workflow name variable (skip)`);
    skipped++;
    continue;
  }

  // ── 1. Inject publishKnowledge helper function ────────────────────────
  if (!content.includes(HELPER_FUNC_NAME)) {
    // Find the extractKnowledge function definition.
    const extractIdx = content.search(
      /^async function extractKnowledge\(kbFile, runId, runResult, runReflection, /m
    );
    if (extractIdx === -1) {
      console.log(`⚠ ${file} — cannot find extractKnowledge function (try manual)`);
      skipped++;
      continue;
    }

    const funcEnd = findFunctionEnd(content, extractIdx);
    if (funcEnd === -1) {
      console.log(`⚠ ${file} — cannot find end of extractKnowledge function (try manual)`);
      skipped++;
      continue;
    }

    // Insert the publishKnowledge helper after the extractKnowledge function.
    // Add a blank line before the helper.
    const insertPos = funcEnd;
    const before = content.slice(0, insertPos);
    const after = content.slice(insertPos);
    content = before + "\n" + PUBLISH_HELPER + "\n" + after;
    console.log(`  + ${file}: injected publishKnowledge helper after extractKnowledge`);
  } else {
    console.log(`  ~ ${file}: publishKnowledge helper already present`);
  }

  // ── 2. Inject publishKnowledge call(s) after extractKnowledge call(s) ──
  const extractCalls = [...content.matchAll(
    /^(await extractKnowledge\(KB_FILE[^)]*\)[^)]*\)[\s\S]*?;)[\t ]*(?:\n|$)/gm
  )];
  
  // Simpler approach: find each line containing `await extractKnowledge(KB_FILE`
  // and insert the publishKnowledge call on the next line.
  let callCount = 0;
  let result = "";
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    result += lines[i] + "\n";
    if (lines[i].includes(EXTRACT_CALL_MARKER) && !lines[i].includes(PUBLISH_CALL_MARKER)) {
      // This is an extractKnowledge( call — add publishKnowledge call after.
      // Check if the next line already has it (idempotency).
      const nextLine = i + 1 < lines.length ? lines[i + 1] : "";
      if (!nextLine.includes(PUBLISH_CALL_MARKER)) {
        // Determine comment/indent from the current line.
        const indent = lines[i].match(/^(\s*)/)[1];
        result += `${indent}await publishKnowledge(KB_FILE, ${nameVar})\n`;
        callCount++;
      }
    }
  }
  content = result;

  if (callCount === 0 && !content.includes(PUBLISH_CALL_MARKER)) {
    console.log(`⚠ ${file} — no extractKnowledge calls found to wire after`);
    skipped++;
    continue;
  }

  // ── 3. Write the modified file ────────────────────────────────────────
  if (content === original) {
    console.log(`  = ${file} — no changes needed`);
    skipped++;
    continue;
  }

  if (dryRun) {
    console.log(`  → ${file}: would add ${callCount} publishKnowledge call(s) + helper (dry-run)`);
  } else {
    writeFileSync(path, content, "utf8");
    console.log(`  ✓ ${file}: wired ${callCount} publishKnowledge call(s)`);
  }
  wired++;
}

console.log(`\n${dryRun ? "(dry-run) " : ""}Done. ${wired} file(s) wired, ${skipped} skipped.`);
