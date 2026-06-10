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
const APP_JS = { "Content-Type": "application/javascript; charset=utf-8" };
const APP_JSON = { "Content-Type": "application/json; charset=utf-8" };

export async function handleRequest(req: Request, server: any): Promise<Response | undefined> {
  const url = new URL(req.url);
  const { pathname } = url;

  // WebSocket upgrade
  if (pathname === "/ws") {
    const upgraded = handleWebSocketUpgrade(req, server);
    if (upgraded) return undefined; // WebSocket took over
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

  // Frontend static files
  if (pathname === "/" || pathname === "/index.html") {
    return serveFile(path.join(FRONTEND_DIR, "index.html"), TEXT_HTML);
  }
  if (pathname === "/frontend/styles.css") {
    return serveFile(path.join(FRONTEND_DIR, "styles.css"), TEXT_CSS);
  }
  if (pathname.startsWith("/frontend/")) {
    const relPath = pathname.slice("/frontend/".length);
    const filePath = path.join(FRONTEND_DIR, relPath);
    if (fs.existsSync(filePath)) {
      // Determine content type
      if (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".js")) {
        return serveFile(filePath, APP_JS);
      }
      if (filePath.endsWith(".css")) {
        return serveFile(filePath, TEXT_CSS);
      }
      if (filePath.endsWith(".html")) {
        return serveFile(filePath, TEXT_HTML);
      }
      // Default: serve as-is
      const file = Bun.file(filePath);
      return new Response(file);
    }
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
