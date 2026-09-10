#!/usr/bin/env bun
/**
 * drive-case — the live-drive experiment harness (spwf-ab-closing t07
 * promotion of the scratch harness at output/spwf-drive/drive-case.ts).
 * Drives ONE `-p` case leg against a pinned s2-agent deploy with triple
 * model pinning (flags + PI_MODEL/PI_PROVIDER env + passive receipt model
 * field) and passive session-JSONL detectors. The pure detector core is
 * exported (detectFromLines) so tests adjudicate synthetic sessions with no
 * git and no tokens.
 *
 * Runs ONE live case leg against the s2-agent CLI (source or deployed),
 * isolates its session store (PI_SESSIONS_DIR), then passively detects
 * observables from the session JSONL:
 *   - assistant `read` toolCalls whose path hits a skills/<name>/SKILL.md
 *   - toolCall ORDER (reads vs write/edit calls)
 *   - the bootstrap marker (raw text — NOTE: measured 2026-09-09 across
 *     5,813 session files: the context-event injection does NOT persist to
 *     the store, so marker-in-JSONL is a weak signal; C1 uses the model-
 *     visible self-report instead, labeled tier-3 in the receipt)
 *   - the final assistant reply text
 *
 * Usage:
 *   bun drive-case.ts --case C2 --leg source \
 *     --prompt "..." [--env K=V]... [--extra-arg -ns]... \
 *     [--expect-read brainstorming]... [--forbid-read to-spec]... \
 *     [--expect-reply "ok"] [--cap 180] [--out <receipt.json>]
 *
 * Exit 0 when ALL expectations pass (verdict PASS); 1 otherwise. The receipt
 * is ALWAYS written — a red receipt is evidence, not a harness failure.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const DIST = process.env.S2_DRIVE_DEPLOY ?? "/Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/current";
const MARKER = "superpowers:using-superpowers bootstrap for pi";
const LARGE_MODEL_MIN_B = 7;
const PARAMS_B_RE = /(\d+(?:\.\d+)?)\s*b\b/i;
const EMBEDDING_ID_RE = /embed|bge/i;
const MODEL_ENDPOINT = process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234";

/** A toolCall position: JSONL line number + ordinal within that message's
 *  content array. Same msgLine = same assistant turn (a batch). */
interface CallPos {
  msgLine: number;
  callOrdinal: number;
}

/** Frozen D2 predicate for C2: the skill read turn must STRICTLY precede
 *  the first mutating turn — a read batched in the same assistant message as
 *  a mutation is NON-COMPLIANT (the model acted before the skill could shape
 *  it). Both the live path and the rescan path MUST use this one predicate. */
export function c2Compliant(firstRead: CallPos | null, firstMutate: CallPos | null): boolean {
  return !!firstRead && (!firstMutate || firstRead.msgLine < firstMutate.msgLine);
}

export function posBefore(a: CallPos, b: CallPos): boolean {
  return a.msgLine < b.msgLine || (a.msgLine === b.msgLine && a.callOrdinal < b.callOrdinal);
}

/** D2 write-operator list: a bash call counts as MUTATING only when its
 *  command matches one of these. Recon (ls/cat/rg/head/stat/test/echo sans
 *  redirect) never does; unknown commands default non-mutating but are
 *  recorded in detected.bashCalls[] for human audit. */
export const BASH_WRITE_OPERATORS: RegExp[] = [
  /(^|[\s;|&])>/,
  /(^|[\s;|&])>>/,
  /\btee\b/,
  /\bsed\s+(-[^ ]*\s+)*-i\b/,
  /\brm\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bpatch\b/,
  /\bln\s+-s\b/,
  /<<\w/,
  /\bgit\s+(commit|checkout|switch|rebase|merge|stash|restore)\b/,
  /\bbun\s+(add|remove|install)\b/,
  /\bnpm\s+(i|install|remove)\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bdd\b/,
  /\bpip3?\s+install\b/,
];

export function bashIsMutating(cmd: string): boolean {
  return BASH_WRITE_OPERATORS.some((re) => re.test(cmd));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function args(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name) out.push(process.argv[i + 1] ?? "");
  }
  return out;
}

interface Spec {
  case: string;
  leg: string;
  prompt: string;
  env: Record<string, string>;
  extraArgs: string[];
  expectRead: string[];
  expectReadAny: string[];
  forbidRead: string[];
  expectReply: string | null;
  cap: number;
  out: string;
  dist: string;
  pinProvider: string | null;
  pinModel: string | null;
}

