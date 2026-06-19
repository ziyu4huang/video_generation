import { apiFetch } from "./client";

export interface ServerInfo {
  branch?: string;
  commit?: string;
}

export function getServerInfo(): Promise<ServerInfo> {
  return apiFetch("/api/server-info");
}
