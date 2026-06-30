/**
 * Persistent session store helpers — mirrors pi-agent TUI behavior.
 *
 * Sessions are stored as append-only JSONL trees under
 * ~/.pi/agent/sessions/<encoded-cwd>/ by default (managed by SessionManager).
 *
 * Resolution rules for the `chat` sub-command:
 *   (default / --resume)   continue most recent session, else new
 *   --new                  force a fresh session
 *   --session <id>         open a specific session by id
 *   --list                 list sessions for this cwd (no session built)
 *   --no-session           in-memory only (no persistence) — for sub-agents
 */
import {
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

export interface SessionResolution {
  manager: SessionManager;
  /** How the session was obtained, for user-facing banners. */
  kind: "new" | "resumed" | "opened";
  /** Session id (file stem), when resuming/opening. */
  sessionId?: string;
  /** How many prior messages were loaded. */
  priorMessages?: number;
  /** Resolved conversation context (root → leaf) from the session manager. */
  context?: ReturnType<SessionManager["buildSessionContext"]>;
}

/**
 * Resolve a SessionManager according to the chat flags.
 *
 * @param cwd         working directory (determines the session dir)
 * @param opts.new    force a brand-new session
 * @param opts.resume continue most recent (default behavior when no flag given)
 * @param opts.sessionId open a specific session by id
 * @param opts.noSession in-memory only (no file persistence) — for sub-agents
 */
export async function resolveSession(
  cwd: string,
  opts: { new?: boolean; resume?: boolean; sessionId?: string; noSession?: boolean } = {},
): Promise<SessionResolution> {
  // --no-session: ephemeral in-memory session, never persisted.
  if (opts.noSession) {
    const manager = SessionManager.inMemory(cwd);
    return { manager, kind: "new", sessionId: manager.getSessionId() ?? undefined };
  }
  if (opts.sessionId) {
    const info = (await listSessions(cwd)).find(
      (s) => s.id === opts.sessionId || s.path.endsWith(`/${opts.sessionId}.jsonl`),
    );
    if (!info) {
      throw new Error(
        `Session not found: ${opts.sessionId}\n  Run \`chat --list\` to see available sessions.`,
      );
    }
    const manager = SessionManager.open(info.path);
    const { priorMessages, context } = attachContext(manager);
    return { manager, kind: "opened", sessionId: info.id, priorMessages, context };
  }

  if (opts.new) {
    const manager = SessionManager.create(cwd);
    return { manager, kind: "new", sessionId: manager.getSessionId() ?? undefined };
  }

  // default + --resume: continue most recent, else create new
  const recent = SessionManager.continueRecent(cwd);
  const sessionId = recent.getSessionId();
  const { priorMessages, context } = attachContext(recent);
  if (sessionId && priorMessages > 0) {
    return { manager: recent, kind: "resumed", sessionId, priorMessages, context };
  }
  // continueRecent falls back to a new session when none exists
  return { manager: recent, kind: "new", sessionId: recent.getSessionId() ?? undefined };
}

/** List sessions for a cwd, most-recently-modified first. */
export async function listSessions(cwd: string): Promise<SessionInfo[]> {
  const all = await SessionManager.list(cwd);
  return all.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

function attachContext(manager: SessionManager): {
  priorMessages: number;
  context: ReturnType<SessionManager["buildSessionContext"]>;
} {
  const context = manager.buildSessionContext();
  return { priorMessages: context.messages.length, context };
}
