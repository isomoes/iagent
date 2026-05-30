// ============================================================================
// Opaque id helpers — crypto.randomUUID based. Kept tiny + dependency-free so
// session/connection ids are unguessable (they gate WS attach, so guessability
// would weaken the per-session ownership check).
// ============================================================================

/** A fresh, unguessable session id. */
export function newSessionId(): string {
  return crypto.randomUUID();
}

/** A fresh per-connection id (one per attached WebSocket). */
export function newConnectionId(): string {
  return crypto.randomUUID();
}
