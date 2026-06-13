// MLX Movie Director — Video Assistant
//
// Action-oriented workflow: downloads, organizes, and validates the 5 LTX-2.3
// model components needed by `run.py video` (T2V / I2V / A2V).
//
// Idempotent: re-running after a partial download resumes from where it left off.
// Downloads are SEQUENTIAL to respect HF rate limits (no parallel downloads).
//
// Phases:
//   Resolve    → project root, component status, Python deps
//   Download   → plan queue, then sequential HF downloads (skips already-done)
//   Conversion → clean HF metadata, update manifest size_bytes, verify assembly
//   Validate   → check-manifests + ltx_pipelines_mlx import test
//   Report     → dual self-reflection: token usage + domain risks + TODO list
//
// Usage:
//   /mlx-movie-director-video-assistant

export const meta = {
  name: "mlx-movie-director-video-assistant",
  description: "Download, organize, and validate LTX-2.3 video model components for run.py video",
  whenToUse: "Before first `run.py video` run, or after pulling new model versions. Safe to re-run — idempotent.",
  phases: [
    { title: "Resolve",    detail: "Project root, component file status, Python dep check" },
    { title: "Download",   detail: "Plan sequential downloads from dgrauet/ltx-2.3-mlx-q8 (skips already-done)" },
    { title: "Conversion", detail: "Clean HF metadata, update manifest size_bytes, verify symlink assembly" },
    { title: "Validate",   detail: "check-manifests + ltx_pipelines_mlx import test" },
    { title: "Report",     detail: "Token self-reflection + domain risks + prioritized TODO list" },
    { title: "Persist",    detail: "Write run history JSON to .claude/workflows/history/ for trend analysis" },
  ],
};

// ── Component definitions ─────────────────────────────────────────────────────
// Mirrors COMPONENT_FILES in app/ltx_downloader.py and _LTX_COMPONENT_FILES in app/ltx_pipeline.py

const LTX_COMPONENTS = [
  {
    name: "transformer",
    subDir: "transformer/ltx-2.3-dev-q8",
    requiredFiles: ["transformer-dev.safetensors"],
    optionalFiles: ["split_model.json", "quantize_config.json"],
    estimatedGB: 19.2,
    isOptionalComponent: false,
  },
  {
    name: "lora",
    subDir: "lora/ltx-2.3-distilled",
    requiredFiles: ["ltx-2.3-22b-distilled-lora-384.safetensors"],
    optionalFiles: [],
    estimatedGB: 7.1,
    isOptionalComponent: false,
  },
  {
    name: "text_encoder",
    subDir: "text_encoder/ltx-2.3-connector",
    requiredFiles: ["connector.safetensors"],
    optionalFiles: ["config.json", "embedded_config.json"],
    estimatedGB: 5.9,
    isOptionalComponent: false,
  },
  {
    name: "vae",
    subDir: "vae/ltx-2.3-vae",
    requiredFiles: ["vae_encoder.safetensors", "vae_decoder.safetensors"],
    optionalFiles: ["spatial_upscaler_x2_v1_1.safetensors"],
    estimatedGB: 1.4,
    isOptionalComponent: false,
  },
  {
    name: "audio",
    subDir: "audio/ltx-2.3-audio",
    requiredFiles: ["audio_vae.safetensors", "vocoder.safetensors"],
    optionalFiles: [],
    estimatedGB: 0.35,
    isOptionalComponent: true,  // only needed for A2V mode
  },
];

// ── Schemas ───────────────────────────────────────────────────────────────────

const PATH_SCHEMA = {
  type: "object",
  properties: { projectRoot: { type: "string", description: "Absolute path to git project root" } },
  required: ["projectRoot"],
};

const TIMESTAMP_SCHEMA = {
  type: "object",
  properties: { timestamp: { type: "string" } },
  required: ["timestamp"],
};

const COMPONENT_STATUS_SCHEMA = {
  type: "object",
  properties: {
    components: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name:            { type: "string" },
          dir:             { type: "string" },
          existingFiles:   { type: "array", items: { type: "string" } },
          missingRequired: { type: "array", items: { type: "string" } },
          missingOptional: { type: "array", items: { type: "string" } },
          ready:           { type: "boolean" },
        },
        required: ["name", "dir", "existingFiles", "missingRequired", "ready"],
      },
    },
    allReady:        { type: "boolean" },
    totalMissingGB:  { type: "number" },
  },
  required: ["components", "allReady", "totalMissingGB"],
};

