// ============================================================================
// Client config: auth token + base-URL derivation.
//
// Token resolution order (first hit wins):
//   1. localStorage 'iagent.token'  — lets you override per-browser at runtime.
//   2. import.meta.env.VITE_IAGENT_TOKEN — baked at build/dev time (.env).
//   3. 'dev-token' — the shared DEV_TOKEN default (loud-warning territory).
//
// URLs: in dev, Vite proxies /api and /ws to the Bun server (see vite.config),
// so we use same-origin relative paths and only need to flip http(s)->ws(s)
// for the WebSocket scheme. This also works unchanged when the client is
// served by the same origin as the API in production.
// ============================================================================

import { DEV_TOKEN } from '@iagent/shared';

const TOKEN_STORAGE_KEY = 'iagent.token';

/** Resolve the auth token (localStorage > build env > dev default). */
export function getToken(): string {
  try {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored && stored.trim() !== '') return stored.trim();
  } catch {
    // localStorage may be unavailable (private mode / SSR); fall through.
  }
  const fromEnv = import.meta.env.VITE_IAGENT_TOKEN;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();
  return DEV_TOKEN;
}

/** Persist a token override for this browser. */
export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // best-effort only.
  }
}

/** True when the effective token is still the insecure dev default. */
export function isDevToken(): boolean {
  return getToken() === DEV_TOKEN;
}

/** REST base path. Same-origin; Vite proxies it to the Bun server in dev. */
export function apiBase(): string {
  return '/api';
}

/**
 * WebSocket base URL for the data path. Derived from the current page origin
 * with the scheme flipped to ws/wss. In dev, Vite proxies /ws (ws:true) to the
 * Bun server, so this resolves to ws://localhost:5173/ws and is tunneled.
 */
export function wsBase(): string {
  const { protocol, host } = window.location;
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${host}/ws`;
}

/** Build the per-session WebSocket URL, carrying the token as a query param. */
export function sessionWsUrl(sessionId: string, token: string): string {
  const url = new URL(`${wsBase()}/${encodeURIComponent(sessionId)}`, window.location.origin);
  // Token on the query string: WS browser API can't set Authorization headers,
  // so the server also accepts ?token= on the upgrade (see ws/gateway).
  url.searchParams.set('token', token);
  return url.toString();
}
