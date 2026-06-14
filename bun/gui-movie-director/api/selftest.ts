import fs from "fs";
import path from "path";
import { OUTPUT_DIRS } from "../lib/paths";
import { readJsonFile } from "../lib/fsUtils";
import { actionToCommand } from "../lib/actionToCommand";
import { parsePostJson, spawnJobResponse } from "../lib/requestUtils";

/**
 * Run a built-in self-test via `run.py image <action> --self-test [name]`.
 * Reuses the same SubprocessManager infrastructure as regular jobs,
 * so logs and output files stream back via WebSocket automatically.
 */
export async function handleRunSelfTest(req: Request): Promise<Response> {
  const body = await parsePostJson<{ action?: string; test_name?: string }>(req);
  if (body instanceof Response) return body;
  const { action, test_name } = body;
  if (!action) {
    return Response.json({ ok: false, error: "Missing 'action'" }, { status: 400 });
  }
  if (!test_name) {
    return Response.json({ ok: false, error: "Missing 'test_name'" }, { status: 400 });
  }
  // test_name is forwarded into the run.py argv; reject anything that isn't a
  // bare self-test identifier (registry names are "word:word", e.g. t2i:portrait).
  // Requiring a non-dash first char blocks argument injection (a leading "--"
  // would be parsed by run.py's argparse as a separate flag).
  if (typeof test_name !== "string" || !/^[A-Za-z0-9_:][\w:.-]*$/.test(test_name)) {
    return Response.json({ ok: false, error: "Invalid 'test_name'" }, { status: 400 });
  }

  const command = actionToCommand(action);

  const cliArgs = ["--self-test", test_name];

  return spawnJobResponse(command, cliArgs);
}

/**
 * GET /api/selftest/results?jobId=...
 *
 * Collects structured self-test results for a job: every output image with its
 * companion run/caption JSON, plus the HTML review URL if the Python self-test
 * emitted a `SelfTestHTML:` marker. Excludes source/reference helper images
 * (filenames containing selftest_source or selftest_ref-pose).
 */
export async function handleSelfTestResults(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) {
    return Response.json({ ok: false, error: "Missing 'jobId'" }, { status: 400 });
  }

  const job = subprocessManager.getJob(jobId);
  if (!job) {
    return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
  }

  // Locate each output file in OUTPUT_DIRS, build variant cards.
  const variants: any[] = [];
  const seen = new Set<string>();

  for (const file of job.outputFiles) {
    const base = path.basename(file);

    // Exclude source/reference helper images from the I2I self-test
    if (base.includes("selftest_source") || base.includes("selftest_ref-pose")) {
      continue;
    }
    if (seen.has(base)) continue;
    seen.add(base);

    // Resolve which output dir + index holds this file
    let dirIdx = -1;
    let dirPath = "";
    let fullPath = "";
    for (let i = 0; i < OUTPUT_DIRS.length; i++) {
      const candidate = path.join(OUTPUT_DIRS[i], base);
      if (fs.existsSync(candidate)) {
        dirIdx = i;
        dirPath = OUTPUT_DIRS[i];
        fullPath = candidate;
        break;
      }
    }
    if (dirIdx === -1) continue;

    const nameNoExt = base.replace(/\.[^.]+$/, "");
    const runJsonPath = path.join(dirPath, `${nameNoExt}.run.json`);
    const captionJsonPath = path.join(dirPath, `${nameNoExt}.caption.json`);

    const runParams = fs.existsSync(runJsonPath) ? readJsonFile(runJsonPath) : null;
    const caption = fs.existsSync(captionJsonPath) ? readJsonFile(captionJsonPath) : null;

    variants.push({
      filename: base,
      url: `/output/${dirIdx}/${base}`,
      fullPath,
      params: _extractParams(runParams),
      run: runParams,
      caption,
      captionPath: fs.existsSync(captionJsonPath) ? captionJsonPath : null,
    });
  }

  // HTML review URL (basename from SelfTestHTML: marker → resolved into /output/)
  let htmlReviewUrl: string | null = null;
  if (job.selfTestHtmlPath) {
    for (let i = 0; i < OUTPUT_DIRS.length; i++) {
      if (fs.existsSync(path.join(OUTPUT_DIRS[i], job.selfTestHtmlPath))) {
        htmlReviewUrl = `/output/${i}/${job.selfTestHtmlPath}`;
        break;
      }
    }
  }

  return Response.json({
    jobId,
    action: job.action ?? null,
    variants,
    htmlReviewUrl,
    variantCount: variants.length,
  });
}

/**
 * Pull a compact param summary out of a run.json object for badge display.
 */
function _extractParams(run: Record<string, any> | null): Record<string, any> {
  if (!run) return {};
  const p = run.params ?? run.args ?? run;
  const picked: Record<string, any> = {};
  for (const k of [
    "denoise_strength", "controlnet_strength", "steps", "seed",
    "cnet_active_steps", "blur_ref", "pipeline",
  ]) {
    if (p[k] !== undefined && p[k] !== null) picked[k] = p[k];
  }
  // run.json sometimes nests under "config"
  if (run.config) {
    for (const k of ["denoise_strength", "controlnet_strength", "steps", "seed"]) {
      if (picked[k] === undefined && run.config[k] !== undefined) {
        picked[k] = run.config[k];
      }
    }
  }
  return picked;
}