const DEP_STATUS_SCHEMA = {
  type: "object",
  properties: {
    mlxArsenal:  { type: "boolean" },
    mlxLm:       { type: "boolean" },
    hfHub:       { type: "boolean" },
    allOk:       { type: "boolean" },
    missingDeps: { type: "array", items: { type: "string" } },
  },
  required: ["mlxArsenal", "mlxLm", "hfHub", "allOk", "missingDeps"],
};

const DOWNLOAD_RESULT_SCHEMA = {
  type: "object",
  properties: {
    component:       { type: "string" },
    success:         { type: "boolean" },
    skipped:         { type: "boolean" },
    downloadedFiles: { type: "array", items: { type: "string" } },
    errors:          { type: "array", items: { type: "string" } },
    rawOutput:       { type: "string", description: "First 2000 chars of command output" },
  },
  required: ["component", "success", "skipped"],
};

const SETUP_RESULT_SCHEMA = {
  type: "object",
  properties: {
    component:       { type: "string" },
    sizeBytesBefore: { type: "number" },
    sizeBytesAfter:  { type: "number" },
    manifestUpdated: { type: "boolean" },
    cleanedFiles:    { type: "array", items: { type: "string" } },
    assemblyReady:   { type: "boolean" },
    skipped:         { type: "boolean" },
  },
  required: ["component", "manifestUpdated", "assemblyReady"],
};

const ASSEMBLY_CHECK_SCHEMA = {
  type: "object",
  properties: {
    assemblySymlinkCount:  { type: "number" },
    missingFromAssembly:   { type: "array", items: { type: "string" } },
    assemblyWouldSucceed:  { type: "boolean" },
  },
  required: ["assemblySymlinkCount", "missingFromAssembly", "assemblyWouldSucceed"],
};

const IMPORT_CHECK_SCHEMA = {
  type: "object",
  properties: {
    importOk: { type: "boolean" },
    error:    { type: "string" },
  },
  required: ["importOk"],
};

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    tokenReflection: {
      type: "array",
      items: {
        type: "object",
        properties: {
          phase:          { type: "string" },
          agentLabel:     { type: "string" },
          currentModel:   { type: "string" },
          suggestedModel: { type: "string" },
          reason:         { type: "string" },
        },
        required: ["phase", "agentLabel", "currentModel", "suggestedModel", "reason"],
      },
    },
    summary: {
      type: "array",
      items: {
        type: "object",
        properties: {
          component: { type: "string" },
          status:    { type: "string", enum: ["ready", "downloaded", "skipped", "failed", "missing"] },
          sizeGB:    { type: "number" },
        },
        required: ["component", "status"],
      },
    },
    issues:     { type: "array", items: { type: "string" } },
    reflection: { type: "array", items: { type: "string" } },
    todoAgent: {
      type: "array",
      items: {
        type: "object",
        properties: {
          priority:    { type: "string", enum: ["high", "medium", "low"] },
          command:     { type: "string" },
          description: { type: "string" },
        },
        required: ["priority", "description"],
      },
    },
    todoHuman: {
      type: "array",
      items: {
        type: "object",
        properties: {
          priority:    { type: "string", enum: ["high", "medium", "low"] },
          instruction: { type: "string" },
        },
        required: ["priority", "instruction"],
      },
    },
  },
  required: ["tokenReflection", "summary", "issues", "reflection", "todoAgent", "todoHuman"],
};

// ── Phase 1: Resolve ──────────────────────────────────────────────────────────

phase("Resolve");

// Step 1a: project root first — all derived paths depend on it
const pathResolution = await agent(
  `Run: git rev-parse --show-toplevel\n` +
  `Return { "projectRoot": "<absolute-path>" }. Normalize backslashes to forward slashes.`,
  { label: "resolve-paths", phase: "Resolve", model: "haiku", schema: PATH_SCHEMA },
);

const PROJECT_ROOT = (pathResolution?.projectRoot || "").replace(/\\/g, "/");
if (!PROJECT_ROOT) {
  log("ERROR: Could not resolve project root. Falling back to relative paths — paths may be wrong.");
}

const PYTHON     = `${PROJECT_ROOT}/python/venv/bin/python`;
const RUN_PY     = `${PROJECT_ROOT}/python/mlx-movie-director/run.py`;
const DOWNLOADER = `${PROJECT_ROOT}/python/mlx-movie-director/app/ltx_downloader.py`;
const MODELS_DIR = `${PROJECT_ROOT}/python/mlx-movie-director/models`;
const VENDOR_DIR = `${PROJECT_ROOT}/python/mlx-movie-director/vendor/ltx-2-mlx`;

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

// Build component definitions with absolute dirs
const components = LTX_COMPONENTS.map(c => ({ ...c, dir: `${MODELS_DIR}/${c.subDir}` }));

