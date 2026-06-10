import fs from "fs";
import path from "path";
import { FRONTEND_DIR, OUTPUT_DIR } from "../lib/paths";
import { handleGallery, handleGalleryImage } from "./gallery";

const TEXT_HTML = { "Content-Type": "text/html; charset=utf-8" };
const TEXT_CSS = { "Content-Type": "text/css; charset=utf-8" };
const APP_JS = { "Content-Type": "application/javascript; charset=utf-8" };
const APP_JSON = { "Content-Type": "application/json; charset=utf-8" };

export async function handleRequest(req: Request, server: any): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

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
  if (pathname.startsWith("/frontend/") && pathname.endsWith(".tsx")) {
    // Bun auto-transpiles .tsx in development mode
    const filePath = path.join(FRONTEND_DIR, pathname.slice("/frontend/".length));
    if (fs.existsSync(filePath)) {
      return serveFile(filePath, APP_JS);
    }
  }
  if (pathname.startsWith("/frontend/") && pathname.endsWith(".ts")) {
    const filePath = path.join(FRONTEND_DIR, pathname.slice("/frontend/".length));
    if (fs.existsSync(filePath)) {
      return serveFile(filePath, APP_JS);
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

  if (pathname === "/api/gallery" && req.method === "GET") {
    return handleGallery(req);
  }

  if (pathname === "/api/models/loras" && req.method === "GET") {
    // Will be implemented in Step 4
    return Response.json([]);
  }

  if (pathname === "/api/models/vaes" && req.method === "GET") {
    // Will be implemented in Step 4
    return Response.json([]);
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: APP_JSON,
  });
}