export function detectFromLines(lines: string[]): Detected {
  const d: Detected = {
    sessionFile: null,
    markerRaw: 0,
    markerUserRole: 0,
    reads: [],
    firstRead: null,
    firstMutate: null,
    replyTail: "",
    modelChanges: [],
    assistantModels: new Set(),
    mutatingPaths: [],
    bashCalls: [],
  };
  let msgLine = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    msgLine += 1;
    if (line.includes(MARKER)) {
      d.markerRaw += 1;
      try {
        const j = JSON.parse(line);
        if ((j.message?.role ?? "") === "user") d.markerUserRole += 1;
      } catch {}
    }
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    // per-leg model evidence (D1): model_change events + per-message model
    if (j.type === "model_change") {
      d.modelChanges.push(`${j.provider}/${j.modelId}`);
    }
    const m = j.message;
    if (!m) continue;
    if (m.role === "assistant") {
      if (m.model) d.assistantModels.add(String(m.model));
      if (Array.isArray(m.content)) {
        let callOrdinal = 0;
        for (const part of m.content) {
          if (part?.type !== "toolCall") continue;
          const pos: CallPos = { msgLine, callOrdinal };
          callOrdinal += 1;
          const name = String(part.name ?? "");
          const a = JSON.stringify(part.arguments ?? {});
          if (name === "read") {
            const pm = a.match(/skills\/([a-z0-9-]+)\/SKILL\.md/i);
            if (pm) {
              d.reads.push(pm[1]);
              if (!d.firstRead) d.firstRead = pos;
            }
          }
          if (name === "bash") {
            const cmd = String((part.arguments as any)?.command ?? "");
            const mutating = bashIsMutating(cmd);
            d.bashCalls.push({ cmd: cmd.slice(0, 200), mutating, pos });
            if (mutating && /output\/spwf-|scripts\//.test(a)) {
              if (!d.firstMutate) d.firstMutate = pos;
              const pathM = a.match(/([A-Za-z0-9_./-]+\.(?:ts|js|py))/);
              const p = pathM?.[1] ?? "";
              if (p) {
                d.mutatingPaths.push({ kind: /test|spec/i.test(p) ? "test" : "impl", path: p, pos });
              }
            }
          }
          if (/^(write|edit|multiedit)$/.test(name)) {
            const pathM = a.match(/([A-Za-z0-9_./-]+\.(?:ts|js|py))/);
            const p = pathM?.[1] ?? "";
            if (/output\/spwf-|scripts\//.test(a) && p) {
              if (!d.firstMutate) d.firstMutate = pos;
              d.mutatingPaths.push({ kind: /test|spec/i.test(p) ? "test" : "impl", path: p, pos });
            }
          }
        }
      }
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const texts = m.content.filter((p: any) => p?.type === "text").map((p: any) => p.text as string);
      if (texts.length) d.replyTail = texts.join("\n");
    }
  }
  return d;
}

export function detect(sessionFile: string | null): Detected {
  if (!sessionFile || !existsSync(sessionFile)) return detectFromLines([]);
  return detectFromLines(readFileSync(sessionFile, "utf8").split(/\r?\n/));
}

