// ============================================================================
// Executable entrypoint — the thin runner behind `bun start` / `bun --watch`.
// index.ts is a pure library (exports startServer) so it can be imported (by
// the packaged CLI) without side effects; this file is the one that actually
// boots a server when run directly.
// ============================================================================

import { startServer } from './index.js';

startServer();
