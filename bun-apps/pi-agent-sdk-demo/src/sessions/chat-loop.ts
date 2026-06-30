/**
 * Chat sub-command — interactive REPL, non-interactive print mode, or JSON mode.
 *
 * Mirrors pi-agent TUI flags so this app's CLI is a drop-in delegation target
 * for the stock `subagent` tool:
 *
 *   chat                          interactive REPL (resume most recent by default)
 *   chat -p / --print "prompt"    print mode: one turn, stream text, exit
 *   chat --mode json "prompt"     NDJSON event stream (for programmatic consumers)
 *   chat --no-session             in-memory session (no persistence) — for sub-agents
 *   chat --tools read,grep        restrict available tools
 *   chat --append-system-prompt F inject file contents as system prompt
 *   chat --new / -r / --session   session selection
 *   chat --list                   list sessions for this cwd
 *
 * Piped stdin is merged into the prompt (print/json mode), like pi TUI:
 *   echo "notes" | bun src/cli.ts chat -p "Summarize"
 */
import { readFileSync } from "node:fs";
import { createSharedSession } from "./shared.ts";
import { listSessions, resolveSession, type SessionResolution } from "./session-store.ts";

export interface ChatOptions {
  new?: boolean;
  resume?: boolean;
  sessionId?: string;
  list?: boolean;
  /** Print mode: send the prompt once, stream the reply as text, then exit. */
  print?: boolean;
  /** JSON mode: emit all session events as NDJSON to stdout. */
  jsonMode?: boolean;
  /** In-memory session (no persistence). */
  noSession?: boolean;
  /** Tool allowlist. */
  tools?: string[];
  /** Path to a file whose contents become the system prompt. */
  appendSystemPrompt?: string;
  /** Idle timeout (ms) before the interactive REPL auto-exits. 0 = disabled. */
  idleTimeoutMs?: number;
  /** Prompt text (positional args after the sub-command). */
  prompt?: string;
}

function banner(res: SessionResolution) {
  switch (res.kind) {
    case "new":
      console.log("✦ new session");
      break;
    case "resumed":
      console.log(`↻ resumed session ${res.sessionId} (${res.priorMessages} prior msgs)`);
      printHistory(res);
      break;
    case "opened":
      console.log(`↳ opened session ${res.sessionId} (${res.priorMessages} prior msgs)`);
      printHistory(res);
      break;
  }
}

/** Print how to resume this session. Shown on every exit path. */
function resumeHint(res: SessionResolution, reason: string) {
  const id = res.sessionId ?? "?";
  console.log(`\n— ${reason}`);
  console.log(`  session saved: ${id}`);
  console.log(`  resume:  bun src/cli.ts chat --session ${id}`);
  console.log(`         bun src/cli.ts chat            (continues most recent)`);
}

/** Max number of recent turns shown when resuming. */
const HISTORY_PREVIEW_TURNS = 6;

function printHistory(res: SessionResolution) {
  const msgs = res.context?.messages;
  if (!msgs || msgs.length === 0) return;
  const total = msgs.length;
  const start = Math.max(0, total - HISTORY_PREVIEW_TURNS);
  const omitted = start;
  console.log();
  if (omitted > 0) {
    console.log(`  … ${omitted} earlier message${omitted === 1 ? "" : "s"} omitted`);
  }
  for (let i = start; i < total; i++) {
    console.log("  " + formatHistoryLine(msgs[i]));
  }
  console.log();
}

export function formatHistoryLine(msg: any): string {
  const role = msg.role;
  let text = "";
  if (role === "user") {
    text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
    return `you  ${truncate(text, 200)}`;
  }
  if (role === "assistant") {
    text = extractText(msg.content);
    return text.trim() ? `ai   ${truncate(text, 200)}` : `ai   (no text — tool calls only)`;
  }
  if (role === "toolResult") {
    return `tool ${msg.toolName} → ${truncate(extractText(msg.content), 100)}${msg.isError ? " (err)" : ""}`;
  }
  return `•    ${truncate(JSON.stringify(msg.content ?? ""), 100)}`;
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c && c.type === "text")
    .map((c: any) => c.text)
    .join("");
}

