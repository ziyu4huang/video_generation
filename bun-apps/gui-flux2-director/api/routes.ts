/**
 * routes.ts — the API surface. All request bodies are JSON; all paths the
 * client supplies are containment-checked against OUTPUT_DIR before the
 * server reads or forwards them.
 */
import path from "path";
import { existsSync } from "fs";

import { FLUX2_BIN, FLUX2_METALLIB, MODELS_DIR, OUTPUT_DIR, flux2BinExists, flux2MetallibExists, isInside } from "../lib/paths";
import { scanModels } from "../lib/models";
import { listGallery } from "../lib/gallery";
import { jobManager, upscaleOutputPath } from "../lib/jobs";
import { t2iArgs, upscaleArgs, type LoraEntry, type T2IParams } from "../lib/flux2Args";
import { validateStory, runStory, listStories, DEFAULT_STORY } from "../lib/story";

/** Bare path component — the CLI joins names onto models roots un-sanitized. */
function isBareName(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

const MEDIAlike = /\.(png|jpe?g|webp|mp4)$/i;
/** Upscale is a pure image pass — no video inputs. */
const IMAGEonly = /\.(png|jpe?g|webp)$/i;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function badRequest(msg: string): Response {
  return json({ error: msg }, 400);
}

export interface GenerateBody {
  prompt?: string;
  negativePrompt?: string;
  transformer?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: string;
  strictGate?: boolean;
  autoUpscale?: boolean;
  lora?: LoraEntry[];
}

/** Validate + coerce the generate body into CLI params. Returns [params, error]. */
export function validateGenerate(body: GenerateBody): [T2IParams | null, string | null] {
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return [null, "prompt is required"];

  const width = body.width ?? 1024;
  const height = body.height ?? 1024;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return [null, "width/height must be integers"];
  if (width < 256 || width > 2048 || height < 256 || height > 2048) {
    return [null, "width/height must be within 256..2048"];
  }
  if (width % 16 !== 0 || height % 16 !== 0) return [null, "width/height must be multiples of 16"];

  const steps = body.steps ?? 4;
  if (!Number.isInteger(steps) || steps < 1 || steps > 30) return [null, "steps must be an integer 1..30"];

  const cfgScale = body.cfgScale ?? 1.0;
  if (typeof cfgScale !== "number" || cfgScale < 1 || cfgScale > 3) return [null, "cfgScale must be 1..3"];

  const seed = body.seed !== undefined && body.seed !== "" ? String(body.seed) : undefined;
  if (seed !== undefined && !/^\d+$/.test(seed)) return [null, "seed must be a non-negative integer"];

  const transformer = body.transformer ?? undefined;
  if (transformer !== undefined && !isBareName(transformer)) return [null, "transformer must be a bare model name"];

  const lora: LoraEntry[] = [];
  if (Array.isArray(body.lora)) {
    for (const entry of body.lora) {
      if (!entry || typeof entry.name !== "string" || !isBareName(entry.name)) {
        return [null, "each lora entry needs a bare name"];
      }
      const scale = entry.scale ?? 1.0;
      if (typeof scale !== "number" || scale <= 0 || scale > 2) {
        return [null, `lora ${entry.name}: scale must be within (0..2]`];
      }
      lora.push({ name: entry.name, scale });
    }
  }

  return [
    {
      prompt,
      negativePrompt: body.negativePrompt || undefined,
      transformer,
      width,
      height,
      steps,
      cfgScale,
      seed,
      lora: lora.length ? lora : undefined,
      strictGate: body.strictGate === true ? true : undefined,
    },
    null,
  ];
}

function handleJobEvents(req: Request, id: string): Response {
  const job = jobManager.get(id);
  if (!job) return json({ error: "no such job" }, 404);

  // Snapshot BEFORE subscribing: this whole function is synchronous, so no
  // broadcast can interleave — replaying the log then subscribing cannot
  // duplicate or drop lines.
  const enc = new TextEncoder();
  const channel = new TransformStream();
  const writer = channel.writable.getWriter();
  const send = (payload: string) => writer.write(enc.encode(payload)).catch(() => {});

  void send(`data: ${JSON.stringify({ type: "state", job: { ...job, log: undefined, logLines: job.log.length } })}\n\n`);
  for (const line of job.log) void send(`data: ${JSON.stringify({ type: "log", id, text: line })}\n\n`);

  const unsubscribe = jobManager.subscribe((evt) => {
    if (evt.type === "log" && evt.id !== id) return;
    if (evt.type === "stage" && evt.id !== id) return;
    if (evt.type === "state" && evt.job.id !== id) return;
    void send(`data: ${JSON.stringify(evt)}\n\n`);
  });

  const heartbeat = setInterval(() => void send(`: ping\n\n`), 15_000);
  req.signal.addEventListener("abort", () => {
    unsubscribe();
    clearInterval(heartbeat);
    writer.close().catch(() => {});
  }, { once: true });

  return new Response(channel.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/** GET /api/media?path=<abs> — serve an output-dir image or video to the browser. */
function serveMedia(url: URL): Response {
  const target = url.searchParams.get("path") ?? "";
  if (!target || !isInside(OUTPUT_DIR, target)) {
    return json({ error: "path must be inside the output dir" }, 403);
  }
  if (!MEDIAlike.test(target) || !existsSync(target)) return json({ error: "no such media" }, 404);
  const ext = path.extname(target).toLowerCase();
  const type =
    ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".mp4" ? "video/mp4" : "image/jpeg";
  return new Response(Bun.file(target), { headers: { "Content-Type": type, "Cache-Control": "no-cache" } });
}

/** Dispatch /api/*. Returns undefined when the path is not an API route. */
export async function handleApi(req: Request): Promise<Response | undefined> {
  const url = new URL(req.url);
  const seg = url.pathname.split("/").filter(Boolean); // ["api", ...]
  if (seg[0] !== "api") return undefined;
  const method = req.method;

  try {
    if (url.pathname === "/api/health" && method === "GET") {
      return json({
        ok: true,
        flux2Bin: FLUX2_BIN,
        flux2BinExists: flux2BinExists(),
        metallib: FLUX2_METALLIB,
        metallibExists: flux2MetallibExists(),
        modelsDir: MODELS_DIR,
        outputDir: OUTPUT_DIR,
        running: jobManager.hasRunning(),
      });
    }

    if (url.pathname === "/api/models" && method === "GET") {
      return json(scanModels());
    }

    if (url.pathname === "/api/gallery" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 500);
      return json({ items: listGallery(OUTPUT_DIR, limit), outputDir: OUTPUT_DIR });
    }

    if (url.pathname === "/api/image" && method === "GET") {
      return serveMedia(url);
    }

    if (url.pathname === "/api/media" && method === "GET") {
      return serveMedia(url);
    }

    if (url.pathname === "/api/story" && method === "GET") {
      return json({ defaultStory: DEFAULT_STORY, stories: listStories() });
    }

    if (url.pathname === "/api/story" && method === "POST") {
      let body: {
        scenes?: unknown;
        sceneCount?: unknown;
        seconds?: unknown;
        width?: unknown;
        height?: unknown;
        seed?: unknown;
        auto?: unknown;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return badRequest("body must be JSON");
      }
      const [params, err] = validateStory(body);
      if (!params) return badRequest(err!);
      if (!flux2BinExists()) {
        return json(
          { error: `flux2 binary missing at ${FLUX2_BIN} — run: swift build -c release --package-path swift/flux2-image-director` },
          503,
        );
      }
      if (jobManager.hasRunning()) {
        return json({ error: "a generation is already running — cancel it or wait" }, 409);
      }
      const summary = params.auto
        ? `auto story: "${params.auto.idea.slice(0, 60)}${params.auto.idea.length > 60 ? "…" : ""}" — brain writes ${params.scenes.length} scene(s) × ${params.seconds}s @ ${params.width}×${params.height}`
        : `story: ${params.scenes.length} scene(s) × ${params.seconds}s @ ${params.width}×${params.height}`;
      const job = jobManager.startPipeline("story", [summary], { prompt: params.auto?.idea ?? params.scenes[0] }, (_job, handle) =>
        runStory(params, handle),
      );
      return json({ jobId: job.id }, 202);
    }

    if (url.pathname === "/api/generate" && method === "POST") {
      let body: GenerateBody;
      try {
        body = (await req.json()) as GenerateBody;
      } catch {
        return badRequest("body must be JSON");
      }
      const [params, err] = validateGenerate(body);
      if (!params) return badRequest(err!);
      if (!flux2BinExists()) {
        return json(
          { error: `flux2 binary missing at ${FLUX2_BIN} — run: swift build -c release --package-path swift/flux2-image-director` },
          503,
        );
      }
      if (jobManager.hasRunning()) {
        return json({ error: "a generation is already running — cancel it or wait" }, 409);
      }
      const job = jobManager.start("t2i", t2iArgs(params), { prompt: params.prompt });
      return json({ jobId: job.id }, 202);
    }

    if (url.pathname === "/api/upscale" && method === "POST") {
      let body: { path?: string; model?: string };
      try {
        body = (await req.json()) as { path?: string; model?: string };
      } catch {
        return badRequest("body must be JSON");
      }
      const input = body.path ?? "";
      if (!input || !isInside(OUTPUT_DIR, input)) return badRequest("path must be inside the output dir");
      if (!IMAGEonly.test(input) || !existsSync(input)) return badRequest("no such image");
      if (jobManager.hasRunning()) {
        return json({ error: "a generation is already running — cancel it or wait" }, 409);
      }
      const args = upscaleArgs({
        input,
        output: upscaleOutputPath(input),
        model: body.model && isBareName(body.model) ? body.model : undefined,
      });
      const job = jobManager.start("upscale", args, { prompt: `upscale ${path.basename(input)}` });
      return json({ jobId: job.id }, 202);
    }

    if (seg[1] === "jobs") {
      if (seg.length === 2 && method === "GET") {
        return json({ jobs: jobManager.list() });
      }
      if (seg.length === 3 && method === "GET") {
        const job = jobManager.get(seg[2]!);
        return job ? json(job) : json({ error: "no such job" }, 404);
      }
      if (seg.length === 4 && seg[3] === "events" && method === "GET") {
        return handleJobEvents(req, seg[2]!);
      }
      if (seg.length === 4 && seg[3] === "cancel" && method === "POST") {
        const ok = jobManager.cancel(seg[2]!);
        return json({ cancelled: ok }, ok ? 200 : 409);
      }
    }

    return json({ error: "no such API route" }, 404);
  } catch (err) {
    console.error("[api]", err);
    return json({ error: "internal error" }, 500);
  }
}
