// MLX Movie Director — Models Assistant
//
// Intelligent model management workflow that verifies manifest schemas,
// inventories all models, and produces actionable suggestions after
// conversion or for general housekeeping.
//
// Token self-reflection (2026-06-07):
//   • Sonnet (baseline):  4 agents, 101K tokens, 15 tool uses,  94s
//   • Haiku+Explore:      4 agents, 184K tokens, 50 tool uses, 648s
//   → Sonnet is MORE cost-effective: fewer tool calls, faster, reliable schemas.
//   → Only Resolve phase agents use haiku (simple one-command tasks).
//   → Explore agent type makes 3x more tool calls for inventory (bad fit).
//
// Catches the common post-conversion issues we've learned:
//   • format not in known set (e.g. mlx-8bit)
//   • size_bytes mismatch for sharded models
//   • config.json missing architecture-specific fields
//   • compatible_with forward references to missing models
//   • Missing manifest.json / config.json / README.md
//   • tmp/ folders that can be cleaned up
//
// Phases:
//   Resolve   → detect absolute project root, derive all paths, get timestamp
//   Audit     → run check-manifests, capture structured errors/warnings/notices
//   Inventory → read all manifest.json + config.json, build complete model catalog
//   Verify    → deep post-conversion checks (shard sizes, config schemas, graph)
//   Suggest   → prioritize actionable suggestions with known fix patterns
//
// Usage:
//   /mlx-movie-director-models-assistant                       — full audit + suggestions
//   /mlx-movie-director-models-assistant --quick               — audit only, skip inventory/verify
//   /mlx-movie-director-models-assistant --category transformer — filter to one category

export const meta = {
  name: "mlx-movie-director-models-assistant",
  description: "Model manifest audit, inventory, schema verification, and management suggestions for mlx-movie-director",
  whenToUse: "After converting a new model, before committing model changes, or for periodic model directory housekeeping",
  phases: [
    { title: "Resolve", detail: "Detect absolute project root, derive paths, get timestamp" },
    { title: "Audit", detail: "Run check-manifests, capture errors/warnings/notices" },
    { title: "Inventory", detail: "Read all manifests + configs, build complete model catalog" },
    { title: "Verify", detail: "Deep post-conversion checks: shard sizes, config schemas, reference graph" },
    { title: "Suggest", detail: "Prioritized actionable suggestions with known fix patterns" },
    { title: "Persist", detail: "Write run history JSON to .claude/workflows/history/ for trend analysis" },
  ],
};

// ── Schemas ───────────────────────────────────────────────────────────────────

const PATH_SCHEMA = {
  type: "object",
  properties: {
    projectRoot: { type: "string", description: "Absolute path to the git project root" },
  },
  required: ["projectRoot"],
};

const TIMESTAMP_SCHEMA = {
  type: "object",
  properties: { timestamp: { type: "string" } },
  required: ["timestamp"],
};

const INVENTORY_SCHEMA = {
  type: "object",
  properties: {
    models: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string" },
          instance: { type: "string" },
          arch: { type: "string" },
          format: { type: "string" },
          sizeBytes: { type: "number" },
          compatibleWith: { type: "array", items: { type: "string" } },
          hasConfigJson: { type: "boolean" },
          hasReadme: { type: "boolean" },
          weightFiles: { type: "array", items: { type: "string" } },
          isSharded: { type: "boolean" },
          weightFile: { type: "string" },
          actualSizeBytes: { type: "number" },
          tmpFolder: { type: "object" },
        },
        required: ["category", "instance", "arch", "format", "sizeBytes", "compatibleWith", "hasConfigJson", "hasReadme", "weightFiles", "isSharded"],
      },
    },
    orphans: { type: "array", items: { type: "string" } },
    tmpFolders: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, files: { type: "number" }, bytes: { type: "number" } },
        required: ["path", "files", "bytes"],
      },
    },
  },
  required: ["models", "orphans", "tmpFolders"],
};

// ── Resolve phase: absolute paths ─────────────────────────────────────────────

phase("Resolve");

