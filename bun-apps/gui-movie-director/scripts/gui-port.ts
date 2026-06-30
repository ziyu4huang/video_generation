/**
 * gui-port — discover the running Bun GUI server's port for THIS worktree.
 *
 * Each worktree runs its own GUI on its own port (primary=3099, linked=derived —
 * see lib/worktree.ts). Use this to find YOUR worktree's server so an agent (or
 * you) never confuses it with another worktree's.
 *
 *   bun run gui:port            # this worktree's server url (exit 1 if not running)
 *   bun run gui:port --all      # all running servers, every worktree
 *   bun run gui:port --json     # machine-readable { root, own, all }
 *
 * The registry is shared across worktrees (<git-common-dir>/...json); reads also
 * prune entries whose pid has died, so crashed servers don't linger.
 */
import { listLiveServers, findOwnServer } from "../lib/gui-registry";

/** Human-readable elapsed since startedAt (s / m+s / h+m). */
export function ageLabel(startedAt: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export interface GuiPortResult {
  code: number;
  output: string;
}

/** Pure entry — returns exit code + stdout text (no process.exit; testable). */
export function guiPortMain(opts: {
  argv: string[];
  ownRoot: string | null;
  now?: number;
}): GuiPortResult {
  const { argv, ownRoot } = opts;
  const now = opts.now ?? Date.now();
  const wantAll = argv.includes("--all") || argv.includes("--list");
  const wantJson = argv.includes("--json");
  const all = listLiveServers();
  const own = ownRoot ? findOwnServer(ownRoot) : undefined;
  const lines: string[] = [];

  if (wantJson) {
    lines.push(JSON.stringify({ root: ownRoot, own: own ?? null, all }, null, 2));
    return { code: 0, output: lines.join("\n") };
  }

  if (wantAll) {
    if (all.length === 0) {
      lines.push("No GUI servers running. Start one with: bun run dev");
    } else {
      lines.push("Running GUI servers:");
      for (const s of all) {
        const mark = s.root === ownRoot ? "  ← this worktree" : "";
        lines.push(`  ${s.url}  (pid ${s.pid}, up ${ageLabel(s.startedAt, now)})  ${s.root}${mark}`);
      }
    }
    return { code: 0, output: lines.join("\n") };
  }

  if (own) {
    return { code: 0, output: own.url };
  }

  lines.push(
    ownRoot
      ? `No GUI server registered for this worktree (${ownRoot}). Start one with: bun run dev`
      : "No GUI server running. Start one with: bun run dev",
  );
  return { code: 1, output: lines.join("\n") };
}

// CLI entry — only when run as a script (Bun's import.meta.main), not when imported.
if (import.meta.main) {
  function detectOwnRoot(): string | null {
    try {
      const res = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (res.exitCode === 0) return res.stdout.toString().trim() || null;
    } catch {
      // not a git repo — ownRoot stays null (no worktree identity)
    }
    return null;
  }

  const result = guiPortMain({ argv: process.argv.slice(2), ownRoot: detectOwnRoot() });
  console.log(result.output);
  process.exit(result.code);
}
