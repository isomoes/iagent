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

/** True when a Bun.serve() error means the requested port is already taken. */
function isAddrInUse(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === 'EADDRINUSE') return true;
  return /EADDRINUSE|address already in use|in use/i.test(e?.message ?? String(err));
}

/**
 * Bind via `make`. When `allowFallback`, a busy port is retried once on an
 * OS-assigned port (port 0 = any free port) so a second instance — or a leftover
 * process holding the default port — starts on a random free port instead of
 * crashing the launcher. A port-0 request is "any free port" already, so it is
 * never retried.
 *
 * Fallback is gated to packaged mode (the client is same-origin and follows the
 * server to whatever port). In dev the client proxies to a FIXED port
 * (vite.config.ts), so a random fallback would orphan the dev server behind a
 * dead proxy target — there we fail loudly with a hint instead.
 */
function listenWithFallback(
  host: string,
  port: number,
  allowFallback: boolean,
  make: (hostname: string, port: number) => Bun.Server<WsData>,
): Bun.Server<WsData> {
  try {
    return make(host, port);
  } catch (err) {
    if (port === 0 || !isAddrInUse(err)) throw err;
    if (!allowFallback) {
      console.error(
        `✖ port ${port} is already in use, and the dev client proxies to it so it can't move.\n` +
          `  Free it — often a stale \`iagent\` or dev server — then retry:\n` +
          `      kill $(lsof -ti tcp:${port})`,
      );
      throw err;
    }
    console.warn(`port ${port} is in use — retrying on a random free port…`);
    return make(host, 0);
  }
}

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

  // Only the packaged client (served from this process, same-origin) can follow
  // the server to a fallback port. Dev's proxy is pinned to a fixed port.
  const server = listenWithFallback(cfg.host, cfg.port, cfg.publicDir !== '', (hostname, port) =>
    Bun.serve<WsData>({
      hostname,
      port,

      async fetch(req, srv) {
        const url = new URL(req.url);

        if (url.pathname.startsWith('/ws/')) {
          // Returns undefined when the upgrade succeeded (Bun takes over the socket).
          return upgradeWs(req, srv, mgr, cfg);
        }

        const rest = await handleRest(req, mgr, cfg);
        if (rest) return rest;

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
    }),
  );

  // The packaged client is served from THIS process, so a browser's requests
  // carry the server's OWN origin. Port fallback above may have landed us on a
  // different port than requested, so trust whatever we actually bound — on both
  // localhost and 127.0.0.1. (Dev leaves publicDir empty; Vite owns the origin.)
  if (cfg.publicDir) {
    for (const origin of [
      `http://localhost:${server.port}`,
      `http://127.0.0.1:${server.port}`,
    ]) {
      if (!cfg.allowedOrigins.includes(origin)) cfg.allowedOrigins.push(origin);
    }
  }

  if (cfg.port !== 0 && server.port !== cfg.port) {
    console.warn(`⚠ port ${cfg.port} was busy — listening on ${server.port} instead`);
  }
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