const pathResolution = await agent(
  `Detect the absolute path of the git project root for the video_generation ComfyUI project.

  Run: Bash("git rev-parse --show-toplevel")

  This returns the absolute path to the repository root.
  Return it as { projectRoot: "<the-path>" }.

  IMPORTANT: Return ONLY the JSON object. Normalize backslashes to forward slashes.`,
  { label: "resolve-paths", phase: "Resolve", model: "haiku", schema: PATH_SCHEMA },
);

const PROJECT_ROOT = (pathResolution?.projectRoot || "").replace(/\\/g, "/");
if (!PROJECT_ROOT) {
  log("ERROR: Could not resolve project root. Falling back to relative paths — agent commands may fail if CWD drifts.");
}

const PYTHON = PROJECT_ROOT ? `${PROJECT_ROOT}/ComfyUI/.venv/bin/python` : "ComfyUI/.venv/bin/python";
const RUN_PY = PROJECT_ROOT ? `${PROJECT_ROOT}/python/mlx-movie-director/run.py` : "python/mlx-movie-director/run.py";
const MODELS_DIR = PROJECT_ROOT ? `${PROJECT_ROOT}/python/mlx-movie-director/models` : "python/mlx-movie-director/models";

// ── saveHistory — identical in every workflow; update _shared-patterns.md first ──
// Writes history JSON then VERIFIES (test -s) and rewrites via a quoted heredoc if the Write
// tool silently produced nothing — a reliability fix: the prior run's persist subagent reported
// success but never wrote the file, breaking the trend/reflection/resume loops.
async function saveHistory(histDir, indexFile, entry, signals) {
  const histJson = JSON.stringify({ ...entry, signals }, null, 2)
  const runId = entry.run_id
  const targetPath = `${histDir}/${runId}.json`
  const persist = await agent(
    `Persist workflow history to disk RELIABLY.
1. Bash("mkdir -p '${histDir}'")
2. Write the file with the Write tool: file_path='${targetPath}', content is the JSON below — paste it VERBATIM, do not summarize or truncate:
${histJson}
3. Verify it landed: Bash("test -s '${targetPath}' && echo OK || echo MISSING")
4. If step 3 printed MISSING, rewrite via a quoted heredoc (no expansion):
   Bash("cat > '${targetPath}' <<'HIST_EOF'
${histJson}
HIST_EOF")
5. Bash("wc -c < '${targetPath}'")
6. Prune old (keep newest 15, exclude reflection): Bash("cd '${histDir}' && ls -t *.json 2>/dev/null | grep -v reflection | tail -n +16 | xargs rm -f 2>/dev/null || true")
Return { written: true, bytes: <the number printed by wc> }.`,
    { label: "persist-history", phase: "Persist", model: "haiku" },
  )
  const histBytes = Number(persist?.bytes) || 0
  if (histBytes > 0) {
    log(`History: written ${histBytes} bytes → ${targetPath}`)
  } else {
    log(`WARNING: history file verification FAILED (0 bytes) — run continues but trend/reflection will miss this run.`)
  }
  await agent(
    `Update cross-workflow index at ${indexFile}.
1. Bash("cat '${indexFile}' 2>/dev/null || echo '[]'")
2. Parse JSON array. Append: ${JSON.stringify({ run_id: runId, workflow: entry.workflow, started_at: entry.started_at, run_quality: signals.run_quality, key_metric: signals.key_metric, highlights: signals.highlights })}
3. Keep only latest 50 entries (sort by run_id descending).
4. Write({ file_path: '${indexFile}', content: <updated array, 2-space indent> })
5. Verify: Bash("test -s '${indexFile}' && echo OK || echo MISSING")
6. If MISSING, rewrite the index via a quoted heredoc with the same array content.
Return { updated: true }.`,
    { label: "update-index", phase: "Persist", model: "haiku" },
  )
}

log("Resolved paths:");
log(`  PROJECT_ROOT: ${PROJECT_ROOT || "(fallback: relative)"}`);
log(`  PYTHON:       ${PYTHON}`);
log(`  RUN_PY:       ${RUN_PY}`);
log(`  MODELS_DIR:   ${MODELS_DIR}`);

// Get timestamp
const timestampResult = await agent(
  `Run this command and return its output as a JSON object with key "timestamp":\ndate "+%Y-%m-%d_%H%M%S"`,
  { label: "get-timestamp", phase: "Resolve", model: "haiku", schema: TIMESTAMP_SCHEMA },
);

