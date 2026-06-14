import { loadConfig } from "../lib/config";

interface VlmTestResult {
  ok: boolean;
  error?: string;
  models?: string[];
  modelLoaded?: boolean;
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
  const modelLoaded = models.some((id) => id === cfg.vlmModel);

  const result: VlmTestResult = {
    ok: true,
    models,
    modelLoaded,
  };
  return Response.json(result);
}
