import { getGitInfo } from "../lib/git-info";

/** Read-only server metadata (worktree folder + git branch + commit) for the UI title/header. */
export async function handleServerInfo(_req: Request): Promise<Response> {
  const { folder, branch, commit } = getGitInfo();
  return Response.json({ folder, branch, commit });
}