let TIMESTAMP = timestampResult?.timestamp || "unknown";
// Handle haiku double-encoding: agent returns {"timestamp": "value"} as string
if (typeof TIMESTAMP === "string" && TIMESTAMP.startsWith("{")) {
  try { TIMESTAMP = JSON.parse(TIMESTAMP).timestamp || TIMESTAMP; } catch {}
}

// ── Resolve args ──────────────────────────────────────────────────────────────

const quick = args?.quick || false;
const filterCategory = args?.category || null;

// ── Phase tracking ────────────────────────────────────────────────────────────
const phaseStatus = { resolve: "pending", audit: "pending", inventory: "pending", verify: "pending", suggest: "pending", persist: "pending" }
const phasesCompleted = []
const phasesFailed = []
const filesTouched = new Set()
function markPhase(name, status) {
  phaseStatus[name] = status
  if (status === "completed") phasesCompleted.push(name)
  if (status === "failed") phasesFailed.push(name)
}
markPhase("resolve", "completed")

// ── Phase: Audit ──────────────────────────────────────────────────────────────

phase("Audit");

log("Running check-manifests...");

const auditRaw = await agent(
  `Run this command and return ALL of its stdout AND stderr output verbatim (include the exit code if non-zero):\n` +
  `${PYTHON} ${RUN_PY} check-manifests -v 2>&1; echo "EXIT_CODE=$?"`,
  { label: "run-check-manifests", phase: "Audit" },
);

// Parse the checker output into structured result
const auditLines = (auditRaw || "").split("\n");
const audit = {
  total: 0,
  passed: [],
  errors: [],
  warnings: [],
  notices: [],
  exitCode: 0,
};

let section = null;
for (const line of auditLines) {
  const trimmed = line.trim();
  if (trimmed.startsWith("Manifests found:")) {
    audit.total = parseInt(trimmed.split(":")[1]) || 0;
  } else if (trimmed.startsWith("❌ Errors")) {
    section = "errors";
  } else if (trimmed.startsWith("⚠️  Warnings")) {
    section = "warnings";
  } else if (trimmed.startsWith("ℹ️  Notices")) {
    section = "notices";
  } else if (trimmed.startsWith("✅ All") || trimmed.startsWith("Passed:")) {
    section = null;
  } else if (trimmed.startsWith("Models directory:")) {
    // skip
  } else if (trimmed === "") {
    section = null;
  } else if (section && trimmed.startsWith("   ")) {
    const msg = trimmed.replace(/^   /, "");
    if (section === "passed") {
      audit.passed.push(msg);
    } else {
      audit[section].push(msg);
    }
  } else if (trimmed.startsWith("EXIT_CODE=")) {
    audit.exitCode = parseInt(trimmed.split("=")[1]) || 0;
  }
}

// Extract passed list from the "Passed:" line
const passedLine = auditLines.find(l => l.trim().startsWith("Passed:"));
if (passedLine) {
  audit.passed = passedLine.replace(/^.*Passed:\s*/, "").split(", ").map(s => s.trim()).filter(Boolean);
}

log(`Audit result: ${audit.total} manifests, ${audit.errors.length} errors, ${audit.warnings.length} warnings, ${audit.notices.length} notices (exit ${audit.exitCode})`);

if (quick) {
  log("Quick mode — skipping inventory and verify phases");
  log("");
  log("=== AUDIT SUMMARY ===");
  log(`Timestamp: ${TIMESTAMP}`);
  log(`Total manifests: ${audit.total}`);
  log(`Errors: ${audit.errors.length}`);
  log(`Warnings: ${audit.warnings.length}`);
  log(`Notices: ${audit.notices.length}`);
  log(`Passed: ${audit.passed.join(", ")}`);
  if (audit.errors.length) {
    log("");
    log("Errors:");
    for (const e of audit.errors) log(`  ❌ ${e}`);
  }
  if (audit.warnings.length) {
    log("");
    log("Warnings:");
    for (const w of audit.warnings) log(`  ⚠️  ${w}`);
  }
  if (audit.notices.length) {
    log("");
    log("Notices:");
    for (const n of audit.notices) log(`  ℹ️  ${n}`);
  }
  log("");
  log("=== END AUDIT ===");

  return {
    timestamp: TIMESTAMP,
    mode: "quick",
    audit: { total: audit.total, errors: audit.errors.length, warnings: audit.warnings.length, notices: audit.notices.length, passed: audit.passed },
  };
}

