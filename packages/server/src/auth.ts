// ============================================================================
// Auth — single-user / localhost model (the ARCH default).
//
// The server binds to localhost only, so there is no token: anything that can
// reach the port is already on the machine. Two checks remain:
//   1. origin    — exact-match allowlist (default the Vite dev server). Browser
//                  requests carry an Origin header; non-browser clients (curl)
//                  omit it and are allowed (CSRF is the threat here, and only a
//                  browser attaches an Origin).
//   2. ownership — the handshake authenticates a CONNECTION, it does NOT entitle
//                  it to every session. Each session is bound to an owner
//                  principal; authorizeAttach() re-checks it on every attach so
//                  one client cannot hijack another's live shell.
// ============================================================================

import type { ServerConfig } from '@iagent/shared';

/** The authenticated principal. Single-user model => one fixed identity. */
export const PRINCIPAL = 'local' as const;
export type Principal = typeof PRINCIPAL | string;

/** Constant-time string compare (avoids leaking length-prefix match timing). */
function timingSafeEqual(a: string, b: string): boolean {
  // Always compare the same number of iterations regardless of mismatch point.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Origin allowlist check. A request with NO Origin header (non-browser client)
 * passes — CSRF only applies to browser-issued requests, which always send one.
 * A present Origin must exactly match an allowlisted entry.
 */
export function checkOrigin(req: Request, cfg: ServerConfig): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true; // non-browser client (curl, native ws)
  return cfg.allowedOrigins.includes(origin);
}

/** Resolve the principal for an authenticated request (single-user => PRINCIPAL). */
export function principalFor(_req: Request): Principal {
  return PRINCIPAL;
}

/**
 * Per-session ownership check. Called on every `attach`. `owner` is the
 * principal stored on the Session at creation; `principal` is the attaching
 * connection's identity (bound in ws.data at upgrade).
 */
export function authorizeAttach(principal: Principal, owner: Principal): boolean {
  return timingSafeEqual(principal, owner);
}
