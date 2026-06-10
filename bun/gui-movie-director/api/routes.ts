import fs from "fs";
import path from "path";
import { FRONTEND_DIR } from "../lib/paths";
import { handleGallery, handleGalleryImage } from "./gallery";
import { handleRunJob, handleListJobs, handleGetJob, handleDeleteJob } from "./jobs";
import { handleUpload } from "./upload";
import { handleListLoras, handleListVaes } from "./models";
import { handleWebSocketUpgrade } from "./ws";

const TEXT_HTML = { "Content-Type": "text/html; charset=utf-8" };
const TEXT_CSS = { "Content-Type": "text/css; charset=utf-8" };

// Pre-built frontend bundle (built at server startup)
let _bundle: Response | null = null;

export async function buildFrontendBundle(): Promise<void> {
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
        headers: { "Content-Type": "application/javascript; charset=utf-8" },
      });
      console.log(`📦 Frontend bundled: ${Math.round(blob.size / 1024)}KB`);
    } else {
      console.error("Bundle errors:", result.logs);
    }
  } catch (err) {
    console.error("Bundle failed:", err);
  }
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

  return Response.json({ error: "Not found" }, { status: 404 });
}
