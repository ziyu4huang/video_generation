import { loadConfig } from "../lib/config";

interface VlmTestResult {
  ok: boolean;
  error?: string;
  models?: string[];
  modelLoaded?: boolean;
}

export async function handleVlmTest(_req: Request): Promise<Response> {
  const cfg = loadConfig();

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
