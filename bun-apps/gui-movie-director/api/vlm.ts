import { loadConfig, vlmModelIsAuto } from "../lib/config";

// Mirror caption.py constants — kept in sync manually.
const PREFERRED_VLM = "prism-ml/bonsai-27b-qat";  // Gemma 12B (better, never auto-loaded)
const DEFAULT_VLM   = "qwen/qwen3-vl-4b";              // Qwen 4B  (default, auto-loaded when needed)

interface VlmTestResult {
  ok: boolean;
  error?: string;
  models?: string[];       // all OpenAI-listed models (indexed in LM Studio)
  loadedModels?: string[]; // actually-loaded models (native /api/v1/models check)
  modelLoaded?: boolean;
  activeModel?: string;    // which model `auto` would pick (mirrors _resolve_model)
  willLoad?: boolean;      // true if auto would need to trigger a model load
}

/**
 * Query LM Studio's NATIVE /api/v1/models endpoint which includes
 * `loaded_instances` — unlike /v1/models which lists ALL indexed models
 * regardless of whether they are loaded. Returns the list of loaded model
 * keys, or an empty array when LM Studio is unreachable.
 */
async function getLoadedModels(apiUrl: string): Promise<string[]> {
  try {
    const base = apiUrl.replace(/\/v1\/?$/, "");
    const res = await fetch(`${base}/api/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models ?? [])
      .filter((m: any) => Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0)
      .map((m: any) => (m.key as string) || "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Mirror caption.py's _resolve_model: walk priority list, return whichever
 * candidate is already loaded (Gemma preferred); fall back to Qwen + willLoad.
 */
function resolveAutoModel(loadedModels: string[]): { model: string; alreadyLoaded: boolean } {
  for (const candidate of [PREFERRED_VLM, DEFAULT_VLM]) {
    if (loadedModels.includes(candidate)) return { model: candidate, alreadyLoaded: true };
  }
  return { model: DEFAULT_VLM, alreadyLoaded: false };
}

export async function handleVlmTest(_req: Request): Promise<Response> {
  const cfg = loadConfig();

  // SSRF guard: defense-in-depth against a config.json written before the
  // write-time validation in api/config.ts, or hand-edited config. Reject any
  // vlmApiUrl that is not http(s) on a loopback host before fetching it.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(cfg.vlmApiUrl);
  } catch {
    const result: VlmTestResult = { ok: false, error: "Configured vlmApiUrl is not a valid URL" };
    return Response.json(result, { status: 400 });
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    const result: VlmTestResult = { ok: false, error: "Configured vlmApiUrl must use http or https" };
    return Response.json(result, { status: 400 });
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname.toLowerCase())) {
    const result: VlmTestResult = { ok: false, error: "Configured vlmApiUrl must resolve to localhost/127.0.0.1/::1" };
    return Response.json(result, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${cfg.vlmApiUrl}/models`, { signal: AbortSignal.timeout(5000) });
  } catch (err: any) {
    const result: VlmTestResult = {
      ok: false,
      error: `Connection failed: ${err.message || String(err)}`,
    };
    return Response.json(result, { status: 502 });
  }

  if (!res.ok) {
    const result: VlmTestResult = {
      ok: false,
      error: `Server returned ${res.status} ${res.statusText}`,
    };
    return Response.json(result, { status: 502 });
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    const result: VlmTestResult = {
      ok: false,
      error: "Invalid JSON response from VLM server",
    };
    return Response.json(result, { status: 502 });
  }

  // OpenAI-compatible /v1/models returns { data: [{ id: "model-name", ... }] }
  const models: string[] = (data?.data || []).map((m: any) => m.id || m.name).filter(Boolean);

  // Native /api/v1/models: accurate loaded state (has `loaded_instances`).
  // Run in parallel with the OpenAI call above; fetch here after it resolves.
  const loadedModels = await getLoadedModels(cfg.vlmApiUrl);

  // Resolve which model `auto` would actually use
  const { model: activeModel, alreadyLoaded } = resolveAutoModel(loadedModels);

  // modelLoaded: for a forced model, it must be in loadedModels; for auto,
  // at least one known VLM must be loaded (or we can load Qwen).
  const modelLoaded = vlmModelIsAuto(cfg.vlmModel)
    ? loadedModels.length > 0 || models.length > 0  // backward compat: loaded or indexable
    : loadedModels.includes(cfg.vlmModel);

  const result: VlmTestResult = {
    ok: true,
    models,
    loadedModels,
    modelLoaded,
    activeModel: vlmModelIsAuto(cfg.vlmModel) ? activeModel : cfg.vlmModel,
    willLoad: vlmModelIsAuto(cfg.vlmModel) ? !alreadyLoaded : !loadedModels.includes(cfg.vlmModel),
  };
  return Response.json(result);
}

/**
 * Lightweight endpoint: returns which VLM model `auto` would pick right now,
 * without running a full caption. Used by the caption panel to show the active
 * model without re-triggering the full VLM test.
 */
export async function handleCaptionModel(_req: Request): Promise<Response> {
  const cfg = loadConfig();
  if (!vlmModelIsAuto(cfg.vlmModel)) {
    return Response.json({ activeModel: cfg.vlmModel, alreadyLoaded: null, forced: true });
  }
  const loadedModels = await getLoadedModels(cfg.vlmApiUrl);
  const { model, alreadyLoaded } = resolveAutoModel(loadedModels);
  return Response.json({ activeModel: model, alreadyLoaded, forced: false, loadedModels });
}
