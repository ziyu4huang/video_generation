/**
 * port-resolver.ts — 3-tier port selection (specs/07 D2).
 *
 * Pure: takes an injectable env (default process.env) so tests are deterministic
 * (no process.env mutation). WEBUI_PORT > PORT > 0 (OS-assigned ephemeral).
 * Invalid values (non-integer / out of [1,65535] / empty) fall through to the
 * next tier, and ultimately to 0.
 *
 * serveWithFallback (web-server.ts) already walks port..port+50 on EADDRINUSE,
 * so held ports — notably 8090 (embed-mlx-server LaunchAgent) — are inherently
 * avoided. There is NO default to 8090.
 */
const MAX_PORT = 65535;

function parsePort(raw: string | undefined): number | null {
  if (!raw) return null;
  // Strict decimal digits ONLY — Number() would accept "0x10" (16) and "1e3"
  // (1000), silently binding a port the user never asked for.
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PORT) return null;
  return n;
}

export function resolvePort(
  env: Record<string, string | undefined> = process.env
): number {
  return parsePort(env.WEBUI_PORT) ?? parsePort(env.PORT) ?? 0;
}
