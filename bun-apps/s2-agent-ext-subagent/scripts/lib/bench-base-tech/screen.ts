/**
 * Screen-lane core — MINIMAL PORT of tui-drive.ts's pty/screen machinery
 * (spec D3: port/reimplement, never import — importing a side-effectful
 * script RUNS it). Carries every load-bearing pty learning:
 *
 *  1. xterm-headless is a browser-flavored UMD — shim window/document/self
 *     for load, then strip. Feed bytes in 64-byte AWAITED chunks (a large
 *     single write stalls its WriteBuffer under Bun; the screen silently
 *     never updates).
 *  2. TERM=xterm-256color must be forced (an inherited dumb degrades the TUI
 *     to static output).
 *  3. pi-tui probes the terminal at boot: answer primary DA (`\x1b[c`) with
 *     the xterm reply `\x1b[?1;2c`, stay SILENT on the kitty `\x1b[?u`
 *     query (answering commits the host to CSI-u key encoding).
 *  4. Live markers only: settle predicates must NOT fire on transcript text.
 */
import os from "node:os";

// ── xterm-headless UMD shim load (idempotent under the bench's module graph) ──
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.self = globalThis;
g.navigator ??= { userAgent: "s2-bench13", platform: os.platform() };
g.document = { createElement: () => ({ style: {} }) };
const { Terminal: XTerm } = await import("xterm-headless");
delete g.window;
delete g.document;
delete g.self;

export { XTerm };

/** 64-byte slices of a byte payload (pure — unit-tested chunking contract). */
export function chunkBytes(u8: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < u8.length; i += 64) out.push(u8.subarray(i, Math.min(i + 64, u8.length)));
  return out;
}

/**
 * Terminal-query responder: replies to primary DA exactly once per query,
 * stays silent on kitty protocol queries. `write` is the lane's input path.
 * Returns the passthrough handler for every outbound chunk.
 */
export function makeQueryResponder(write: (s: string) => void): (u8: Uint8Array) => void {
  let inReply = false;
  return (u8: Uint8Array) => {
    if (inReply) return;
    const s = new TextDecoder().decode(u8);
    if (s.includes("\x1b[c")) {
      inReply = true;
      write("\x1b[?1;2c");
      inReply = false;
    }
    // kitty `\x1b[?u` — deliberately SILENT (legacy key encoding).
  };
}

/** Spinner/live-marker regexes — settle predicates require these ABSENT. */
export const LIVE_MARKER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Working\.\.\./;

export function screenText(term: InstanceType<typeof XTerm>): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n");
}

/** Paced keystroke submit: small sleeps around the payload and the Enter. */
export async function pacedWrite(write: (s: string) => void, text: string, sleep: (ms: number) => Promise<void>) {
  write(text);
  await sleep(250);
  write("\r");
}

/** The rendered-truth boot gate regex: deployed status bar line. */
export const BOOT_MODEL_RE = /\(zai\)\s*glm-5\.3/;
