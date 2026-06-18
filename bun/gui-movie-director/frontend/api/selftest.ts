import { apiFetch } from "./client";

export function runSelfTest(action: string, testName: string): Promise<{ jobId?: string; error?: string }> {
  return apiFetch("/api/selftest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, test_name: testName }),
  });
}
