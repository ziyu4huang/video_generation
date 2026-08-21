import type { Message } from "@earendil-works/pi-ai";

/** Host preparation.fileOps shape (Set-backed). */
export interface HostFileOps {
  read: Iterable<string>;
  written: Iterable<string>;
  edited: Iterable<string>;
}

export interface FileOpsSummary {
  readonly read: string[];
  readonly written: string[];
  readonly edited: string[];
}

const WRITE_TOOLS = new Set(["write", "write_file", "create_file"]);
const EDIT_TOOLS = new Set(["edit", "edit_file", "multi_edit", "patch", "apply_patch"]);
const READ_TOOLS = new Set(["read", "read_file", "glob", "grep", "ls"]);

/** Path-like argument keys across the tool families used in this repo. */
const PATH_KEYS = ["path", "file_path", "filePath", "filename", "notebook_path"] as const;

function collectPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v) out.push(v);
  }
  if (Array.isArray(args.edits)) {
    for (const e of args.edits) {
      const p = (e as Record<string, unknown> | null)?.path ?? (e as Record<string, unknown> | null)?.file_path;
      if (typeof p === "string") out.push(p);
    }
  }
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (typeof f === "string") out.push(f);
      else {
        const p = (f as Record<string, unknown> | null)?.path;
        if (typeof p === "string") out.push(p);
      }
    }
  }
  return out;
}

type ToolCallBlock = { type: "toolCall"; name: string; arguments: Record<string, unknown> };

export function extractFileOps(messages: readonly Message[], hostFileOps?: HostFileOps): FileOpsSummary {
  const read = new Set<string>(hostFileOps?.read ?? []);
  const written = new Set<string>(hostFileOps?.written ?? []);
  const edited = new Set<string>(hostFileOps?.edited ?? []);
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const call = block as unknown as ToolCallBlock | null;
      if (!call || call.type !== "toolCall" || typeof call.name !== "string") continue;
      const bucket = WRITE_TOOLS.has(call.name)
        ? written
        : EDIT_TOOLS.has(call.name)
          ? edited
          : READ_TOOLS.has(call.name)
            ? read
            : undefined;
      if (!bucket) continue;
      for (const p of collectPaths(call.arguments ?? {})) bucket.add(p);
    }
  }
  return { read: [...read].sort(), written: [...written].sort(), edited: [...edited].sort() };
}

export function allFiles(ops: FileOpsSummary): string[] {
  return [...new Set([...ops.read, ...ops.edited, ...ops.written])].sort();
}

export function verifiedFilesBlock(ops: FileOpsSummary): string {
  const line = (label: string, files: readonly string[]) => `${label}: ${files.length ? files.join(", ") : "(none)"}`;
  return `<verified-files>\n${line("Edited", ops.edited)}\n${line("Read", ops.read)}\n${line("Written", ops.written)}\n</verified-files>`;
}
