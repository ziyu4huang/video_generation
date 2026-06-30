import { apiFetch } from "./client";

export interface ServerInfo {
  folder?: string; // worktree dir basename — multi-worktree identity
  branch?: string;
  commit?: string;
}

export function getServerInfo(): Promise<ServerInfo> {
  return apiFetch("/api/server-info");
}
