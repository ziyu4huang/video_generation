import type { Server } from "bun";
import type { WsData } from "./ws";
import fs from "fs";
import path from "path";
import { FRONTEND_DIR } from "../lib/paths";
import { originAllowed } from "../lib/origin";
import { buildFrontendBundle, rebuildFrontendBundle, serveBundleJs, serveBundleCss } from "./bundle";
import { handleGallery, handleGalleryImage, handleGallerySearch, handleGalleryDelete, handleGalleryCaptionMissing } from "./gallery";
import { handleRunJob, handleListJobs, handleGetJob, handleGetLastJob, handleDeleteJob, handleClearJobs } from "./jobs";
import { handleReplayJob } from "./replay";
import { handleUpload } from "./upload";
import { handleListLoras, handleListVaes } from "./models";
import { handleGetConfig, handlePutConfig, handleVerifyPython } from "./config";
import { handleServerInfo } from "./server-info";
import { handleVlmTest, handleCaptionModel } from "./vlm";
import { handleModelCheckRun, handleModelCheckCache, handleModelCheckScan } from "./model-check";
import { handleGetCliSchema, handleGetSchemaDefaults } from "./schema";
import { handleRunSelfTest, handleSelfTestResults } from "./selftest";
import { handleCaptionRun, handleCaptionGet } from "./caption";
import { handleAbTest } from "./abTest";
import { handleKnowledgeScan, handleKnowledgeCaptionMissing, handleKnowledgeAnalyze, handleKnowledgeGetReport, handleKnowledgeDeleteReport } from "./knowledge";
import { handleCodeKnowledgeReport } from "./code-knowledge";
import { handleWebSocketUpgrade } from "./ws";

export { buildFrontendBundle, rebuildFrontendBundle };

const TEXT_HTML = { "Content-Type": "text/html; charset=utf-8" };
const TEXT_CSS = { "Content-Type": "text/css; charset=utf-8" };

