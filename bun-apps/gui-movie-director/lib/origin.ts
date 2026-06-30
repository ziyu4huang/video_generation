// Shared cross-origin allowlist for the HTTP API (api/routes.ts) and the
// WebSocket upgrade handler (api/ws.ts). Both sites previously copy-pasted the
// same port-extraction + loopback-allowlist block; centralizing it here ensures
// a security fix applied to one site cannot be missed in the other.
//
// Security model: browsers send an Origin header on cross-origin POSTs and on
// the WebSocket handshake. A malicious website (Origin: https://evil.com) could
// otherwise drive this localhost server. We use a FIXED allowlist of loopback
// origins for the port this server is bound to (extracted from the Host header,
// since the port is dynamic per worktree) — NOT the request's own Origin
// (vulnerable to DNS rebinding). An absent Origin (curl, scripts, programmatic
// clients that don't set one) is allowed through.

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const DEFAULT_PORT = "3099";

/**
 * Returns true if the request's Origin is permitted for this server.
 *
 * @param origin - the Origin header value (null if absent)
 * @param host   - the Host header value (null if absent)
 * @returns true if the origin is allowed (or absent); false if it is present
 *          but does not match the loopback allowlist for this port
 */
export function originAllowed(origin: string | null, host: string | null): boolean {
  if (!origin) return true; // absent Origin (curl/scripts) allowed
  if (!host) return false;

  // Extract port from Host header (IPv6 addresses are bracketed)
  const portMatch = host.match(/:(\d+)$/);
  const port = portMatch ? portMatch[1] : DEFAULT_PORT;

  // Fixed allowlist of permitted origins for this port
  return LOOPBACK_HOSTS.some((h) => origin === `http://${h}:${port}`);
}