log(`Resolved: ${PROJECT_ROOT || "(unknown)"}`);

// Step 1b: parallel — timestamp, component status, dep check
const componentListForPrompt = components.map(c =>
  `  ${c.name}:\n    dir: ${c.dir}\n    required: ${c.requiredFiles.join(", ")}\n    optional: ${c.optionalFiles.join(", ") || "(none)"}`
).join("\n");

const resolveResults = await parallel([
  () => agent(
    `Run: date "+%Y-%m-%d_%H%M%S"\nReturn { "timestamp": "<output>" }`,
    { label: "get-timestamp", phase: "Resolve", model: "haiku", schema: TIMESTAMP_SCHEMA },
  ),

  () => agent(
    `Check LTX-2.3 model component directories. For each component below, list what files exist.\n\n` +
    `Components:\n${componentListForPrompt}\n\n` +
    `For each component:\n` +
    `1. Run: ls "${components[0].dir}" 2>/dev/null (replace with each component's dir)\n` +
    `   Also check each of the other dirs: ${components.slice(1).map(c => `"${c.dir}"`).join(", ")}\n` +
    `2. existingFiles = list of files that ls returns (or [] if dir is empty/absent)\n` +
    `3. missingRequired = required files not in existingFiles\n` +
    `4. missingOptional = optional files not in existingFiles\n` +
    `5. ready = missingRequired.length === 0\n\n` +
    `allReady = all non-optional components (transformer, lora, text_encoder, vae) have ready=true\n` +
    `totalMissingGB = sum of estimatedGB for non-ready components\n` +
    `  (use: transformer=19.2, lora=7.1, text_encoder=5.9, vae=1.4, audio=0.35)\n\n` +
    `Return the full COMPONENT_STATUS_SCHEMA JSON.`,
    { label: "check-components", phase: "Resolve", schema: COMPONENT_STATUS_SCHEMA },
  ),

  () => agent(
    `Check if LTX-2.3 Python dependencies are installed.\n\n` +
    `Run each command and check for ModuleNotFoundError:\n` +
    `  ${PYTHON} -c "import mlx_arsenal; print('ok')" 2>&1\n` +
    `  ${PYTHON} -c "import mlx_lm; print('ok')" 2>&1\n` +
    `  ${PYTHON} -c "import huggingface_hub; print('ok')" 2>&1\n\n` +
    `Set each bool to true if import succeeded (no ModuleNotFoundError in output).\n` +
    `allOk = mlxArsenal AND mlxLm AND hfHub.\n` +
    `missingDeps = package names for any that failed (use: "mlx_arsenal", "mlx_lm", "huggingface_hub").\n` +
    `Return JSON.`,
    { label: "check-deps", phase: "Resolve", model: "haiku", schema: DEP_STATUS_SCHEMA },
  ),
]);

const timestampResult  = resolveResults[0];
const componentStatus  = resolveResults[1];
const depStatus        = resolveResults[2];

const TIMESTAMP       = timestampResult?.timestamp || "unknown";
const compData        = componentStatus || { components: [], allReady: false, totalMissingGB: 0 };
const depsOk          = depStatus?.allOk || false;
const missingDeps     = depStatus?.missingDeps || [];

log(`\nResolve summary (${TIMESTAMP}):`);
for (const c of compData.components) {
  const icon = c.ready ? "✓" : `✗ missing: [${c.missingRequired?.join(", ") || "?"}]`;
  log(`  ${c.name}: ${icon}`);
}
log(`  all-ready: ${compData.allReady} | ~${compData.totalMissingGB?.toFixed(1) || "?"} GB to download`);
log(`  deps: ${depsOk ? "✓" : `✗ missing: ${missingDeps.join(", ")}`}`);
if (!depsOk && missingDeps.length) {
  const depArgs = missingDeps.map(d => {
    if (d === "mlx_arsenal") return '"mlx-arsenal>=0.2.4"';
    if (d === "mlx_lm")      return '"mlx-lm>=0.31.0"';
    if (d === "huggingface_hub") return '"huggingface-hub>=0.26.0"';
    return d;
  }).join(" ");
  log(`  install: ${PYTHON} -m pip install ${depArgs}`);
}

// ── Phase tracking ────────────────────────────────────────────────────────────
const phaseStatus = { resolve: "pending", download: "pending", conversion: "pending", validate: "pending", report: "pending", persist: "pending" }
const phasesCompleted = []
const phasesFailed = []
const filesTouched = new Set()
function markPhase(name, status) {
  phaseStatus[name] = status
  if (status === "completed") phasesCompleted.push(name)
  if (status === "failed") phasesFailed.push(name)
}
markPhase("resolve", "completed")