// ── Pre-scan: accurate file sizes via bash (avoids LLM miscounting) ──────────

markPhase("audit", "completed")
phase("Inventory");

log("Pre-scanning .safetensors files for accurate sizes...");

const FILE_SCAN_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path like vae/flux-ae" },
          files: { type: "array", items: { type: "string" } },
          totalBytes: { type: "number" },
        },
        required: ["path", "files", "totalBytes"],
      },
    },
  },
  required: ["entries"],
};

const fileScan = await agent(
  `Scan all .safetensors files under ${MODELS_DIR} and build an accurate file inventory.

  Run this bash command:
  find ${MODELS_DIR} -maxdepth 3 -name "*.safetensors" -exec stat -f "%z %N" {} \\;

  Parse each line: first number is bytes, rest is the file path.
  Group by the model directory (two levels under MODELS_DIR, e.g. "vae/flux-ae").

  Return as:
  {
    "entries": [
      { "path": "vae/flux-ae", "files": ["model.safetensors"], "totalBytes": 167666894 },
      { "path": "transformer/klein-9b", "files": ["0.safetensors", "1.safetensors", "2.safetensors", "3.safetensors", "4.safetensors"], "totalBytes": 9646067090 }
    ]
  }

  Include ALL directories that have .safetensors files, even if only one file.
  Omit directories with no .safetensors files.`,
  { label: "scan-file-sizes", phase: "Inventory", model: "haiku", schema: FILE_SCAN_SCHEMA },
);

// Build lookup map: "category/instance" -> { files, totalBytes }
const fileScanData = {};
for (const entry of (fileScan?.entries || [])) {
  fileScanData[entry.path] = { files: entry.files, totalBytes: entry.totalBytes };
}
log(`Pre-scan found ${Object.keys(fileScanData).length} directories with .safetensors files`);

// ── Inventory agent: manifests + configs ──────────────────────────────────────

const categoryFilter = filterCategory ? ` Only inventory the "${filterCategory}" category.` : "";

const inventory = await agent(
  `Scan the model directory at ${MODELS_DIR} and build a complete inventory.

  For each subdirectory at models/<category>/<instance>/:
  1. Read manifest.json — extract name, type, arch, format, sizeBytes (as size_bytes), compatibleWith (as compatible_with), weightFile (as weight_file, optional)
  2. Check if config.json exists (hasConfigJson) and README.md exists (hasReadme)
  3. List all *.safetensors files in the directory (weightFiles)
  4. Determine if sharded: true if model.safetensors.index.json exists or if there are multiple .safetensors files (isSharded)
  5. If sharded, sum all .safetensors file sizes (actualSizeBytes), else use the single file size
  6. Check for tmp/ subfolder — if it exists, count files and total bytes (tmpFolder: { files, bytes })

  Also detect:
  - Orphan directories: <category>/<instance>/ dirs with NO manifest.json (skip dirs starting with "." and named "tmp" or "__pycache__")
  - tmp/ folders across all instances

  Return the result as:
  {
    "models": [{
      "category": "transformer",
      "instance": "klein-9b",
      "arch": "flux2-klein-9b",
      "format": "mlx-8bit",
      "sizeBytes": 9646067090,
      "compatibleWith": ["qwen3-8b"],
      "hasConfigJson": true,
      "hasReadme": true,
      "weightFiles": ["0.safetensors", "1.safetensors", ...],
      "isSharded": true,
      "weightFile": null,
      "actualSizeBytes": 9646067090,
      "tmpFolder": null
    }],
    "orphans": ["tokenizer/qwen3-klein"],
    "tmpFolders": [{ "path": "tokenizer/qwen3/tmp", "files": 2, "bytes": 4448686 }]
  }${categoryFilter}`,
  { label: "inventory-models", phase: "Inventory", schema: INVENTORY_SCHEMA },
);

