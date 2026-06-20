import type { Server } from "bun";
import fs from "fs";
import path from "path";
import { FRONTEND_DIR } from "../lib/paths";
import { buildFrontendBundle, rebuildFrontendBundle, serveBundleJs, serveBundleCss } from "./bundle";
import { handleGallery, handleGalleryImage, handleGallerySearch, handleGalleryDelete, handleGalleryCaptionMissing } from "./gallery";
import { handleRunJob, handleListJobs, handleGetJob, handleGetLastJob, handleDeleteJob, handleClearJobs } from "./jobs";
import { handleReplayJob } from "./replay";
import { handleUpload } from "./upload";
import { handleListLoras, handleListVaes } from "./models";
import { handleGetConfig, handlePutConfig, handleVerifyPython } from "./config";
import { handleServerInfo } from "./server-info";
import { handleVlmTest } from "./vlm";
import { handleModelCheckRun, handleModelCheckCache, handleModelCheckScan } from "./model-check";
import { handleGetCliSchema, handleGetSchemaDefaults } from "./schema";
import { handleRunSelfTest, handleSelfTestResults } from "./selftest";
import { handleCaptionRun, handleCaptionGet } from "./caption";
import { handleKnowledgeScan, handleKnowledgeCaptionMissing, handleKnowledgeAnalyze, handleKnowledgeGetReport, handleKnowledgeDeleteReport } from "./knowledge";
import { handleCodeKnowledgeReport } from "./code-knowledge";
import { handleWebSocketUpgrade } from "./ws";

export { buildFrontendBundle, rebuildFrontendBundle };

const TEXT_HTML = { "Content-Type": "text/html; charset=utf-8" };
const TEXT_CSS = { "Content-Type": "text/css; charset=utf-8" };

export async function handleRequest(req: Request, server: Server): Promise<Response | undefined> {
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
    const res = serveBundleJs(req);
    if (!res) return new Response("Bundle not ready", { status: 503 });
    return res;
  }

  // Frontend bundle CSS (from Bun.build — includes global.css + CSS module outputs)
  if (pathname === "/frontend/bundle.css") {
    return serveBundleCss(req);
  }

  // Legacy CSS (kept for backwards compatibility during transition)
  if (pathname === "/frontend/styles.css") {
    return serveFile(path.join(FRONTEND_DIR, "styles.css"), TEXT_CSS);
  }

  // HTML shell — SPA fallback. Every path reaching here has already been
  // excluded by the checks above (/ws, /api/, /output/, the static bundle
  // files), so serve index.html unconditionally and let the client-side
  // router take over. (The prior guard `!pathname.startsWith("/api/")` was
  // always true here — /api/ is dispatched at line 39 — making this branch
  // unconditional and the trailing 404 dead code.)
  return serveFile(path.join(FRONTEND_DIR, "index.html"), TEXT_HTML);
}

function serveFile(filePath: string, headers: Record<string, string>): Response {
  if (!fs.existsSync(filePath)) {
    return new Response("Not found", { status: 404, headers });
  }
  return new Response(Bun.file(filePath), { headers });
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  // Cross-site defense: browsers send an Origin header on cross-origin POSTs
  // (including multipart/form-data "simple" requests like file uploads, which
  // bypass CORS preflight). A malicious website (Origin: https://evil.com) could
  // otherwise push files onto this server's filesystem via a plain <form> POST.
  // Same pattern as the WebSocket handler (api/ws.ts). An absent Origin (curl,
  // scripts, programmatic clients that don't set one) is allowed through.
  //
  // Security: Use a FIXED allowlist of permitted origins, NOT the request's own
  // Host header (vulnerable to DNS rebinding). The server runs on a dynamic port,
  // so we extract it from the Host header and construct the allowlist.
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("host");
    if (!host) {
      return Response.json({ ok: false, error: "Invalid request" }, { status: 403 });
    }

    // Extract port from Host header (IPv6 addresses are bracketed)
    const portMatch = host.match(/:(\d+)$/);
    const port = portMatch ? portMatch[1] : "3099"; // default if missing

    // Fixed allowlist of permitted origins for this port
    const allowedOrigins = [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
    ];

    if (!allowedOrigins.includes(origin)) {
      return Response.json({ ok: false, error: "Cross-origin request blocked" }, { status: 403 });
    }
  }

  // Gallery
  if (pathname === "/api/gallery/search" && method === "GET") {
    return handleGallerySearch(req);
  }
  if (pathname === "/api/gallery" && method === "GET") {
    return handleGallery(req);
  }
  if (pathname === "/api/gallery" && method === "DELETE") {
    return handleGalleryDelete(req);
  }
  if (pathname === "/api/gallery/caption-missing" && method === "POST") {
    return handleGalleryCaptionMissing(req);
  }

  // Jobs
  if (pathname === "/api/run" && method === "POST") {
    return handleRunJob(req);
  }
  if (pathname === "/api/replay" && method === "POST") {
    return handleReplayJob(req);
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
  if (pathname === "/api/jobs/all" && method === "DELETE") {
    return handleClearJobs(req);
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

  // Server info (git branch@commit for title/header)
  if (pathname === "/api/server-info" && method === "GET") {
    return handleServerInfo(req);
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

  // Full CLI contract from run.py (single source of truth for accepted flags)
  if (pathname === "/api/cli-schema" && method === "GET") {
    return handleGetCliSchema(req);
  }

  // Self-test
  if (pathname === "/api/selftest" && method === "POST") {
    return handleRunSelfTest(req);
  }
  if (pathname === "/api/selftest/results" && method === "GET") {
    return handleSelfTestResults(req);
  }

  // Caption
  if (pathname === "/api/caption/run" && method === "POST") {
    return handleCaptionRun(req);
  }
  if (pathname === "/api/caption" && method === "GET") {
    return handleCaptionGet(req);
  }

  // Knowledge extraction
  if (pathname === "/api/knowledge/scan" && method === "GET") {
    return handleKnowledgeScan(req);
  }
  if (pathname === "/api/knowledge/caption-missing" && method === "POST") {
    return handleKnowledgeCaptionMissing(req);
  }
  if (pathname === "/api/knowledge/analyze" && method === "POST") {
    return handleKnowledgeAnalyze(req);
  }
  if (pathname === "/api/knowledge/report" && method === "GET") {
    return handleKnowledgeGetReport(req);
  }
  if (pathname === "/api/knowledge/report" && method === "DELETE") {
    return handleKnowledgeDeleteReport(req);
  }

  // Code-health knowledge (self-improve workflow producer side — sibling of the
  // generation knowledge routes above).
  if (pathname === "/api/code-knowledge/report" && method === "GET") {
    return handleCodeKnowledgeReport(req);
  }

  return Response.json({ ok: false, error: "Not found" }, { status: 404 });
}