// ── Phase 2: Download ─────────────────────────────────────────────────────────

phase("Download");

// Build download queue (in-script, no agent needed)
const compByName = {};
for (const c of compData.components) compByName[c.name] = c;

const downloadQueue = LTX_COMPONENTS
  .filter(def => {
    const status = compByName[def.name];
    return status ? status.missingRequired.length > 0 : def.requiredFiles.length > 0;
  })
  .map(def => ({
    name: def.name,
    dir:  `${MODELS_DIR}/${def.subDir}`,
    missingFiles: compByName[def.name]?.missingRequired || def.requiredFiles,
    estimatedGB:  def.estimatedGB,
    isOptional:   def.isOptionalComponent,
  }));

const skipCount        = LTX_COMPONENTS.length - downloadQueue.length;
const totalEstimatedGB = downloadQueue.reduce((s, c) => s + c.estimatedGB, 0);

if (downloadQueue.length === 0) {
  log("All components already downloaded. Skipping download phase.");
} else {
  log(`\nDownload queue (${downloadQueue.length} to download, ${skipCount} skip, ~${totalEstimatedGB.toFixed(1)} GB):`);
  for (const item of downloadQueue) {
    log(`  ${item.name}: ${item.missingFiles.join(", ")} (~${item.estimatedGB} GB)`);
  }
  log(`  Sequential downloads — no parallel HF requests.`);
}

// Sequential download loop
const downloadResults = [];
let downloadAborted   = false;

for (const item of downloadQueue) {
  if (downloadAborted) {
    downloadResults.push({ component: item.name, success: false, skipped: true,
      errors: ["aborted: prior required component failed"] });
    continue;
  }

  log(`\n[${item.name}] starting download (~${item.estimatedGB} GB)...`);

  const result = await agent(
    `Download LTX-2.3 component "${item.name}" using the project downloader.\n\n` +
    `STEP 0 — Create in-progress flag (so check-manifests shows "downloading" not "error"):\n` +
    `  mkdir -p "${item.dir}" && touch "${item.dir}/.downloading"\n\n` +
    `STEP 1 — Run download and capture ALL stdout+stderr:\n` +
    `  ${PYTHON} ${DOWNLOADER} --component ${item.name} 2>&1; echo "EXIT_CODE=$?"\n\n` +
    `STEP 2 — Remove the in-progress flag (success or failure):\n` +
    `  rm -f "${item.dir}/.downloading"\n\n` +
    `From the output:\n` +
    `- success: EXIT_CODE=0\n` +
    `- skipped: success=true AND all files showed "✓ ... already exists" (no "↓" lines)\n` +
    `- downloadedFiles: filenames that were downloaded (lines containing "↓" or "done")\n` +
    `- errors: any error messages (lines containing "FAILED:" or "Error")\n` +
    `- rawOutput: first 2000 chars of the full command output\n\n` +
    `Return { "component": "${item.name}", "success": bool, "skipped": bool, "downloadedFiles": [], "errors": [], "rawOutput": "..." }`,
    { label: `download:${item.name}`, phase: "Download", schema: DOWNLOAD_RESULT_SCHEMA },
  );

  const r = result || { component: item.name, success: false, skipped: false, errors: ["agent returned null"] };
  downloadResults.push(r);

  if (r.success) {
    log(`  [${item.name}] ${r.skipped ? "already complete (skipped)" : `downloaded: ${(r.downloadedFiles || []).join(", ") || "files"}`}`);
  } else {
    log(`  [${item.name}] FAILED: ${(r.errors || []).join("; ")}`);
    if (!item.isOptional) {
      downloadAborted = true;
      log(`  Required component failed — aborting remaining downloads.`);
      log(`  Fix the issue and re-run; HF Hub will resume from where it left off.`);
    } else {
      log(`  Optional component failed — continuing.`);
    }
  }
}

markPhase("download", "completed")

// ── Phase 3: Conversion (Organize + Update) ───────────────────────────────────

phase("Conversion");

// Determine which components are now ready (either were already ready, or just downloaded)
const nowReadyNames = new Set([
  ...compData.components.filter(c => c.ready).map(c => c.name),
  ...downloadResults.filter(r => r?.success).map(r => r.component),
]);

const componentsToSetup = components.filter(c => nowReadyNames.has(c.name));

if (componentsToSetup.length === 0) {
  log("No components ready for setup. Skipping Conversion phase.");
}