const models = inventory?.models || [];
const orphans = inventory?.orphans || [];
const tmpFolders = inventory?.tmpFolders || [];

// Compute category counts
const categoryCounts = {};
for (const m of models) {
  categoryCounts[m.category] = (categoryCounts[m.category] || 0) + 1;
}

// Compute total model size
const totalSizeBytes = models.reduce((sum, m) => sum + (m.actualSizeBytes || m.sizeBytes || 0), 0);

log(`Inventory: ${models.length} models across ${Object.keys(categoryCounts).length} categories`);
for (const [cat, count] of Object.entries(categoryCounts).sort()) {
  log(`  ${cat}: ${count} instances`);
}
log(`  Total size: ${(totalSizeBytes / 1e9).toFixed(1)} GB`);
if (orphans.length) log(`  Orphans: ${orphans.join(", ")}`);
if (tmpFolders.length) {
  const totalTmpBytes = tmpFolders.reduce((s, t) => s + t.bytes, 0);
  log(`  tmp/ folders: ${tmpFolders.length} (${(totalTmpBytes / 1e6).toFixed(1)} MB reclaimable)`);
}

// ── Phase: Verify ─────────────────────────────────────────────────────────────

markPhase("inventory", "completed")
phase("Verify");

const verifyFindings = [];

// Build lookup maps
const instanceNames = new Set(models.map(m => `${m.category}/${m.instance}`));
const archIds = new Set(models.map(m => m.arch));
const nameToModel = {};
for (const m of models) {
  nameToModel[`${m.category}/${m.instance}`] = m;
}

// 1. Size_bytes verification — use pre-scanned data (accurate) instead of LLM-reported
// Tolerance: 0.1% to avoid false positives from haiku parsing drift
for (const m of models) {
  const label = `${m.category}/${m.instance}`;
  const scanned = fileScanData[label];
  if (scanned && m.sizeBytes) {
    const diff = Math.abs(scanned.totalBytes - m.sizeBytes);
    const threshold = m.sizeBytes * 0.001; // 0.1% tolerance
    if (diff > threshold) {
      verifyFindings.push({
        type: "size-mismatch",
        model: label,
        severity: "warning",
        message: `${label}: size_bytes=${m.sizeBytes} but actual file total is ${scanned.totalBytes}`,
        fix: `Update manifest.json size_bytes to ${scanned.totalBytes}`,
      });
    }
  }
}

// 2. compatible_with graph analysis
const allRefs = new Map(); // ref -> [{ from, category, instance }]
for (const m of models) {
  for (const ref of (m.compatibleWith || [])) {
    if (!allRefs.has(ref)) allRefs.set(ref, []);
    allRefs.get(ref).push({ from: `${m.category}/${m.instance}`, category: m.category, instance: m.instance });
  }
}

// Forward references: ref not found as instance name or arch id
for (const [ref, sources] of allRefs) {
  const isInstance = models.some(m => m.instance === ref);
  const isArch = archIds.has(ref);
  if (!isInstance && !isArch) {
    verifyFindings.push({
      type: "forward-ref",
      ref,
      severity: "info",
      sources: sources.map(s => s.from),
      message: `compatible_with "${ref}" not found as instance or arch — referenced by ${sources.map(s => s.from).join(", ")}`,
      fix: `Add model with arch/name "${ref}", or remove from compatible_with`,
    });
  }
}

// Self-references: model lists its own instance name or arch
for (const m of models) {
  for (const ref of (m.compatibleWith || [])) {
    if (ref === m.instance || ref === m.arch) {
      verifyFindings.push({
        type: "self-ref",
        model: `${m.category}/${m.instance}`,
        severity: "info",
        message: `compatible_with contains self-reference "${ref}"`,
        fix: `Remove "${ref}" from compatible_with (implied by arch field)`,
      });
    }
  }
}