export function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + " …" : flat;
}

/** Install Ctrl-C / SIGTERM handlers so interrupts still show the resume hint. */
function installSignalHandlers(res: SessionResolution, onExit: () => void, silent = false) {
  const handler = (sig: string) => {
    if (!silent) resumeHint(res, `interrupted (${sig})`);
    onExit();
    process.exit(130);
  };
  process.on("SIGINT", () => handler("Ctrl-C"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

export async function chatLoop(opts: ChatOptions = {}) {
  const cwd = process.cwd();

  // --list: print sessions and exit, no session built.
  if (opts.list) {
    const sessions = await listSessions(cwd);
    if (sessions.length === 0) {
      console.log("No sessions found for this directory.");
      return;
    }
    console.log(`Sessions in ${cwd} (${sessions.length}):\n`);
    for (const s of sessions) {
      const when = s.modified.toISOString().replace("T", " ").slice(0, 16);
      const preview = (s.firstMessage || "(empty)").slice(0, 60);
      console.log(`  ${s.id}  ${when}  [${s.messageCount} msgs]  ${preview}`);
    }
    console.log(`\nResume with: bun src/cli.ts chat --session <id>`);
    return;
  }

  const res = await resolveSession(cwd, {
    new: opts.new,
    resume: opts.resume,
    sessionId: opts.sessionId,
    noSession: opts.noSession,
  });

  const { session } = await createSharedSession({
    sessionManager: res.manager,
    tools: opts.tools,
  });

  // Resolve the final prompt: positional args + piped stdin + system-prompt file.
  const systemPrompt = opts.appendSystemPrompt
    ? readFileSync(opts.appendSystemPrompt, "utf-8")
    : undefined;

  try {
    if (opts.jsonMode) {
      await runJsonMode(session, res, opts.prompt, systemPrompt);
    } else if (opts.print) {
      await runPrintMode(session, res, opts.prompt, systemPrompt);
    } else {
      await runRepl(session, res, opts.idleTimeoutMs);
    }
  } finally {
    session.dispose();
  }
}

/** Build the full prompt string: system prompt + user prompt + piped stdin. */
async function buildPrompt(promptArg: string | undefined, systemPrompt?: string): Promise<string> {
  const piped = await readPipedStdin();
  const parts = [systemPrompt?.trim(), promptArg, piped].filter((s) => s && s.trim());
  return parts.join("\n\n---\n\n");
}

/** JSON mode: emit all session events as NDJSON. No banners, no streaming text. */
async function runJsonMode(
  session: any,
  res: SessionResolution,
  promptArg?: string,
  systemPrompt?: string,
) {
  // First line = session header (like pi).
  process.stdout.write(
    JSON.stringify({
      type: "session",
      version: 3,
      id: res.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    }) + "\n",
  );

  // Second line = model info so consumers know which model is active.
  const modelInfo = session.model as { provider?: string; id?: string; name?: string } | undefined;
  if (modelInfo?.provider) {
    process.stdout.write(
      JSON.stringify({
        type: "model",
        provider: modelInfo.provider,
        id: modelInfo.id,
        name: modelInfo.name,
      }) + "\n",
    );
  }

  // Forward every event as a JSON line.
  const unsubscribe = session.subscribe((event: any) => {
    process.stdout.write(JSON.stringify(event) + "\n");
  });

  installSignalHandlers(res, () => {
    try { session.dispose(); } catch { /* ignore */ }
  }, true);

  try {
    const prompt = await buildPrompt(promptArg, systemPrompt);
    if (!prompt.trim()) {
      process.stdout.write(JSON.stringify({ type: "error", message: "no prompt provided" }) + "\n");
      process.exit(1);
    }
    await session.prompt(prompt);
  } finally {
    unsubscribe();
  }
}

/** Print mode: one turn, stream text reply, exit (session persisted). */
async function runPrintMode(
  session: any,
  res: SessionResolution,
  promptArg?: string,
  systemPrompt?: string,
) {
  banner(res);
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  const prompt = await buildPrompt(promptArg, systemPrompt);
  if (!prompt.trim()) {
    console.error('print mode requires a prompt: chat -p "your question"');
    process.exit(1);
  }
  try {
    await session.prompt(prompt);
    resumeHint(res, "print mode complete");
  } finally {
    unsubscribe();
  }
}

/**
 * Interactive multi-turn REPL.
 * @param idleTimeoutMs  auto-exit after this many ms with no input. 0 = disabled.
 */
async function runRepl(session: any, res: SessionResolution, idleTimeoutMs = 0) {
  banner(res);
  const timeoutHint =
    idleTimeoutMs > 0
      ? ` (auto-exit after ${Math.round(idleTimeoutMs / 1000)}s idle)`
      : "";
  console.log(`pi-agent SDK REPL — Ctrl+D / Ctrl+C or type /exit to quit. Type /help for commands.${timeoutHint}\n`);

  installSignalHandlers(res, () => {
    try { session.dispose(); } catch { /* ignore */ }
  });

  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  try {
    while (true) {
      process.stdout.write("> ");
      const result = await readLineOrTimeout(idleTimeoutMs);

      if (result.kind === "timeout") {
        resumeHint(res, `idle timeout (${Math.round(idleTimeoutMs / 1000)}s)`);
        break;
      }
      if (result.kind === "eof") {
        resumeHint(res, "Ctrl+D received");
        break;
      }
      if (!result.line) continue;
      const line = result.line;
      if (line === "/exit" || line === "/quit") {
        resumeHint(res, "/exit");
        break;
      }
      if (line === "/help") {
        printSlashCommands();
        continue;
      }
      if (line === "/clear") {
        // Clear the terminal then redraw the banner.
        process.stdout.write("\x1b[2J\x1b[H");
        banner(res);
        console.log(`pi-agent SDK REPL — Ctrl+D / Ctrl+C or type /exit to quit.\n`);
        continue;
      }
      console.log();
      await session.prompt(line);
    }
  } finally {
    // Release stdin so the event loop can drain. Without this, an open
    // stdin fd keeps the process alive even after all work is done.
    closeStdin();
    unsubscribe();
  }
}

/** Print the available REPL slash commands. */
function printSlashCommands() {
  console.log("\nSlash commands:");
  console.log("  /help    show this help");
  console.log("  /clear   clear the screen");
  console.log("  /exit    quit the REPL (same as Ctrl+D)");
  console.log("  /quit    alias for /exit\n");
}

/** Detach stdin so the event loop can exit cleanly. */
function closeStdin() {
  try {
    process.stdin.pause();
    process.stdin.destroy();
  } catch {
    /* ignore */
  }
}

type LineResult =
  | { kind: "line"; line: string }
  | { kind: "eof" }
  | { kind: "timeout" };

/**
 * Read one line, racing against an idle timeout.
 *
 * The timeout resolves the SAME promise the stdin handlers would, so there's
 * no deadlock: whichever fires first wins, and listeners are always cleaned up.
 * @param timeoutMs  0 = no timeout (wait forever for input)
 */
function readLineOrTimeout(timeoutMs: number): Promise<LineResult> {
  return new Promise<LineResult>((resolve) => {
    let settled = false;
    const finish = (r: LineResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      resolve(r);
    };

    const buf: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      const s = chunk.toString();
      const i = s.indexOf("\n");
      if (i >= 0) {
        buf.push(Buffer.from(s.slice(0, i)));
        finish({ kind: "line", line: Buffer.concat(buf).toString().trim() });
      } else {
        buf.push(chunk);
      }
    };
    const onEnd = () => finish({ kind: "eof" });

    const timer =
      timeoutMs > 0 ? setTimeout(() => finish({ kind: "timeout" }), timeoutMs) : null;

    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

/** Read piped stdin if not a TTY; returns "" otherwise. */
function readPipedStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const done = (v: string) => {
      if (!settled) { settled = true; resolve(v); }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => done(data));
    process.stdin.on("error", () => done(data));
  });
}