// Parallel setup agents (file I/O only — safe to parallelize; download is already done)
const setupResults = componentsToSetup.length > 0
  ? await pipeline(
      componentsToSetup,
      comp => agent(
        `Organize LTX-2.3 component "${comp.name}" at: ${comp.dir}\n\n` +
        `Run each step as a bash command:\n\n` +
        `STEP 1 — Clean HF metadata artifacts:\n` +
        `  find "${comp.dir}" -maxdepth 3 \\( -name ".gitattributes" -o -name "*.incomplete" -o -name "*.metadata" \\) -type f 2>/dev/null\n` +
        `  If any found: rm -f <each file>. Report in cleanedFiles[].\n` +
        `  Also: if "${comp.dir}/.cache" exists → rm -rf "${comp.dir}/.cache", add ".cache" to cleanedFiles.\n\n` +
        `STEP 2 — Compute actual safetensors total size:\n` +
        `  Run: ls -la "${comp.dir}"/*.safetensors 2>/dev/null\n` +
        `  Sum all file sizes in bytes → sizeBytesAfter (0 if no .safetensors files).\n` +
        `  Read sizeBytesBefore from manifest: cat "${comp.dir}/manifest.json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('size_bytes',0))"\n\n` +
        `STEP 3 — Update manifest.json if size changed:\n` +
        `  If sizeBytesAfter > 0 AND sizeBytesAfter != sizeBytesBefore:\n` +
        `    python3 -c "import json; p='${comp.dir}/manifest.json'; m=json.load(open(p)); m['size_bytes']=${"{sizeBytesAfter}"}; json.dump(m,open(p,'w'),indent=2)"\n` +
        `    (substitute the actual sizeBytesAfter value into that command)\n` +
        `    manifestUpdated = true\n` +
        `  Else: manifestUpdated = false\n\n` +
        `STEP 4 — Assembly readiness:\n` +
        `  Check each required file exists: ${comp.requiredFiles.map(f => `"${comp.dir}/${f}"`).join(", ")}\n` +
        `  assemblyReady = all required files exist.\n\n` +
        `skipped = (cleanedFiles is empty AND manifestUpdated is false)\n\n` +
        `Return structured JSON.`,
        { label: `setup:${comp.name}`, phase: "Conversion", schema: SETUP_RESULT_SCHEMA },
      )
    )
  : [];

// Final assembly verification
const allRequiredForAssembly = LTX_COMPONENTS
  .filter(c => !c.isOptionalComponent)
  .flatMap(c => c.requiredFiles.map(f => ({
    component: c.name,
    file: f,
    fullPath: `${MODELS_DIR}/${c.subDir}/${f}`,
  })));

const assemblyCheckLines = allRequiredForAssembly
  .map(f => `  ${f.component}/${f.file} → ${f.fullPath}`)
  .join("\n");

const assemblyCheck = await agent(
  `Verify the LTX-2.3 symlink assembly would succeed.\n\n` +
  `Check each source file exists (these become flat symlinks in a tmp dir for the pipeline):\n` +
  `${assemblyCheckLines}\n\n` +
  `For each, run: test -f "<fullPath>" && echo "exists: <file>" || echo "missing: <file>"\n` +
  `assemblySymlinkCount = count of existing files.\n` +
  `missingFromAssembly = ["component/filename"] for each missing.\n` +
  `assemblyWouldSucceed = missingFromAssembly.length === 0.\n\n` +
  `Return structured JSON.`,
  { label: "verify-assembly", phase: "Conversion", schema: ASSEMBLY_CHECK_SCHEMA },
);

log(`\nAssembly check: ${assemblyCheck?.assemblyWouldSucceed ? "✓ all files present" : `✗ ${assemblyCheck?.missingFromAssembly?.length || "?"} missing`}`);
if (assemblyCheck?.missingFromAssembly?.length) {
  for (const m of assemblyCheck.missingFromAssembly) log(`  missing: ${m}`);
}
log(`  ${assemblyCheck?.assemblySymlinkCount || 0} / ${allRequiredForAssembly.length} required files present`);

for (const r of (setupResults || [])) {
  if (!r) continue;
  const delta = r.manifestUpdated ? ` manifest updated: ${r.sizeBytesBefore}→${r.sizeBytesAfter}` : "";
  const cleaned = r.cleanedFiles?.length ? ` cleaned: ${r.cleanedFiles.join(", ")}` : "";
  log(`  [${r.component}] ${r.skipped ? "skipped (already clean)" : `done${delta}${cleaned}`}`);
}

markPhase("conversion", "completed")

// ── Phase 4: Validate ─────────────────────────────────────────────────────────

phase("Validate");

