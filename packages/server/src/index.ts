// ============================================================================
// Server entry — Bun.serve serving BOTH the REST management API and the
// per-session WebSocket at /ws/:sessionId. Bun-native: native WebSocket +
// Bun.Terminal PTYs. Binds HOST:PORT (127.0.0.1:4517 default).
//
// Wire hygiene per ARCH §Performance: binary frames only, permessage-deflate
// OFF. (TCP_NODELAY is Bun.serve's default — no Nagle.)
// ============================================================================

import { loadConfig } from '@iagent/shared';
import { SessionManager } from './session-manager.js';
import { handleRest } from './management.js';
import { makeStaticHandler } from './static.js';
import { makeWebSocketHandler, upgradeWs, type WsData } from './ws-gateway.js';

/**
 * Boot the iagent server: PTY host + WebSocket gateway + (optionally) the
 * packaged client. Reads config from the environment at call time, so a
 * launcher (the CLI bin) can set env BEFORE calling this. Returns the running
 * Bun.Server; registers SIGINT/SIGTERM for graceful shutdown.
 */
export function startServer(): Bun.Server<WsData> {
  const cfg = loadConfig();

  const mgr = new SessionManager(cfg);
  mgr.startIdleGc();

  const wsHandler = makeWebSocketHandler(mgr, cfg);
  const serveStatic = makeStaticHandler(cfg.publicDir);

  const server = Bun.serve<WsData>({
    hostname: cfg.host,
    port: cfg.port,

    async fetch(req, srv) {
      const url = new URL(req.url);

      // WebSocket data path: /ws/:sessionId
      if (url.pathname.startsWith('/ws/')) {
        // Returns undefined when the upgrade succeeded (Bun takes over the socket).
        return upgradeWs(req, srv, mgr, cfg);
      }

      // REST management path: /api/sessions...
      const rest = await handleRest(req, mgr, cfg);
      if (rest) return rest;

      // Lightweight liveness probe.
      if (url.pathname === '/health') {
        return new Response('ok', { status: 200 });
      }

      // Packaged client (disabled in dev — Vite serves the UI).
      if (serveStatic) {
        const asset = await serveStatic(req);
        if (asset) return asset;
      }

      return new Response('not found', { status: 404 });
    },

    websocket: {
      // Binary frames only; never compress (permessage-deflate off).
      perMessageDeflate: false,
      // Keepalive: Bun sends pings; our protocol also carries app-level ping/pong.
      idleTimeout: 120,
      open: wsHandler.open,
      message: wsHandler.message,
      drain: wsHandler.drain,
      close: wsHandler.close,
    },
  });

  console.log(`iagent server listening on http://${server.hostname}:${server.port}`);
  if (cfg.publicDir) {
    console.log(`  UI    : http://${server.hostname}:${server.port}/`);
  }
  console.log(`  REST  : http://${server.hostname}:${server.port}/api/sessions`);
  console.log(`  WS    : ws://${server.hostname}:${server.port}/ws/:sessionId`);
  console.log(`  agent : ${cfg.agentCmd} ${cfg.agentArgs.join(' ')}`.trimEnd());

  // Graceful shutdown: kill PTYs (proc.kill -> terminal.close) then stop serving.
  function shutdown(signal: string): void {
    console.log(`\n${signal} received — shutting down sessions…`);
    mgr.shutdown();
    server.stop(true);
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}