// 3. Missing required files
for (const m of models) {
  const label = `${m.category}/${m.instance}`;
  if (!m.hasConfigJson && !["lora", "tokenizer", "audio"].includes(m.category)) {
    verifyFindings.push({
      type: "missing-config",
      model: label,
      severity: "warning",
      message: `${label}: Missing config.json for ${m.category} model`,
      fix: `Create config.json with architecture parameters`,
    });
  }
  if (!m.hasReadme) {
    verifyFindings.push({
      type: "missing-readme",
      model: label,
      severity: "warning",
      message: `${label}: Missing README.md`,
      fix: `Create README.md with source, conversion steps, and architecture`,
    });
  }
  // Tokenizers use .json files as weights, not .safetensors — skip check
  if (m.format === "hf-tokenizer") {
    // no safetensors expected
  } else if (!m.weightFiles || m.weightFiles.length === 0) {
    verifyFindings.push({
      type: "missing-weights",
      model: label,
      severity: "error",
      message: `${label}: No weight files found`,
      fix: `Convert or download model weights into this directory`,
    });
  }
}

// 4. Format vs actual file consistency
for (const m of models) {
  if (m.format && m.format.startsWith("mlx-") && m.weightFiles?.length > 0) {
    // MLX models should have model.safetensors (non-sharded) or N.safetensors (sharded)
    // unless manifest declares a custom weight_file
    const declared = m.weightFile || null;
    const hasDeclared = declared && m.weightFiles.includes(declared);
    if (!m.isSharded && !m.weightFiles.includes("model.safetensors") && !hasDeclared) {
      verifyFindings.push({
        type: "format-mismatch",
        model: `${m.category}/${m.instance}`,
        severity: "info",
        message: `MLX format but no model.safetensors found — weights: ${m.weightFiles.join(", ")}`,
        fix: `Rename weight file to model.safetensors or update manifest format`,
      });
    }
  }
}

// 5. Duplicate arch within category
const archByCategory = {};
for (const m of models) {
  const key = `${m.category}/${m.arch}`;
  if (!archByCategory[key]) archByCategory[key] = [];
  archByCategory[key].push(m.instance);
}
for (const [key, instances] of Object.entries(archByCategory)) {
  if (instances.length > 1) {
    verifyFindings.push({
      type: "duplicate-arch",
      severity: "info",
      message: `${key}: ${instances.length} instances share arch "${key.split("/")[1]}" — ${instances.join(", ")}`,
      fix: `Intentional variants, or verify arch field is correct for each`,
    });
  }
}

log(`Verify: ${verifyFindings.length} findings`);
const verifyBySeverity = { error: 0, warning: 0, info: 0 };
for (const f of verifyFindings) verifyBySeverity[f.severity] = (verifyBySeverity[f.severity] || 0) + 1;
log(`  Errors: ${verifyBySeverity.error}, Warnings: ${verifyBySeverity.warning}, Info: ${verifyBySeverity.info}`);

// ── Phase: Suggest ────────────────────────────────────────────────────────────

markPhase("verify", "completed")
phase("Suggest");

const suggestions = [];

// Classify audit errors/warnings into actionable suggestions
for (const e of audit.errors) {
  if (e.includes("'format'") && e.includes("not in known set")) {
    const match = e.match(/"([^"]+)"/);
    const fmt = match ? match[1] : "unknown";
    suggestions.push({
      type: "register-format",
      priority: "medium",
      format: fmt,
      message: `Register format "${fmt}" in KNOWN_FORMATS`,
      fix: `Add "${fmt}" to KNOWN_FORMATS set in app/commands/check-manifests.py`,
    });
  } else if (e.includes("config.json must have at least one")) {
    const match = e.match(/\(([^)]+)\)/);
    const fields = match ? match[1] : "";
    const label = e.split(":")[0];
    suggestions.push({
      type: "schema-update",
      priority: "high",
      model: label,
      fields,
      message: `config.json missing dimension field for ${label}`,
      fix: `Add architecture-specific field to CONFIG_SCHEMAS.transformer.any_of dimension group (current: ${fields})`,
    });
  } else if (e.includes("missing required field")) {
    const label = e.split(":")[0];
    const field = e.match(/'([^']+)'/)?.[1] || "unknown";
    suggestions.push({
      type: "missing-field",
      priority: "high",
      model: label,
      field,
      message: `${label}: missing manifest field "${field}"`,
      fix: `Add "${field}" to manifest.json for ${label}`,
    });
  } else {
    suggestions.push({
      type: "audit-error",
      priority: "high",
      message: e,
      fix: "Review and fix the error described above",
    });
  }
}

