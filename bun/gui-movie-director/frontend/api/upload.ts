import { apiFetch } from "./client";

export function uploadFile(file: File): Promise<{ path?: string; url?: string; error?: string }> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch("/api/upload", { method: "POST", body: formData });
}
