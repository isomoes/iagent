// ============================================================================
// WebSocket gateway — ONE socket per attached session at /ws/:sessionId.
//
// Upgrade (in index.ts's fetch via upgradeWs):
//   validate origin + path, bind { sessionId, owner, connId } into ws.data,
//   then server.upgrade(req, { data }). The handshake authenticates a
//   CONNECTION; per-session ownership is re-checked on the attach control frame.
//
// websocket handlers:
//   open    -> register a SessionSocket adapter; AWAIT the client's attach.
//   message -> decodeFrame: DATA bytes -> pty.write (NEVER toString at a frame
//              boundary); CONTROL -> attach / resize / ack / ping.
//   drain   -> backpressure cleared -> session.onDrain() resumes flushing.
//   close   -> session.detach() but KEEP the PTY running (tmux-like).
//
// Backpressure: Session.send() returns the Bun send status; <= 0 (-1 = full,
// 0 = dropped) pauses flushing until the drain event. Sends are corked.
// ============================================================================

import {
  decodeFrame,
  encodeControl,
  type ServerConfig,
} from '@iagent/shared';
import type { ServerWebSocket, Server } from 'bun';
import type { SessionManager } from './session-manager.js';
import type { Session, SessionSocket } from './session.js';
import { authorizeAttach, checkOrigin, principalFor, type Principal } from './auth.js';
import { newConnectionId } from './ids.js';

/** Bound on ws.data at upgrade time. */
export interface WsData {
  sessionId: string;
  owner: Principal;
  connId: string;
  /** Set once the client's `attach` frame is processed & authorized. */
  attached: boolean;
}

/** Adapt a Bun ServerWebSocket to the Session's SessionSocket contract. */
function socketFor(ws: ServerWebSocket<WsData>): SessionSocket {
  return {
    send(frame: Uint8Array): number {
      // Bun returns: bytes on success, -1 backpressured, 0 dropped.
      return ws.send(frame);
    },
    cork(fn: () => void): void {
      ws.cork(fn);
    },
    close(code?: number): void {
      ws.close(code);
    },
  };
}

/**
 * Validate + perform the WS upgrade for /ws/:sessionId. Returns a Response
 * (error) when it should NOT upgrade, or undefined when server.upgrade()
 * succeeded (Bun then drives the websocket handlers).
 */
export function upgradeWs(
  req: Request,
  server: Server<WsData>,
  mgr: SessionManager,
  cfg: ServerConfig,
): Response | undefined {
  const url = new URL(req.url);
  const m = /^\/ws\/([^/]+)\/?$/.exec(url.pathname);
  if (!m) return new Response('not found', { status: 404 });

  const sessionId = decodeURIComponent(m[1]!);

  if (!checkOrigin(req, cfg)) return new Response('forbidden origin', { status: 403 });

  const owner = principalFor(req);

  // Session must exist AND be owned by this principal (no hijack via upgrade).
  if (!mgr.authorize(sessionId, owner)) {
    return new Response('not found', { status: 404 });
  }

  const data: WsData = {
    sessionId,
    owner,
    connId: newConnectionId(),
    attached: false,
  };

  const ok = server.upgrade(req, { data });
  if (!ok) return new Response('upgrade failed', { status: 400 });
  return undefined; // upgraded — Bun takes over.
}

/** Build the Bun websocket handler object wired to the SessionManager. */
export function makeWebSocketHandler(mgr: SessionManager, _cfg: ServerConfig) {
  // Map a live ws to the Session it's attached to (for drain/close routing).
  const attachedSession = new WeakMap<ServerWebSocket<WsData>, Session>();

  function handleControl(ws: ServerWebSocket<WsData>, msg: ReturnType<typeof decodeFrame>): void {
    if (msg.kind !== 'control') return;
    const ctrl = msg.msg;
    switch (ctrl.t) {
      case 'attach': {
        // The attach frame must target the session bound at upgrade.
        if (ctrl.sessionId !== ws.data.sessionId) {
          ws.close(1008, 'unauthorized attach');
          return;
        }
        const session = mgr.get(ws.data.sessionId);
        // Re-check per-session ownership on attach (defense in depth vs hijack).
        if (!session || !authorizeAttach(ws.data.owner, session.owner)) {
          ws.close(1008, 'session gone');
          return;
        }
        // Server has no terminal model of its own; the snapshot string is
        // pushed by the client (clientSnapshot) and cached on the Session. On a
        // truncated reconnect session.attach replays that cached snapshot
        // (falling back to a blank reset only if none was ever pushed).
        session.attach(socketFor(ws), ctrl.lastSeq, undefined);
        attachedSession.set(ws, session);
        ws.data.attached = true;
        return;
      }
      case 'resize': {
        attachedSession.get(ws)?.resize(ctrl.cols, ctrl.rows);
        return;
      }
      case 'ack': {
        attachedSession.get(ws)?.applyAck(ctrl.bytes);
        return;
      }
      case 'clientSnapshot': {
        // Cache the client's serialized screen so a future truncated reconnect
        // can replay it (ARCH §Session persistence).
        attachedSession.get(ws)?.setClientSnapshot(ctrl.data);
        return;
      }
      case 'ping': {
        ws.send(encodeControl({ t: 'pong', ts: ctrl.ts }));
        return;
      }
      case 'pong':
        return; // keepalive ack; nothing to do
      default:
        return; // server-only control types ignored if a client sends them
    }
  }

  return {
    open(ws: ServerWebSocket<WsData>): void {
      // Binary frames as Uint8Array (avoids a Buffer copy at the boundary).
      ws.binaryType = 'uint8array';
      // Await the client's attach control frame before streaming anything.
    },

    message(ws: ServerWebSocket<WsData>, raw: string | Buffer | Uint8Array): void {
      // Control/Data are ALWAYS binary frames. A string frame is protocol noise.
      if (typeof raw === 'string') return;
      // Buffer is a Uint8Array subclass; decodeFrame reads the 1-byte prefix.
      const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      let frame: ReturnType<typeof decodeFrame>;
      try {
        frame = decodeFrame(buf);
      } catch {
        return; // malformed frame: drop silently
      }

      if (frame.kind === 'data') {
        // Raw keystrokes/stdin -> PTY. NEVER decoded at the frame boundary.
        if (!ws.data.attached) return; // ignore input before attach
        attachedSession.get(ws)?.writeInput(frame.bytes);
        return;
      }
      handleControl(ws, frame);
    },

    drain(ws: ServerWebSocket<WsData>): void {
      attachedSession.get(ws)?.onDrain();
    },

    close(ws: ServerWebSocket<WsData>): void {
      // Detach but KEEP the PTY running (tmux-like persistence). This ws is the
      // session's only live socket, so an unconditional detach is correct.
      const session = attachedSession.get(ws);
      if (session) {
        session.detach();
        attachedSession.delete(ws);
      }
    },
  };
}