for (const w of audit.warnings) {
  if (w.includes("'compatible_with' reference") && w.includes("not found")) {
    const ref = w.match(/'([^']+)'\s+not found/)?.[1] || "unknown";
    suggestions.push({
      type: "forward-ref",
      priority: "low",
      ref,
      message: `Forward reference "${ref}" — model not yet in repo`,
      fix: `Add model with arch/name "${ref}", or remove from compatible_with`,
    });
  } else if (w.includes("size_bytes") && w.includes("actual total")) {
    const label = w.split(":")[0];
    suggestions.push({
      type: "size-fix",
      priority: "high",
      model: label,
      message: `${label}: size_bytes mismatch`,
      fix: `Update manifest.json size_bytes to match actual file total`,
    });
  } else if (w.includes("directory exists but has no manifest")) {
    const label = w.split(":")[0];
    suggestions.push({
      type: "orphan",
      priority: "medium",
      model: label,
      message: `${label}: directory exists without manifest`,
      fix: `Create manifest.json + README.md, or remove directory if unused`,
    });
  }
}

// Add tmp/ cleanup suggestions
for (const tmp of tmpFolders) {
  suggestions.push({
    type: "cleanup",
    priority: "low",
    message: `${tmp.path}: ${tmp.files} files, ${(tmp.bytes / 1e6).toFixed(1)} MB — safe to delete`,
    fix: `rm -rf ${MODELS_DIR}/${tmp.path}`,
  });
}

// Add orphan suggestions (from inventory, not audit — may be duplicates)
for (const orphan of orphans) {
  if (!suggestions.some(s => s.type === "orphan" && s.model === orphan)) {
    suggestions.push({
      type: "orphan",
      priority: "medium",
      model: orphan,
      message: `${orphan}: directory exists without manifest`,
      fix: `Create manifest.json + README.md, or remove directory if unused`,
    });
  }
}

// Add verify findings as suggestions (deduplicated from audit)
for (const f of verifyFindings) {
  // Skip if already covered by an audit-derived suggestion for the same model+type
  const alreadyCovered = suggestions.some(s => s.model === f.model && s.type === f.type);
  if (alreadyCovered) continue;

  if (f.type === "missing-weights") {
    suggestions.push({
      type: "missing-weights",
      priority: "high",
      model: f.model,
      message: f.message,
      fix: f.fix,
    });
  } else if (f.type === "missing-config") {
    suggestions.push({
      type: "missing-config",
      priority: "medium",
      model: f.model,
      message: f.message,
      fix: f.fix,
    });
  } else if (f.type === "size-mismatch") {
    suggestions.push({
      type: "size-fix",
      priority: "high",
      model: f.model,
      message: f.message,
      fix: f.fix,
    });
  } else if (f.type === "forward-ref") {
    suggestions.push({
      type: "forward-ref",
      priority: "low",
      ref: f.ref,
      message: f.message,
      fix: f.fix,
    });
  } else if (f.type === "self-ref") {
    suggestions.push({
      type: "self-ref",
      priority: "low",
      model: f.model,
      message: f.message,
      fix: f.fix,
    });
  } else if (f.type === "duplicate-arch") {
    suggestions.push({
      type: "duplicate-arch",
      priority: "info",
      message: f.message,
      fix: f.fix,
    });
  } else if (f.type === "format-mismatch") {
    suggestions.push({
      type: "format-mismatch",
      priority: "medium",
      model: f.model,
      message: f.message,
      fix: f.fix,
    });
  }
}

// Sort by priority: high > medium > low > info
const priorityOrder = { high: 0, medium: 1, low: 2, info: 3 };
suggestions.sort((a, b) => (priorityOrder[a.priority] || 99) - (priorityOrder[b.priority] || 99));

markPhase("suggest", "completed")

// ── Report ────────────────────────────────────────────────────────────────────

