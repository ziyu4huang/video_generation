import fs from "fs";
import path from "path";
import { FRONTEND_DIR } from "../lib/paths";
import { handleGallery, handleGalleryImage } from "./gallery";
import { handleRunJob, handleListJobs, handleGetJob, handleGetLastJob, handleDeleteJob } from "./jobs";
import { handleUpload } from "./upload";
import { handleListLoras, handleListVaes } from "./models";
import { handleGetConfig, handlePutConfig, handleVerifyPython } from "./config";
import { handleVlmTest } from "./vlm";
import { handleModelCheckRun, handleModelCheckCache, handleModelCheckScan } from "./model-check";
import { handleGetSchemaDefaults } from "./schema-defaults";
import { handleRunSelfTest } from "./selftest";
import { handleCaptionRun, handleCaptionGet } from "./caption";
import { handleWebSocketUpgrade } from "./ws";

const TEXT_HTML = { "Content-Type": "text/html; charset=utf-8" };
const TEXT_CSS = { "Content-Type": "text/css; charset=utf-8" };

// Pre-built frontend bundle (built at server startup, rebuilt on file change in dev)
let _bundle: Response | null = null;

async function _doBuild(silent?: boolean): Promise<boolean> {
  const entryPoint = path.join(FRONTEND_DIR, "app.tsx");
  try {
    const result = await Bun.build({
      entrypoints: [entryPoint],
      outdir: "/tmp/gui-movie-director-build",
      target: "browser",
      minify: false,
      splitting: false,
      sourcemap: "external",
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
      external: [],
    });
    if (result.success && result.outputs.length > 0) {
      const blob = result.outputs[0];
      _bundle = new Response(blob, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
      if (!silent) console.log(`📦 Frontend bundled: ${Math.round(blob.size / 1024)}KB`);
      return true;
    } else {
      console.error("Bundle errors:", result.logs);
      return false;
    }
  } catch (err) {
    console.error("Bundle failed:", err);
    return false;
  }
}

export async function buildFrontendBundle(): Promise<void> {
  await _doBuild();
}

export async function rebuildFrontendBundle(): Promise<boolean> {
  return _doBuild(true);
}

export async function handleRequest(req: Request, server: any): Promise<Response | undefined> {
  const url = new URL(req.url);
  const { pathname } = url;

  // WebSocket upgrade
  if (pathname === "/ws") {
    const upgraded = handleWebSocketUpgrade(req, server);
    if (upgraded) return undefined;
    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  // API routes
  if (pathname.startsWith("/api/")) {
    return handleApi(req, url);
  }

  // Output image serving
  if (pathname.startsWith("/output/")) {
    const filename = pathname.slice("/output/".length);
    return handleGalleryImage(req, filename);
  }

  // Frontend bundle JS
  if (pathname === "/frontend/bundle.js") {
    if (_bundle) return _bundle.clone();
    return new Response("Bundle not ready", { status: 503 });
  }

  // CSS
  if (pathname === "/frontend/styles.css") {
    return serveFile(path.join(FRONTEND_DIR, "styles.css"), TEXT_CSS);
  }

  // HTML shell — serves index.html for all non-API, non-static routes (SPA)
  if (pathname === "/" || pathname === "/index.html" || !pathname.startsWith("/api/")) {
    return serveFile(path.join(FRONTEND_DIR, "index.html"), TEXT_HTML);
  }

  return new Response("Not found", { status: 404 });
}

function serveFile(filePath: string, headers: Record<string, string>): Response {
  if (!fs.existsSync(filePath)) {
    return new Response("Not found", { status: 404, headers });
  }
  const content = fs.readFileSync(filePath);
  return new Response(content, { headers });
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  // Gallery
  if (pathname === "/api/gallery" && method === "GET") {
    return handleGallery(req);
  }

  // Jobs
  if (pathname === "/api/run" && method === "POST") {
    return handleRunJob(req);
  }
  if (pathname === "/api/jobs" && method === "GET") {
    return handleListJobs(req);
  }
  if (pathname === "/api/jobs/last" && method === "GET") {
    return handleGetLastJob(req);
  }
  if (pathname.startsWith("/api/jobs/") && method === "GET") {
    const id = pathname.slice("/api/jobs/".length);
    return handleGetJob(req, id);
  }
  if (pathname.startsWith("/api/jobs/") && method === "DELETE") {
    const id = pathname.slice("/api/jobs/".length);
    return handleDeleteJob(req, id);
  }

  // Upload
  if (pathname === "/api/upload" && method === "POST") {
    return handleUpload(req);
  }

  // Models
  if (pathname === "/api/models/loras" && method === "GET") {
    return handleListLoras(req);
  }
  if (pathname === "/api/models/vaes" && method === "GET") {
    return handleListVaes(req);
  }

  // Config
  if (pathname === "/api/config" && method === "GET") {
    return handleGetConfig(req);
  }
  if (pathname === "/api/config" && method === "PUT") {
    return handlePutConfig(req);
  }
  if (pathname === "/api/config/verify-python" && method === "POST") {
    return handleVerifyPython(req);
  }

  // VLM test
  if (pathname === "/api/vlm/test" && method === "GET") {
    return handleVlmTest(req);
  }

  // Model check
  if (pathname === "/api/model-check/run" && method === "POST") {
    return handleModelCheckRun(req);
  }
  if (pathname === "/api/model-check/scan" && method === "POST") {
    return handleModelCheckScan(req);
  }
  if (pathname === "/api/model-check/cache" && method === "GET") {
    return handleModelCheckCache(req);
  }

  // Schema defaults
  if (pathname === "/api/schema-defaults" && method === "GET") {
    return handleGetSchemaDefaults(req);
  }

  // Self-test
  if (pathname === "/api/selftest" && method === "POST") {
    return handleRunSelfTest(req);
  }

  // Caption
  if (pathname === "/api/caption/run" && method === "POST") {
    return handleCaptionRun(req);
  }
  if (pathname === "/api/caption" && method === "GET") {
    return handleCaptionGet(req);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
