/**
 * probe-ext.ts — offline auto probe for the wayfind extension's registration
 * surface. Loads the REAL entry (extensions/wayfind.ts, the file pi loads via
 * the registry) against a RECORDING ExtensionAPI and asserts the full surface
 * BY NAME — not by call count. Catches drift the unit tests can't: a renamed
 * command, a dropped tool, a lost event subscription, or a half-registration
 * that throws midway all fail here loudly.
 *
 * Runs both scenarios in one invocation:
 *   1. enabled (default env) → exact set {commands, tool, events}
 *   2. BUN_PI_WAYFIND=0      → registers NOTHING (self-gate)
 *
 *   bun scripts/probe-ext.ts
 *
 * Always prints a table (never silent); exit 0 pass / 1 fail. No LLM, no
 * network, no session. Wired into `bun run test` via the `test:probe` script —
 * CI runs it automatically.
 */
import extension, { __GATE_PROBES__ } from "../extensions/wayfind.ts";

type Surface = {
  commands: string[];
  tools: string[];
  events: string[];
};

/** Minimal recording pi: captures names, no-ops everything else the factory touches. */
function makeRecordingPi() {
  const surface: Surface = { commands: [], tools: [], events: [] };
  const pi = {
    on: (name: string) => {
      surface.events.push(name);
    },
    registerTool: (tool: { name?: string }) => {
      if (!tool?.name) throw new Error("registerTool called with a tool that has no name");
      surface.tools.push(tool.name);
    },
    registerCommand: (name: string) => {
      surface.commands.push(name);
    },
    sendUserMessage: () => {},
    notify: () => {},
    setStatus: () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as Parameters<typeof extension>[0];
  return { pi, surface };
}

const EXPECTED: Surface = {
  commands: ["grill", "wayfind"],
  tools: ["wayfind_effort"],
  events: ["session_start", "turn_end", "session_shutdown"],
};

const ENV_KEY = "BUN_PI_WAYFIND";
const saved = process.env[ENV_KEY];

function diff(label: string, expected: string[], got: string[]): string[] {
  const problems: string[] = [];
  for (const name of expected) {
    if (!got.includes(name)) problems.push(`  MISSING ${label}: ${name}`);
  }
  for (const name of got) {
    if (!expected.includes(name)) problems.push(`  UNEXPECTED ${label}: ${name}`);
  }
  return problems;
}

function restoreEnv() {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
}

function main(): void {
  const problems: string[] = [];

  // ── scenario 1: enabled (default) — exact surface ─────────────────────────
  delete process.env[ENV_KEY];
  let enabled: Surface;
  try {
    const { pi, surface } = makeRecordingPi();
    extension(pi);
    enabled = surface;
  } catch (err) {
    problems.push(`  REGISTRATION THREW (enabled mode): ${err}`);
    enabled = { commands: [], tools: [], events: [] };
  }
  problems.push(...diff("command", EXPECTED.commands, enabled.commands));
  problems.push(...diff("tool", EXPECTED.tools, enabled.tools));
  problems.push(...diff("event", EXPECTED.events, enabled.events));

  // ── scenario 2: BUN_PI_WAYFIND=0 — self-gate, registers nothing ───────────
  process.env[ENV_KEY] = "0";
  let gated: Surface;
  try {
    const { pi, surface } = makeRecordingPi();
    extension(pi);
    gated = surface;
  } catch (err) {
    problems.push(`  REGISTRATION THREW (gated mode): ${err}`);
    gated = { commands: [], tools: [], events: [] };
  } finally {
    restoreEnv();
  }
  for (const [label, names] of Object.entries(gated)) {
    for (const name of names) problems.push(`  UNEXPECTED ${label} under ${ENV_KEY}=0: ${name}`);
  }

  // ── scenario 3: tool-gate probe contract stays well-formed ────────────────
  // qa/collect-probes.ts (tool-gate) consumes __GATE_PROBES__; a shape drift
  // there breaks recall QA silently.
  if (__GATE_PROBES__?.gate !== "wayfind_effort") {
    problems.push(`  __GATE_PROBES__.gate is ${__GATE_PROBES__?.gate}, expected "wayfind_effort"`);
  }
  if (!Array.isArray(__GATE_PROBES__?.controls) || __GATE_PROBES__.controls.length === 0) {
    problems.push("  __GATE_PROBES__.controls must be a non-empty array");
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log("wayfind probe — registration surface (enabled):");
  console.log(`  commands: ${enabled.commands.sort().join(", ") || "(none)"}`);
  console.log(`  tools:    ${enabled.tools.sort().join(", ") || "(none)"}`);
  console.log(`  events:   ${enabled.events.sort().join(", ") || "(none)"}`);
  console.log(
    `  gate=${ENV_KEY}=0 surface: ${gated.commands.length + gated.tools.length + gated.events.length} registrations (expect 0)`,
  );
  console.log(`  __GATE_PROBES__: gate=${__GATE_PROBES__?.gate}, controls=${__GATE_PROBES__?.controls?.length ?? "?"}`);

  if (problems.length > 0) {
    console.error(`\n✗ wayfind probe FAILED (${problems.length} problem(s)):\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log("\n✓ wayfind probe passed");
}

main();