log("");
log("=== MODELS ASSISTANT REPORT ===");
log(`Timestamp: ${TIMESTAMP}`);
log(`Project: ${PROJECT_ROOT || "(relative)"}`);
log("");
log("Audit Summary:");
log(`  Manifests: ${audit.total}`);
log(`  Passed:    ${audit.passed.length}`);
log(`  Errors:    ${audit.errors.length}`);
log(`  Warnings:  ${audit.warnings.length}`);
log(`  Notices:   ${audit.notices.length}`);
log("");
log("Inventory:");
log(`  Models:    ${models.length} across ${Object.keys(categoryCounts).length} categories`);
for (const [cat, count] of Object.entries(categoryCounts).sort()) {
  log(`    ${cat}: ${count}`);
}
log(`  Total:     ${(totalSizeBytes / 1e9).toFixed(1)} GB`);
log(`  Sharded:   ${models.filter(m => m.isSharded).length} models`);
log(`  Orphans:   ${orphans.length}`);
log(`  tmp/ dirs: ${tmpFolders.length} (${(tmpFolders.reduce((s, t) => s + t.bytes, 0) / 1e6).toFixed(1)} MB)`);
log("");
log("Verification:");
log(`  Findings:  ${verifyFindings.length}`);
log(`  Errors:    ${verifyBySeverity.error}`);
log(`  Warnings:  ${verifyBySeverity.warning}`);
log(`  Info:      ${verifyBySeverity.info}`);

if (suggestions.length) {
  log("");
  log(`Suggestions (${suggestions.length}):`);
  const icons = { high: "🔴", medium: "🟡", low: "🔵", info: "⚪" };
  for (const s of suggestions) {
    const icon = icons[s.priority] || "⚪";
    log(`  ${icon} [${s.priority}] ${s.message}`);
    if (s.fix) log(`     → ${s.fix}`);
  }
} else {
  log("");
  log("✅ No suggestions — all models healthy.");
}

log("");
log("=== END REPORT ===");

// ── Persist — write run history ──────────────────────────────────────────────
phase("Persist");
const _ma_HIST_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${meta.name}`;
const _ma_INDEX_FILE = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`;

const _ma_signals = {
  run_quality: phasesFailed.length === 0 ? "good" : "degraded",
  key_metric: models.length,
  delta_from_last: null,
  highlights: [
    `${models.length} model(s) inventoried, ${parseFloat((totalSizeBytes / 1e9).toFixed(1))}GB total`,
    audit.errors.length > 0 ? `${audit.errors.length} audit error(s)` : "audit clean",
    suggestions.length > 0 ? `${suggestions.length} suggestion(s)` : "no suggestions",
  ],
  warnings: audit.errors.map((e) => e.message || String(e)).slice(0, 3),
};

const _ma_histEntry = {
  schema_version: 1, run_id: TIMESTAMP, workflow: meta.name, started_at: TIMESTAMP,
  args: args,
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: phasesFailed.length === 0 ? "complete" : "partial",
  result: {
    auditErrors: audit.errors.length,
    auditWarnings: audit.warnings.length,
    modelCount: models.length,
    findingCount: verifyFindings.length,
    suggestionCount: suggestions.length,
    totalSizeGB: parseFloat((totalSizeBytes / 1e9).toFixed(1)),
  },
};

await saveHistory(_ma_HIST_DIR, _ma_INDEX_FILE, _ma_histEntry, _ma_signals);
markPhase("persist", "completed")
log(`History: ${_ma_HIST_DIR}/${TIMESTAMP}.json`);

// ── Return structured result ──────────────────────────────────────────────────

return {
  timestamp: TIMESTAMP,
  audit: {
    total: audit.total,
    errors: audit.errors.length,
    warnings: audit.warnings.length,
    notices: audit.notices.length,
    passed: audit.passed,
    errorDetails: audit.errors,
    warningDetails: audit.warnings,
  },
  inventory: {
    models: models.map(m => ({
      category: m.category,
      instance: m.instance,
      arch: m.arch,
      format: m.format,
      sizeBytes: m.sizeBytes,
      actualSizeBytes: m.actualSizeBytes,
      compatibleWith: m.compatibleWith,
      isSharded: m.isSharded,
      hasConfigJson: m.hasConfigJson,
      hasReadme: m.hasReadme,
      weightFileCount: m.weightFiles?.length || 0,
    })),
    categories: categoryCounts,
    totalSizeBytes,
    orphans,
    tmpFolders,
  },
  verification: {
    findings: verifyFindings,
    bySeverity: verifyBySeverity,
  },
  suggestions,
};
