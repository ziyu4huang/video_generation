#!/usr/bin/env bun
/**
 * Append a code-knowledge record (from a temp JSON file) to the shared KB.
 * Called by the gui-movie-director-self-improve workflow's Persist phase —
 * the workflow writes the record to a temp file (it can't import TS from its
 * sandboxed JS env), then this script performs the canonical append + index
 * update via lib/code-knowledge (single source of truth for the record shape).
 *
 * Usage: bun run scripts/code-knowledge-append.ts /tmp/code-knowledge-record.json
 */

import fs from "fs";
import { appendCodeRecord } from "../lib/code-knowledge";
import type { CodeKnowledgeRecord } from "../lib/code-knowledge";

const recordPath = process.argv[2];
if (!recordPath) {
  console.error("Usage: code-knowledge-append.ts <record-json-path>");
  process.exit(1);
}

const raw = fs.readFileSync(recordPath, "utf-8");
const record = JSON.parse(raw) as CodeKnowledgeRecord;
appendCodeRecord(record);
console.log("appended");
