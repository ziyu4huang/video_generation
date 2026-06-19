import { getGitInfo } from "../lib/git-info";

/** Read-only server metadata (git branch + commit) for the UI title/header. */
export async function handleServerInfo(_req: Request): Promise<Response> {
  const { branch, commit } = getGitInfo();
  return Response.json({ branch, commit });
}
