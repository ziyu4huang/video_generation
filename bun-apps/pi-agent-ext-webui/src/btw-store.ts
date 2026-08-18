/**
 * btw-store.ts — branch-question queue for the BTW tab (demo).
 * Direction: webui -> agent (the REVERSE of ask cards). The user authors a
 * question in the browser, optionally seeded with report context; the agent
 * consumes the pending list (webui tool mode "btw") and answers in chat,
 * then resolves. Mirror contract copies report-persist: BEST-EFFORT JSONL
 * event log (create/resolve lines), failures silent, never breaks a route.
 */
import { statSync } from "node:fs";
import { appendLine, readLines } from "./jsonl-mirror.js";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BtwEntry {
  id: string;
  question: string;
  chips: string[];
  aboutId?: string;
  aboutTitle?: string;
  createdAt: number;
  resolvedAt?: number;
}

export type NewBtwEntry = Omit<BtwEntry, "id" | "createdAt">;

export interface BtwStore {
  list(): BtwEntry[];
  create(entry: NewBtwEntry): BtwEntry;
  resolve(id: string, at?: number): boolean;
}

/** v1 cap on replayed history (event lines; the pending list is tiny anyway). */
export const BTW_RESTORE_CAP = 200;

function btwDir(): string {
  const base = process.env["WEBUI_REPORT_DIR"];
  return base && base.trim() !== "" ? base : join(homedir(), ".pi", "webui", "reports");
}

export function btwPersistPath(port: number): string {
  return join(btwDir(), "btw-" + port + ".jsonl");
}

export type BtwValidation = { ok: true; entry: NewBtwEntry } | { ok: false; error: string };

/** Validate + normalize a POST /api/btw body. Pure — shared by route + tests. */
export function buildBtwEntry(body: unknown): BtwValidation {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (typeof b["question"] !== "string" || b["question"].trim().length === 0)
    return { ok: false, error: "question must be a non-empty string" };
  if (b["question"].length > 8000) return { ok: false, error: "question too long (max 8000)" };
  const chipsRaw = b["chips"] ?? [];
  if (!Array.isArray(chipsRaw)) return { ok: false, error: "chips must be an array" };
  const chips = chipsRaw.filter((c): c is string => typeof c === "string").map((c) => c.trim()).filter((c) => c !== "");
  if (chips.length > 6) return { ok: false, error: "too many chips (max 6)" };
  if (chips.some((c) => c.length > 120)) return { ok: false, error: "chip too long (max 120)" };
  const aboutId = typeof b["aboutId"] === "string" ? b["aboutId"].slice(0, 200) : undefined;
  const aboutTitle = typeof b["aboutTitle"] === "string" ? b["aboutTitle"].slice(0, 200) : undefined;
  return {
    ok: true,
    entry: { question: b["question"], chips, ...(aboutId ? { aboutId } : {}), ...(aboutTitle ? { aboutTitle } : {}) },
  };
}

function btwId(now: number): string {
  return "btw-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

/** Replay the event mirror: create lines append entries; resolve lines mark
 * them answered. Corrupt/unknown lines skip. Never throws. */
export function loadBtw(path: string): BtwEntry[] {
  try {
    // cap on the replayed (non-empty) lines; readLines never throws.
    const lines = readLines(path).slice(-BTW_RESTORE_CAP);
    const out: BtwEntry[] = [];
    for (const line of lines) {
      const s = line.trim();
      if (s === "") continue;
      try {
        const v = JSON.parse(s) as Record<string, unknown>;
        if (v["type"] === "create" && typeof v["entry"] === "object" && v["entry"] !== null) {
          const e = v["entry"] as Record<string, unknown>;
          if (typeof e["id"] === "string" && typeof e["question"] === "string") {
            out.push({
              id: e["id"],
              question: e["question"],
              chips: Array.isArray(e["chips"]) ? (e["chips"] as unknown[]).filter((c): c is string => typeof c === "string") : [],
              ...(typeof e["aboutId"] === "string" ? { aboutId: e["aboutId"] } : {}),
              ...(typeof e["aboutTitle"] === "string" ? { aboutTitle: e["aboutTitle"] } : {}),
              createdAt: typeof e["createdAt"] === "number" ? e["createdAt"] : 0,
            });
          }
        } else if (v["type"] === "resolve" && typeof v["id"] === "string" && typeof v["at"] === "number") {
          const hit = out.find((e) => e.id === v["id"]);
          if (hit && !hit.resolvedAt) hit.resolvedAt = v["at"];
        }
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function mirror(path: string, event: Record<string, unknown>): void {
  appendLine(path, event);
}

export function createBtwStore(path: string, now = () => Date.now()): BtwStore {
  const entries = loadBtw(path);
  return {
    list: () => entries.slice(),
    create(entry: NewBtwEntry): BtwEntry {
      const e: BtwEntry = { ...entry, id: btwId(now()), createdAt: now() };
      entries.push(e);
      mirror(path, { type: "create", entry: e });
      return e;
    },
    resolve(id: string, at = now()): boolean {
      const hit = entries.find((e) => e.id === id && !e.resolvedAt);
      if (!hit) return false;
      hit.resolvedAt = at;
      mirror(path, { type: "resolve", id, at });
      return true;
    },
  };
}

/** Data tab demo: live pipeline telemetry snapshot (fs sizes; never throws). */
export function btwDataSummary(
  reportPath: string,
  btwPath: string,
  store: BtwStore,
  port: number,
): Record<string, string | number> {
  const size = (p: string): number => {
    try {
      return statSync(p).size;
    } catch {
      return -1; // mirror not created yet — surfaced as -1
    }
  };
  return {
    port,
    uptimeSec: Math.round(process.uptime()),
    reportMirrorBytes: size(reportPath),
    btwPending: store.list().filter((e) => !e.resolvedAt).length,
    btwMirrorBytes: size(btwPath),
    generatedAt: new Date().toISOString(),
  };
}