export async function handleRequest(req: Request, server: Server<WsData>): Promise<Response | undefined> {
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

// --- Route table ---
// Decouples route registration from dispatch. New endpoints are a one-line
// addition here instead of editing the monolithic if/else chain.
//
// ORDERING CONTRACT: STATIC_ROUTES is scanned before PREFIX_ROUTES. This is
// load-bearing for the /api/jobs tree — the static routes /api/jobs/last (GET)
// and /api/jobs/all (DELETE) MUST be tested before the /api/jobs/ prefix routes,
// otherwise those paths would fall through and be treated as job ids ("last" /
// "all"). Static-first matching preserves exactly that.

type RouteHandler = (req: Request, url: URL) => Promise<Response> | Response;
type StaticRoute = { method: string; pathname: string; handler: RouteHandler };
type PrefixRoute = { method: string; prefix: string; handler: (req: Request, id: string) => Promise<Response> | Response };

const STATIC_ROUTES: StaticRoute[] = [
  // Gallery
  { method: "GET", pathname: "/api/gallery/search", handler: (req) => handleGallerySearch(req) },
  { method: "GET", pathname: "/api/gallery", handler: (req) => handleGallery(req) },
  { method: "DELETE", pathname: "/api/gallery", handler: (req) => handleGalleryDelete(req) },
  { method: "POST", pathname: "/api/gallery/caption-missing", handler: (req) => handleGalleryCaptionMissing(req) },
  { method: "POST", pathname: "/api/gallery/ab-test", handler: (req) => handleAbTest(req) },

  // Jobs (static routes — the /api/jobs/last GET and /api/jobs/all DELETE must
  // stay ABOVE the /api/jobs/ prefix routes below; static-first matching ensures
  // this regardless of array order within STATIC_ROUTES vs PREFIX_ROUTES).
  { method: "POST", pathname: "/api/run", handler: (req) => handleRunJob(req) },
  { method: "POST", pathname: "/api/replay", handler: (req) => handleReplayJob(req) },
  { method: "GET", pathname: "/api/jobs", handler: (req) => handleListJobs(req) },
  { method: "GET", pathname: "/api/jobs/last", handler: (req) => handleGetLastJob(req) },
  { method: "DELETE", pathname: "/api/jobs/all", handler: (req) => handleClearJobs(req) },

  // Upload
  { method: "POST", pathname: "/api/upload", handler: (req) => handleUpload(req) },

  // Models
  { method: "GET", pathname: "/api/models/loras", handler: (req) => handleListLoras(req) },
  { method: "GET", pathname: "/api/models/vaes", handler: (req) => handleListVaes(req) },

  // Server info (git branch@commit for title/header)
  { method: "GET", pathname: "/api/server-info", handler: (req) => handleServerInfo(req) },

  // Config
  { method: "GET", pathname: "/api/config", handler: (req) => handleGetConfig(req) },
  { method: "PUT", pathname: "/api/config", handler: (req) => handlePutConfig(req) },
  { method: "POST", pathname: "/api/config/verify-python", handler: (req) => handleVerifyPython(req) },

  // VLM test + active-model query
  { method: "GET", pathname: "/api/vlm/test", handler: (req) => handleVlmTest(req) },
  { method: "GET", pathname: "/api/caption/model", handler: (req) => handleCaptionModel(req) },

  // Model check
  { method: "POST", pathname: "/api/model-check/run", handler: (req) => handleModelCheckRun(req) },
  { method: "POST", pathname: "/api/model-check/scan", handler: (req) => handleModelCheckScan(req) },
  { method: "GET", pathname: "/api/model-check/cache", handler: (req) => handleModelCheckCache(req) },

  // Schema defaults
  { method: "GET", pathname: "/api/schema-defaults", handler: (req) => handleGetSchemaDefaults(req) },

  // Full CLI contract from run.py (single source of truth for accepted flags)
  { method: "GET", pathname: "/api/cli-schema", handler: (req) => handleGetCliSchema(req) },

  // Self-test
  { method: "POST", pathname: "/api/selftest", handler: (req) => handleRunSelfTest(req) },
  { method: "GET", pathname: "/api/selftest/results", handler: (req) => handleSelfTestResults(req) },

  // Caption
  { method: "POST", pathname: "/api/caption/run", handler: (req) => handleCaptionRun(req) },
  { method: "GET", pathname: "/api/caption", handler: (req) => handleCaptionGet(req) },

  // Knowledge extraction
  { method: "GET", pathname: "/api/knowledge/scan", handler: (req) => handleKnowledgeScan(req) },
  { method: "POST", pathname: "/api/knowledge/caption-missing", handler: (req) => handleKnowledgeCaptionMissing(req) },
  { method: "POST", pathname: "/api/knowledge/analyze", handler: (req) => handleKnowledgeAnalyze(req) },
  { method: "GET", pathname: "/api/knowledge/report", handler: (req) => handleKnowledgeGetReport(req) },
  { method: "DELETE", pathname: "/api/knowledge/report", handler: (req) => handleKnowledgeDeleteReport(req) },

  // Code-health knowledge (self-improve workflow producer side — sibling of the
  // generation knowledge routes above).
  { method: "GET", pathname: "/api/code-knowledge/report", handler: (req) => handleCodeKnowledgeReport(req) },
];

const PREFIX_ROUTES: PrefixRoute[] = [
  // Jobs (dynamic id) — static /api/jobs/last and /api/jobs/all are matched
  // first via STATIC_ROUTES, so only genuine ids reach here.
  { method: "GET", prefix: "/api/jobs/", handler: (req, id) => handleGetJob(req, id) },
  { method: "DELETE", prefix: "/api/jobs/", handler: (req, id) => handleDeleteJob(req, id) },
];

async function handleApi(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  // Cross-site defense: browsers send an Origin header on cross-origin POSTs
  // (including multipart/form-data "simple" requests like file uploads, which
  // bypass CORS preflight). A malicious website (Origin: https://evil.com) could
  // otherwise push files onto this server's filesystem via a plain <form> POST.
  // Same pattern as the WebSocket handler (api/ws.ts) — both call the shared
  // originAllowed() helper in lib/origin.ts so a security fix cannot drift
  // between the two sites. An absent Origin (curl, scripts, programmatic clients
  // that don't set one) is allowed through.
  const origin = req.headers.get("origin");
  if (origin && !originAllowed(origin, req.headers.get("host"))) {
    // Distinguish "no Host header at all" (malformed) from a present-but-blocked
    // origin, to preserve the prior 403 response bodies.
    if (!req.headers.get("host")) {
      return Response.json({ ok: false, error: "Invalid request" }, { status: 403 });
    }
    return Response.json({ ok: false, error: "Cross-origin request blocked" }, { status: 403 });
  }

  // Static (exact-match) routes take precedence — this is what keeps
  // /api/jobs/last and /api/jobs/all from being swallowed by the /api/jobs/
  // prefix routes.
  for (const route of STATIC_ROUTES) {
    if (route.method === method && route.pathname === pathname) {
      return route.handler(req, url);
    }
  }

  // Prefix (dynamic-id) routes.
  for (const route of PREFIX_ROUTES) {
    if (route.method === method && pathname.startsWith(route.prefix)) {
      const id = pathname.slice(route.prefix.length);
      return route.handler(req, id);
    }
  }

  return Response.json({ ok: false, error: "Not found" }, { status: 404 });
}