async function main(): Promise<number> {
  const spec: Spec = {
    case: arg("--case") ?? "unnamed",
    leg: arg("--leg") ?? "source",
    prompt: arg("--prompt") ?? "",
    env: Object.fromEntries(args("--env").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)])),
    extraArgs: args("--extra-arg"),
    expectRead: args("--expect-read").filter(Boolean),
    expectReadAny: (arg("--expect-read-any") ?? "").split(",").filter(Boolean),
    forbidRead: args("--forbid-read").filter(Boolean),
    expectReply: arg("--expect-reply") ?? null,
    cap: Number(arg("--cap") ?? 180),
    out: arg("--out") ?? `output/spwf-drive/receipts/${arg("--case")}-${arg("--leg")}.json`,
    dist: arg("--dist") ?? DIST,
    pinProvider: arg("--pin-provider") ?? null,
    pinModel: arg("--pin-model") ?? null,
  };

  if (!spec.prompt) {
    // --rescan <receipt.json>: re-run detect() + case checks over an existing
    // receipt's session file (zero tokens — the t02 validation mode).
    const rescanPath = arg("--rescan");
    if (rescanPath) {
      const old = JSON.parse(readFileSync(resolve(rescanPath), "utf8"));
      const det = detect(old.sessionFile ?? null);
      const checks: { name: string; ok: boolean; detail: string }[] = [];
      const pass = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
      for (const name of spec.expectRead)
        pass(`read:${name}`, det.reads.includes(name), `reads=[${det.reads.join(",") || "none"}]`);
      if (spec.expectReadAny.length > 0)
        pass(
          `read-any:${spec.expectReadAny.join("|")}`,
          det.reads.some((r) => spec.expectReadAny.includes(r)),
          `reads=[${det.reads.join(",") || "none"}]`,
        );
      for (const name of spec.forbidRead)
        pass(`forbid:${name}`, !det.reads.includes(name), `reads=[${det.reads.join(",") || "none"}]`);
      if (spec.expectReply)
        pass(
          `reply:${JSON.stringify(spec.expectReply).slice(0, 30)}`,
          det.replyTail.toLowerCase().includes(spec.expectReply.toLowerCase()),
          `tail=${JSON.stringify(det.replyTail.slice(0, 200))}`,
        );
      if (spec.case === "C2") {
        const compliant = c2Compliant(det.firstRead, det.firstMutate);
        pass(
          "order:brainstorming-before-mutate",
          compliant,
          `firstRead=${det.firstRead ? `${det.firstRead.msgLine}:${det.firstRead.callOrdinal}` : "none"} firstMutate=${det.firstMutate ? `${det.firstMutate.msgLine}:${det.firstMutate.callOrdinal}` : "none"}`,
        );
      }
      if (spec.case === "C3") {
        pass(
          "read:test-driven-development",
          det.reads.includes("test-driven-development"),
          `reads=[${det.reads.join(",") || "none"}]`,
        );
        const firstTest = det.mutatingPaths.find((w) => w.kind === "test");
        const firstImpl = det.mutatingPaths.find((w) => w.kind === "impl");
        if (firstTest && firstImpl) {
          pass(
            "order:test-before-impl",
            posBefore(firstTest.pos, firstImpl.pos),
            `test@${firstTest.pos.msgLine}:${firstTest.pos.callOrdinal} impl@${firstImpl.pos.msgLine}:${firstImpl.pos.callOrdinal}`,
          );
        } else if (firstTest) {
          pass("order:test-before-impl", true, `test-only write`);
        } else {
          pass(
            "order:test-before-impl",
            false,
            `mutating writes: ${JSON.stringify(det.mutatingPaths.map((w) => `${w.kind}@${w.pos.msgLine}:${w.pos.callOrdinal}:${w.path}`))}`,
          );
        }
      }
      const verdict = checks.length === 0 ? "UNSPECIFIED" : checks.every((c) => c.ok) ? "PASS" : "RED";
      console.log(`[rescan ${old.case}] ${verdict} — ${checks.map((c) => `${c.ok ? "✓" : "✗"}${c.name}`).join(" ")}`);
      console.log(
        JSON.stringify({ case: old.case, sessionFile: old.sessionFile, model: old.model, checks, verdict }, null, 2),
      );
      process.exit(verdict === "PASS" ? 0 : 1);
    }
    console.error("error: --prompt is required (or --rescan <receipt.json>)");
    process.exit(2);
  }

  /** Contention precheck — >1 large (≥7B non-embedding) chat model resident
   *  means generation may exceed even a 300s cap: SKIP the leg (exit 3,
   *  verdict SKIP) rather than burn 19 wall-clock minutes starving (the C2
   *  baseline lesson, 2026-09-09: 4 resident models → two empty assistant
   *  messages in 1102s). --allow-contention overrides for one leg. */
  async function contentionPrecheck(): Promise<{ note: string | null; models: string[] }> {
    try {
      const res = await fetch(`${MODEL_ENDPOINT}/v1/models`);
      if (!res.ok) return { note: `precheck http ${res.status}`, models: [] };
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const large = (body.data ?? [])
        .map((m) => m.id ?? "")
        .filter((id) => !EMBEDDING_ID_RE.test(id))
        .filter((id) => {
          const m = id.match(PARAMS_B_RE);
          return m !== null && Number.parseFloat(m[1]) >= LARGE_MODEL_MIN_B;
        });
      return {
        note: large.length > 1 ? `${large.length} large models resident (${large.join(", ")})` : null,
        models: large,
      };
    } catch (e) {
      return {
        note: `precheck unreachable (${e instanceof Error ? e.message : e}) — no contention evidence`,
        models: [],
      };
    }
  }

  function deployedLabel(): string {
    try {
      const version = JSON.parse(readFileSync(join(spec.dist, "package.json"), "utf8")).version as string;
      return `${version}`;
    } catch {
      return "unknown";
    }
  }

  /** File-reading wrapper: detect() over a session JSONL (rescan mode + main). */

  const t0 = Date.now();
  const { note: contention, models: largeResident } = await contentionPrecheck();
  if (contention && largeResident.length > 1 && !process.argv.includes("--allow-contention")) {
    // Local-endpoint residency is INFORMATIONAL for zai-hosted legs (the boot's
    // default model is remote); it only skips legs when --skip-on-contention is
    // passed explicitly. Recorded either way.
    if (process.argv.includes("--skip-on-contention")) {
      const skip = {
        case: spec.case,
        leg: spec.leg,
        at: new Date().toISOString(),
        verdict: "SKIP",
        reason: contention,
        note: "contention skip — re-run when the endpoint is quiet (C2 lesson: proceeding starved 1102s)",
      };
      mkdirSync(resolve(spec.out, ".."), { recursive: true });
      writeFileSync(resolve(spec.out), `${JSON.stringify(skip, null, 2)}\n`);
      console.log(`[${spec.case}/${spec.leg}] SKIP — ${contention} → ${resolve(spec.out)}`);
      process.exit(3);
    }
  }

  const sessionsDir = resolve(`output/spwf-drive/sessions/${spec.case}-${spec.leg}-${Date.now()}`);
  mkdirSync(sessionsDir, { recursive: true });

  // F0b (measured): PI_SESSIONS_DIR moves the session READER, not the WRITER —
  // boots still persist under ~/.pi/agent/sessions/<dashed-cwd>/. Isolation is
  // therefore by NONCE: embed a unique token in the prompt, then pin the
  // session file whose first user message carries it (robust against the
  // sibling session's concurrent boots in the same cwd).
  const nonce = `spwf-${spec.case}-${spec.leg}-${Date.now()}`;
  const fullPrompt = `${spec.prompt}\n[case-id: ${nonce}]`;

  const cmd = spec.leg === "deployed" ? join(spec.dist, "s2-agent.sh") : "bun";
  // D1 triple pin: explicit flags in argv + env override (shell PI_MODEL/PI_PROVIDER
  // pollution cannot leak through) — the receipt's recorded model must match.
  const pinFlags = spec.pinProvider ? ["--provider", spec.pinProvider, "--model", spec.pinModel ?? ""] : [];
  const argv =
    spec.leg === "deployed"
      ? [cmd, "-p", fullPrompt, ...pinFlags, ...spec.extraArgs]
      : [cmd, join(REPO, "bun-apps/s2-agent/src/cli.ts"), "-p", fullPrompt, ...pinFlags, ...spec.extraArgs];

  const proc = Bun.spawn(argv, {
    cwd: REPO,
    env: {
      ...process.env,
      ...spec.env,
      ...(spec.pinProvider ? { PI_PROVIDER: spec.pinProvider, PI_MODEL: spec.pinModel ?? "" } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // spawnSync's timeout option is not honored by Bun 1.4 — kill manually.
  const killer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, spec.cap * 1000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(killer);
  const r = { exitCode: code, signalCode: proc.signalCode, stdout, stderr };

  const defaultDir = join(
    process.env.HOME ?? "",
    ".pi/agent/sessions",
    "--Users-huangziyu-proj-video_generation__superpowers--",
  );
  const sessionFile = (function pinByNonce(): string | null {
    if (!existsSync(defaultDir)) return null;
    const candidates = readdirSync(defaultDir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => join(defaultDir, n))
      .filter((p) => {
        try {
          return readFileSync(p, "utf8").includes(nonce);
        } catch {
          return false;
        }
      })
      .map((p) => ({ p, m: statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return candidates[0]?.p ?? null;
  })();
  const det = detect(sessionFile);

  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const pass = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  for (const name of spec.expectRead) {
    pass(
      `read:${name}`,
      det.reads.includes(name),
      det.reads.length ? `reads=[${det.reads.join(",")}]` : "no skill reads in session",
    );
  }
  if (spec.expectReadAny.length > 0) {
    pass(
      `read-any:${spec.expectReadAny.join("|")}`,
      det.reads.some((r) => spec.expectReadAny.includes(r)),
      `reads=[${det.reads.join(",") || "none"}]`,
    );
  }
  for (const name of spec.forbidRead) {
    pass(
      `forbid:${name}`,
      !det.reads.includes(name),
      det.reads.includes(name) ? `FORBIDDEN read happened` : `absent (reads=[${det.reads.join(",") || "none"}])`,
    );
  }
  if (spec.expectReply) {
    pass(
      `reply:${JSON.stringify(spec.expectReply).slice(0, 30)}`,
      det.replyTail.toLowerCase().includes(spec.expectReply.toLowerCase()),
      `tail=${JSON.stringify(det.replyTail.slice(0, 200))}`,
    );
  }
  if (spec.case === "C2") {
    // D2 semantics: COMPLIANT ⟺ skill-read exists ∧ (no mutation ∨ read TURN
    // strictly before mutate TURN). Same assistant message = same-turn batch
    // = NON-COMPLIANT (the model acted before the skill could shape it).
    const compliant = c2Compliant(det.firstRead, det.firstMutate);
    pass(
      "order:brainstorming-before-mutate",
      compliant,
      `firstRead=${det.firstRead ? `${det.firstRead.msgLine}:${det.firstRead.callOrdinal}` : "none"} firstMutate=${det.firstMutate ? `${det.firstMutate.msgLine}:${det.firstMutate.callOrdinal}` : "none"}`,
    );
  }
  if (spec.case === "C3") {
    pass(
      "read:test-driven-development",
      det.reads.includes("test-driven-development"),
      `reads=[${det.reads.join(",") || "none"}]`,
    );
    const firstTest = det.mutatingPaths.find((w) => w.kind === "test");
    const firstImpl = det.mutatingPaths.find((w) => w.kind === "impl");
    if (firstTest && firstImpl) {
      pass(
        "order:test-before-impl",
        posBefore(firstTest.pos, firstImpl.pos),
        `test@${firstTest.pos.msgLine}:${firstTest.pos.callOrdinal}(${firstTest.path}) impl@${firstImpl.pos.msgLine}:${firstImpl.pos.callOrdinal}(${firstImpl.path})`,
      );
    } else if (firstTest) {
      pass(
        "order:test-before-impl",
        true,
        `test@${firstTest.pos.msgLine}:${firstTest.pos.callOrdinal} written; no impl write (detail)`,
      );
    } else {
      pass(
        "order:test-before-impl",
        false,
        `mutating writes: ${JSON.stringify(det.mutatingPaths.map((w) => `${w.kind}@${w.pos.msgLine}:${w.pos.callOrdinal}:${w.path}`))}`,
      );
    }
  }
  // D1: pin proof — the recorded model must equal the requested pin, else the leg is void.
  if (spec.pinModel) {
    pass(
      "pin:match",
      det.assistantModels.has(spec.pinModel),
      `pin=${spec.pinModel} recorded=[${[...det.assistantModels].join(",") || "none"}] changes=[${det.modelChanges.join(";") || "none"}]`,
    );
  }
  if (spec.case === "C1") {
    // F0a (measured): the injection does NOT persist to the session store —
    // no passive marker check belongs in the verdict. C1's detector is the
    // model-visible self-report (--expect-reply) + pin:match.
  }

  const verdict = checks.length === 0 ? "UNSPECIFIED" : checks.every((c) => c.ok) ? "PASS" : "RED";

  const receipt = {
    case: spec.case,
    leg: spec.leg,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    deployedLabel: spec.leg === "deployed" ? deployedLabel() : null,
    dist: spec.dist,
    pin: spec.pinProvider ? `${spec.pinProvider}/${spec.pinModel}` : null,
    model: {
      assistantModels: [...det.assistantModels],
      modelChanges: det.modelChanges,
    },
    argv:
      spec.leg === "deployed"
        ? ["<dist>/s2-agent.sh", "-p", spec.prompt, ...pinFlags, ...spec.extraArgs]
        : ["bun", "bun-apps/s2-agent/src/cli.ts", "-p", spec.prompt, ...pinFlags, ...spec.extraArgs],
    env: spec.env,
    cwd: REPO,
    nonce,
    sessionsDir,
    sessionFile,
    detected: { ...det, assistantModels: [...det.assistantModels] },
    contention: contention,
    checks,
    verdict,
    exitCode: r.exitCode,
    timedOut: r.exitCode === null || r.signalCode !== null,
    stdoutTail: r.stdout.toString().slice(-400),
    stderrTail: r.stderr.toString().slice(-400),
  };

  mkdirSync(resolve(spec.out, ".."), { recursive: true });
  writeFileSync(resolve(spec.out), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    `[${spec.case}/${spec.leg}] ${verdict} — ${checks.map((c) => `${c.ok ? "✓" : "✗"}${c.name}`).join(" ")} → ${resolve(spec.out)}`,
  );
  process.exit(verdict === "PASS" ? 0 : 1);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
