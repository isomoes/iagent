// ============================================================================
// Client config: base-URL derivation.
//
// URLs: in dev, Vite proxies /api and /ws to the Bun server (see vite.config),
// so we use same-origin relative paths and only need to flip http(s)->ws(s)
// for the WebSocket scheme. This also works unchanged when the client is
// served by the same origin as the API in production.
// ============================================================================

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

/** Build the per-session WebSocket URL. */
export function sessionWsUrl(sessionId: string): string {
  const url = new URL(`${wsBase()}/${encodeURIComponent(sessionId)}`, window.location.origin);
  return url.toString();
}