const validateResults = await parallel([
  () => agent(
    `Run this command and return ALL stdout AND stderr output verbatim (do not truncate):\n` +
    `  ${PYTHON} ${RUN_PY} check-manifests -v 2>&1; echo "EXIT_CODE=$?"`,
    { label: "run-check-manifests", phase: "Validate" },
  ),
  () => agent(
    `Test import of ltx_pipelines_mlx from the vendored submodule.\n\n` +
    `Run:\n` +
    `  ${PYTHON} -c "import sys; sys.path.insert(0,'${VENDOR_DIR}/packages/ltx-core-mlx/src'); sys.path.insert(0,'${VENDOR_DIR}/packages/ltx-pipelines-mlx/src'); from ltx_pipelines_mlx import TI2VidTwoStagesPipeline; print('import OK')" 2>&1; echo "EXIT_CODE=$?"\n\n` +
    `importOk = output contains "import OK" AND EXIT_CODE=0.\n` +
    `error = first 500 chars of error output if importOk is false, else null.\n` +
    `Return { "importOk": bool, "error": string|null }`,
    { label: "test-import", phase: "Validate", model: "haiku", schema: IMPORT_CHECK_SCHEMA },
  ),
]);

const auditRaw   = validateResults[0] || "";
const importCheck = validateResults[1];

// Parse check-manifests output (reused pattern from mlx-movie-director-models-assistant.js)
const auditLines = auditRaw.split("\n");
const audit = { total: 0, passed: [], errors: [], warnings: [], notices: [], exitCode: 0 };
let section = null;
for (const line of auditLines) {
  const trimmed = line.trim();
  if      (trimmed.startsWith("Manifests found:"))    audit.total = parseInt(trimmed.split(":")[1]) || 0;
  else if (trimmed.startsWith("❌ Errors"))            section = "errors";
  else if (trimmed.startsWith("⚠️  Warnings"))         section = "warnings";
  else if (trimmed.startsWith("ℹ️  Notices"))           section = "notices";
  else if (trimmed.startsWith("✅ All") || trimmed.startsWith("Passed:")) section = null;
  else if (trimmed === "")                             section = null;
  else if (section && trimmed.startsWith("   "))      audit[section].push(trimmed.replace(/^   /, ""));
  else if (trimmed.startsWith("EXIT_CODE="))          audit.exitCode = parseInt(trimmed.split("=")[1]) || 0;
}
const passedLine = auditLines.find(l => l.trim().startsWith("Passed:"));
if (passedLine) audit.passed = passedLine.replace(/^.*Passed:\s*/, "").split(", ").map(s => s.trim()).filter(Boolean);

log(`\nValidation:`);
log(`  check-manifests: ${audit.errors.length === 0 ? `✓ passed (${audit.total} manifests)` : `✗ ${audit.errors.length} errors`}`);
for (const e of audit.errors)   log(`    ❌ ${e}`);
for (const w of audit.warnings) log(`    ⚠️  ${w}`);
log(`  import test: ${importCheck?.importOk ? "✓ OK" : `✗ ${importCheck?.error || "failed"}`}`);

markPhase("validate", "completed")

// ── Phase 5: Report ───────────────────────────────────────────────────────────

phase("Report");

// Build agent-call registry for token self-reflection
const agentCallLog = [
  { phase: "Resolve",    label: "resolve-paths",        model: "haiku" },
  { phase: "Resolve",    label: "get-timestamp",         model: "haiku" },
  { phase: "Resolve",    label: "check-components",      model: "sonnet" },
  { phase: "Resolve",    label: "check-deps",            model: "haiku" },
  ...downloadResults.map(r => ({ phase: "Download",   label: `download:${r?.component}`, model: "sonnet" })),
  ...componentsToSetup.map(c => ({ phase: "Conversion", label: `setup:${c.name}`,        model: "sonnet" })),
  { phase: "Conversion", label: "verify-assembly",       model: "haiku" },
  { phase: "Validate",   label: "run-check-manifests",   model: "sonnet" },
  { phase: "Validate",   label: "test-import",           model: "haiku" },
];

// Build concise results summaries for the report agent
const compResultsSummary = LTX_COMPONENTS.map(def => {
  const status = compByName[def.name];
  const dlResult = downloadResults.find(r => r?.component === def.name);
  const setupResult = (setupResults || []).find(r => r?.component === def.name);
  let finalStatus = "missing";
  if (status?.ready && !dlResult) finalStatus = "ready";
  else if (dlResult?.success && !dlResult?.skipped) finalStatus = "downloaded";
  else if (dlResult?.skipped) finalStatus = "ready";
  else if (dlResult && !dlResult.success) finalStatus = "failed";
  return `  ${def.name}: ${finalStatus} | manifestUpdated=${setupResult?.manifestUpdated} assemblyReady=${setupResult?.assemblyReady}`;
}).join("\n");

