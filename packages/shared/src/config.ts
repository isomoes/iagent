// ============================================================================
// Server configuration: shape + env loader with sane defaults. Lives in
// @iagent/shared so the types are end-to-end visible; loadConfig is consumed
// by the server entry. Pure (env passed in) for testability.
// ============================================================================

import {
  DEFAULT_BATCH_BYTES,
  DEFAULT_BATCH_MS,
  DEFAULT_HIGH_WATERMARK,
  DEFAULT_LOW_WATERMARK,
} from './protocol.js';

export interface ServerConfig {
  host: string;
  port: number;
  /** Bearer token checked on REST AND on the WS upgrade. */
  token: string;
  /** Origin allowlist (exact match) for REST + WS upgrade. */
  allowedOrigins: string[];

  // Agent spawn defaults (pluggable; overridable per CreateSessionReq).
  agentCmd: string;
  agentArgs: string[];
  agentCwd: string;
  agentEnv: Record<string, string>;

  // Limits / GC.
  maxSessions: number;
  /** Per-session scrollback ring ceiling (bytes). */
  ringBytesPerSession: number;
  /** Total ring memory ceiling across all sessions (bytes). */
  totalRingBytes: number;
  /** Idle-session GC threshold (ms since lastActivity); 0 disables. */
  idleGcMs: number;

  // Flow control / coalescing.
  highWatermark: number;
  lowWatermark: number;
  batchMs: number;
  batchBytes: number;
}

/** Loud, single-source dev-token warning string (server logs it once). */
export const DEV_TOKEN = 'dev-token';

const DEFAULT_PORT = 4517;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_ALLOWED_ORIGIN = 'http://localhost:5173'; // Vite dev server
const DEFAULT_AGENT_CMD = 'claude';

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseListEnv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === '') return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build a ServerConfig from environment (defaults to process.env).
 *
 * Env keys:
 *   PORT, HOST, IAGENT_TOKEN, IAGENT_ALLOWED_ORIGINS (comma list),
 *   IAGENT_AGENT_CMD, IAGENT_AGENT_ARGS (comma list), IAGENT_AGENT_CWD,
 *   IAGENT_MAX_SESSIONS, IAGENT_RING_BYTES, IAGENT_TOTAL_RING_BYTES,
 *   IAGENT_IDLE_GC_MS, IAGENT_HIGH_WATERMARK, IAGENT_LOW_WATERMARK,
 *   IAGENT_BATCH_MS, IAGENT_BATCH_BYTES.
 *
 * IAGENT_TOKEN falls back to DEV_TOKEN ('dev-token'); the caller is expected
 * to emit a loud warning when that default is in effect.
 */
export function loadConfig(
  env: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {},
): ServerConfig {
  const ringBytesPerSession = parseIntEnv(env.IAGENT_RING_BYTES, 4 * 1024 * 1024); // 4 MiB
  const maxSessions = parseIntEnv(env.IAGENT_MAX_SESSIONS, 16);

  return {
    host: env.HOST?.trim() || DEFAULT_HOST,
    port: parseIntEnv(env.PORT, DEFAULT_PORT),
    token: env.IAGENT_TOKEN?.trim() || DEV_TOKEN,
    allowedOrigins: parseListEnv(env.IAGENT_ALLOWED_ORIGINS, [DEFAULT_ALLOWED_ORIGIN]),

    agentCmd: env.IAGENT_AGENT_CMD?.trim() || DEFAULT_AGENT_CMD,
    agentArgs: parseListEnv(env.IAGENT_AGENT_ARGS, []),
    agentCwd: env.IAGENT_AGENT_CWD?.trim() || '.',
    agentEnv: {},

    maxSessions,
    ringBytesPerSession,
    // Default total cap scales with per-session cap but stays bounded.
    totalRingBytes: parseIntEnv(env.IAGENT_TOTAL_RING_BYTES, ringBytesPerSession * maxSessions),
    idleGcMs: parseIntEnv(env.IAGENT_IDLE_GC_MS, 30 * 60 * 1000), // 30 min

    highWatermark: parseIntEnv(env.IAGENT_HIGH_WATERMARK, DEFAULT_HIGH_WATERMARK),
    lowWatermark: parseIntEnv(env.IAGENT_LOW_WATERMARK, DEFAULT_LOW_WATERMARK),
    batchMs: parseIntEnv(env.IAGENT_BATCH_MS, DEFAULT_BATCH_MS),
    batchBytes: parseIntEnv(env.IAGENT_BATCH_BYTES, DEFAULT_BATCH_BYTES),
  };
}

/** True when the effective token is the insecure dev default. */
export function isDevToken(cfg: ServerConfig): boolean {
  return cfg.token === DEV_TOKEN;
}
