/**
 * e2e-preflight — fail FAST on missing deploy-e2e credentials, BEFORE the
 * merge chain pays for a ~2-minute local CI that would die inside the
 * deploy-e2e gate with the opaque
 * `Model "deepseek-v4-flash-vision-exp" is ambiguous across providers`
 * error (measured 2026-09-07: 9 red tests, zero diagnosability).
 *
 * The deploy-e2e lane resolves its provider key by the SAME rule as
 * `scripts/check-deploy-e2e.sh`: ambient env wins, else the rc files
 * (~/.zshrc ~/.bashrc ~/.bash_profile ~/.profile, last `export VAR=` wins,
 * quotes stripped). With NEITHER key resolvable the lane's fallback provider
 * is unauthenticated and the child dies at model resolution — which is the
 * incident this preflight turns into a <1s abort with a copy-pasteable fix.
 *
 * PURE: env and the rc reader are injected. The production CLI wires
 * `process.env` + the real reader; tests inject fakes and never touch the
 * operator's home (the #2186 hermetic discipline).
 */

/** rc files the bash gate greps, by name under the operator's HOME. */
export const E2E_RC_FILES = [".zshrc", ".bashrc", ".bash_profile", ".profile"] as const;

/** Read a file into lines; undefined when it cannot be read. */
export type ReadRcLines = (absolutePath: string) => string[] | undefined;

export interface E2ePreflightOk {
  ok: true;
  /** Advisory lines for the outcome's `warnings[]` (e.g. the pin recommendation). */
  notes: string[];
}
export interface E2ePreflightFail {
  ok: false;
  /** Actionable abort message: what was sought, where, and the exact fix. */
  message: string;
}
export type E2ePreflightResult = E2ePreflightOk | E2ePreflightFail;

/** Strip one layer of matching single/double quotes from an rc value. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Resolve an API key the way `check-deploy-e2e.sh`'s `resolve_gate_api_key`
 * does: ambient env first; else the LAST `export VAR=…` line across the rc
 * files (in order), quotes stripped. Pure — env and reader are injected.
 */
export function resolveRcApiKey(
  env: Record<string, string | undefined>,
  readRcLines: ReadRcLines,
  varName: string,
  rcFiles: readonly string[] = E2E_RC_FILES,
): string | undefined {
  const ambient = env[varName];
  if (ambient) return ambient;
  let found: string | undefined;
  for (const name of rcFiles) {
    const lines = readRcLines(name);
    if (!lines) continue;
    const pattern = new RegExp(`^\\s*export\\s+${varName}=(.*)$`);
    for (const line of lines) {
      const m = pattern.exec(line);
      if (m?.[1] !== undefined) found = stripQuotes(m[1].trim());
    }
  }
  return found;
}

/**
 * The preflight: at least ONE of DEEPSEEK_API_KEY / ZAI_API_KEY must resolve
 * (the deploy-probe suites pick their lane by exactly this pair), and an
 * explicit VERIFY_E2E_MODEL pin must be well-formed `provider/model-id`
 * (#2140 semantics; reused shape from deploy-e2e-recipe's resolveE2eModelPin).
 */
export function preflightE2eLane(
  env: Record<string, string | undefined>,
  readRcLines: ReadRcLines,
  rcFiles: readonly string[] = E2E_RC_FILES,
): E2ePreflightResult {
  const notes: string[] = [];
  const deepseek = resolveRcApiKey(env, readRcLines, "DEEPSEEK_API_KEY", rcFiles);
  const zai = resolveRcApiKey(env, readRcLines, "ZAI_API_KEY", rcFiles);
  if (!deepseek && !zai) {
    return {
      ok: false,
      message:
        `e2e preflight: no deploy-e2e provider key is resolvable — ` +
        `DEEPSEEK_API_KEY and ZAI_API_KEY are both absent from the environment ` +
        `and from ${rcFiles.join(", ")}.\n` +
        `The deploy-e2e gate would burn ~2 minutes and then fail on an ` +
        `ambiguous-model resolution error.\n` +
        `Fix: export DEEPSEEK_API_KEY=<key>   # (or ZAI_API_KEY=<key>; sourcing ~/.zshrc counts), ` +
        `optionally export VERIFY_E2E_MODEL=deepseek/deepseek-v4-flash-vision-exp for the deterministic lane.\n` +
        `If local CI already ran green for this exact head, \`--assume-ci-green <sha>\` skips the gate — and this preflight — entirely.`,
    };
  }
  if (!deepseek || !zai) {
    notes.push(
      `e2e preflight: lane resolved via ${deepseek ? "DEEPSEEK_API_KEY" : "ZAI_API_KEY"} ` +
        `(the other key is absent — fine, the probes pick whichever provider authenticated).`,
    );
  }

  const pin = (env.VERIFY_E2E_MODEL ?? "").trim();
  if (pin === "") {
    notes.push(
      `e2e preflight: VERIFY_E2E_MODEL is unset — recommend VERIFY_E2E_MODEL=deepseek/deepseek-v4-flash-vision-exp ` +
        `for the deterministic-latency lane (#2140).`,
    );
  } else {
    const slash = pin.indexOf("/");
    if (slash <= 0 || slash === pin.length - 1) {
      return {
        ok: false,
        message:
          `e2e preflight: VERIFY_E2E_MODEL="${pin}" is not provider/model-id — ` +
          `the pin would be ignored and the run would fall back to an unauthenticated ` +
          `default. Use the provider/model-id form, e.g. ` +
          `export VERIFY_E2E_MODEL=deepseek/deepseek-v4-flash-vision-exp.`,
      };
    }
    notes.push(`e2e preflight: pin honored — VERIFY_E2E_MODEL=${pin}`);
  }

  for (const [key, hint] of [
    ["PI_AGENT_E2E_PROVIDER", "provider override for the probes"],
    ["PI_AGENT_E2E_MODEL", "model override for the probes"],
  ] as const) {
    if (env[key]) notes.push(`e2e preflight: ${key} is set (${hint}).`);
  }

  return { ok: true, notes };
}