const report = await agent(
  `You are the self-reflection agent for the MLX Movie Director Video Assistant workflow.\n\n` +
  `Analyze the workflow run and produce a structured REPORT_SCHEMA JSON.\n\n` +
  `═══ WORKFLOW RESULTS ═══\n\n` +
  `Component results:\n${compResultsSummary}\n\n` +
  `Download: ${downloadQueue.length} queued, ${downloadResults.filter(r => r?.success && !r?.skipped).length} downloaded, ` +
  `${downloadResults.filter(r => r?.skipped).length + skipCount} skipped, ${downloadResults.filter(r => !r?.success).length} failed\n\n` +
  `Assembly: would_succeed=${assemblyCheck?.assemblyWouldSucceed} | ${assemblyCheck?.assemblySymlinkCount}/${allRequiredForAssembly.length} required files present\n` +
  `missing: [${(assemblyCheck?.missingFromAssembly || []).join(", ")}]\n\n` +
  `check-manifests: exit=${audit.exitCode} | errors=${audit.errors.length} warnings=${audit.warnings.length}\n` +
  `  error details: ${audit.errors.join(" | ") || "(none)"}\n\n` +
  `import test: ${importCheck?.importOk ? "OK" : `FAILED — ${importCheck?.error}`}\n\n` +
  `Python deps: allOk=${depsOk} missing=[${missingDeps.join(", ")}]\n\n` +
  `═══ AGENT CALL REGISTRY (for token self-reflection) ═══\n\n` +
  `${agentCallLog.map(a => `  ${a.phase} / ${a.label}: model=${a.model}`).join("\n")}\n\n` +
  `═══ YOUR TASKS ═══\n\n` +
  `TASK A — Token self-reflection:\n` +
  `For EVERY agent in the registry above, evaluate if the model tier was optimal:\n` +
  `- haiku fits: single bash command → capture output → return; simple boolean checks\n` +
  `- sonnet fits: multi-step file analysis, JSON synthesis across multiple sources, reasoning about errors\n` +
  `- Key heuristic: if the agent just ran one command and returned its output → haiku could do it\n` +
  `- Include ALL agents even if model is already optimal (set suggestedModel = currentModel)\n\n` +
  `TASK B — Domain self-reflection:\n` +
  `Based on the run results, surface:\n` +
  `1. Any immediate blockers (failed downloads, import errors, missing manifests)\n` +
  `2. Known risks for first video generation run:\n` +
  `   - mlx-arsenal not installed → ltx pipeline import fails at run.py video\n` +
  `   - Gemma 3 12B (~7 GB) auto-downloads to ~/.cache/huggingface/ on first T2V run\n` +
  `   - --frames must be 8k+1 pattern: 25, 33, 41, 49, 57, 65, 73, 81, 89, 97\n` +
  `   - spatial_upscaler optional (only needed for SR upscale output mode)\n` +
  `   - audio component (audio_vae + vocoder) only needed for A2V mode\n` +
  `   - If dgrauet/ltx-2.3-mlx-q8 is private: HUGGING_FACE_HUB_TOKEN env var required\n` +
  `   - /tmp/ltx2_* assembly dirs are __del__-managed — never rm manually while pipeline live\n` +
  `   - HF Hub resumes interrupted downloads on re-run (safe to Ctrl+C and retry)\n` +
  `3. Any anomalies from this run (unexpected size_bytes values, extra files in component dirs, etc.)\n\n` +
  `TASK C — TODO lists:\n` +
  `todoAgent: machine-runnable tasks with copy-paste commands (e.g. install deps, re-run downloader)\n` +
  `todoHuman: tasks requiring human action (e.g. set env var, check HF account access, test generation)\n\n` +
  `Return the complete REPORT_SCHEMA JSON.`,
  { label: "self-reflection", phase: "Report", schema: REPORT_SCHEMA },
);

// ── Final report log ──────────────────────────────────────────────────────────

const picons = { high: "🔴", medium: "🟡", low: "🔵" };
const sicons = { ready: "✅", downloaded: "✅", skipped: "✅", failed: "❌", missing: "⏳" };

log("");
log("═══ VIDEO ASSISTANT REPORT ═══");
log(`Timestamp: ${TIMESTAMP}`);
log(`Project:   ${PROJECT_ROOT || "(relative)"}`);
log("");
log("Component Status:");
for (const s of (report?.summary || [])) {
  const icon = sicons[s.status] || "❓";
  const size = s.sizeGB ? ` (${s.sizeGB.toFixed(1)} GB)` : "";
  log(`  ${icon} ${s.component}: ${s.status}${size}`);
}

