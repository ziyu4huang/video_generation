import { spawnSync } from "node:child_process";

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[\d;]*m/g, "");
}

export function normalizeRunOutput(s: string, pkgName?: string): string {
  let out = stripAnsi(s);
  out = out.replace(/\(\d+(\.\d+)?s\)/g, "(Ns)");           // elapsed timings
  out = out.replace(/\/tmp\/[\w-]+-runtest\.log/g, "/tmp/<log>");
  if (pkgName) out = out.split(pkgName).join("<pkg>");       // inline package name
  return out;
}

export function runScript(
  runner: "bun" | "bash",
  scriptPath: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(runner, [scriptPath, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
  });
  if (r.error) throw r.error; // spawn failure only — never a child's exit code
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

export type GoldenCase = {
  name: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  expectCode?: number;
  out?: string;
  outIs?: "exact" | "normalized";
  pkgName?: string; // substituted in normal-mode stdout via normalizeRunOutput
  errIncludes?: string[]; // raw stderr (unnormalized)
};

export function assertParity(newScriptPath: string, cases: GoldenCase[]): void {
  for (const c of cases) {
    const r = runScript("bun", newScriptPath, c.args, { cwd: c.cwd, env: c.env });
    const code = r.code;
    if (code !== (c.expectCode ?? 0)) {
      throw new Error(`${c.name}: expected exit ${c.expectCode ?? 0}, got ${code}\nstderr: ${r.stderr}`);
    }
    if (c.out !== undefined) {
      const got = c.outIs === "normalized" ? normalizeRunOutput(r.stdout, c.pkgName) : r.stdout;
      if (got.trim() !== c.out.trim()) {
        throw new Error(`${c.name}: stdout mismatch\n--- expected ---\n${c.out}\n--- got ---\n${got}`);
      }
    }
    for (const e of c.errIncludes ?? []) {
      if (!r.stderr.includes(e)) throw new Error(`${c.name}: stderr missing ${JSON.stringify(e)}`);
    }
  }
}