if (report?.issues?.length) {
  log("");
  log("Issues:");
  for (const issue of report.issues) log(`  ❌ ${issue}`);
}

if (report?.reflection?.length) {
  log("");
  log("Reflection / Risks:");
  for (const r of report.reflection) log(`  ⚡ ${r}`);
}

if (report?.todoAgent?.length) {
  log("");
  log("TODO (Agent):");
  for (const t of report.todoAgent) {
    log(`  ${picons[t.priority] || "⚪"} [${t.priority}] ${t.description}`);
    if (t.command) log(`     $ ${t.command}`);
  }
}

if (report?.todoHuman?.length) {
  log("");
  log("TODO (Human):");
  for (const t of report.todoHuman) {
    log(`  ${picons[t.priority] || "⚪"} [${t.priority}] ${t.instruction}`);
  }
}

if (report?.tokenReflection?.length) {
  log("");
  log("Token Self-Reflection:");
  const changes = report.tokenReflection.filter(r => r.currentModel !== r.suggestedModel);
  if (changes.length === 0) {
    log("  ✓ All agent model tiers were appropriate for their tasks.");
  } else {
    log(`  ${changes.length} optimization(s) suggested:`);
    for (const r of changes) {
      log(`  ${r.currentModel} → ${r.suggestedModel}  [${r.phase}/${r.agentLabel}]`);
      log(`    ${r.reason}`);
    }
  }
}

log("");
log("═══ END REPORT ═══");

markPhase("report", "completed")

// ── Persist — write run history ──────────────────────────────────────────────
phase("Persist");
const _va_HIST_DIR = `${PROJECT_ROOT}/.claude/workflows/history/${meta.name}`;
const _va_INDEX_FILE = `${PROJECT_ROOT}/.claude/workflows/history/_index.json`;

const _va_downloaded = downloadResults.filter(r => r?.success && !r?.skipped).length;
const _va_failed = downloadResults.filter(r => !r?.success).length;

const _va_signals = {
  run_quality: phasesFailed.length === 0 ? "good" : "degraded",
  key_metric: _va_downloaded,
  delta_from_last: null,
  highlights: [
    `${_va_downloaded} downloaded, ${downloadResults.filter(r => r?.skipped).length} skipped, ${_va_failed} failed`,
    compData.allReady ? "all models ready" : `${compData.totalMissingGB?.toFixed(1) ?? "?"}GB still missing`,
    importCheck?.importOk ? "import check OK" : "import check failed",
  ],
  warnings: _va_failed > 0 ? [`${_va_failed} download(s) failed`] : [],
};

const _va_histEntry = {
  schema_version: 1, run_id: TIMESTAMP, workflow: meta.name, started_at: TIMESTAMP,
  args: args,
  phases_completed: phasesCompleted,
  phases_failed: phasesFailed,
  status: phasesFailed.length === 0 ? "complete" : "partial",
  result: {
    allReady: compData.allReady,
    downloaded: _va_downloaded,
    failed: _va_failed,
    manifestsUpdated: (setupResults || []).filter(r => r?.manifestUpdated).length,
    importOk: importCheck?.importOk || false,
  },
};

await saveHistory(_va_HIST_DIR, _va_INDEX_FILE, _va_histEntry, _va_signals);
markPhase("persist", "completed")
log(`History: ${_va_HIST_DIR}/${TIMESTAMP}.json`);

// ── Structured return ─────────────────────────────────────────────────────────

return {
  timestamp: TIMESTAMP,
  resolve: {
    allReady: compData.allReady,
    totalMissingGB: compData.totalMissingGB,
    depsOk,
    missingDeps,
  },
  download: {
    queued: downloadQueue.length,
    downloaded: downloadResults.filter(r => r?.success && !r?.skipped).length,
    skipped: downloadResults.filter(r => r?.skipped).length + skipCount,
    failed: downloadResults.filter(r => !r?.success).length,
  },
  conversion: {
    setupCount: (setupResults || []).filter(Boolean).length,
    manifestsUpdated: (setupResults || []).filter(r => r?.manifestUpdated).length,
    assemblyWouldSucceed: assemblyCheck?.assemblyWouldSucceed || false,
    missingFromAssembly: assemblyCheck?.missingFromAssembly || [],
  },
  validation: {
    checkManifests: { errors: audit.errors.length, warnings: audit.warnings.length, exitCode: audit.exitCode },
    importOk: importCheck?.importOk || false,
  },
  report,
};
