// ============================================================================
// `iagent` bin — the single-command launcher published as @isomoes/iagent.
//
// It boots the same Bun server as `bun start`, but first points it at the
// client build bundled alongside this file (dist/public) so ONE process serves
// the UI + API + WS from one origin. Requires Bun (Bun.Terminal is POSIX-only):
//   npx @isomoes/iagent     # respects the #!/usr/bin/env bun shebang
//   bunx @isomoes/iagent
//
// All IAGENT_* / HOST / PORT env vars still apply; we only fill in defaults the
// packaged form needs, and never clobber an explicit override.
// ============================================================================

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '@iagent/server';

const here = dirname(fileURLToPath(import.meta.url));

// The client build is copied next to this bin at dist/public during `build.ts`.
process.env.IAGENT_PUBLIC_DIR ||= join(here, 'public');

// The UI is now same-origin with the API/WS, so a browser's requests carry the
// server's own Origin. Trust localhost + 127.0.0.1 on the bound port by default.
const port = process.env.PORT?.trim() || '4517';
process.env.IAGENT_ALLOWED_ORIGINS ||= `http://localhost:${port},http://127.0.0.1:${port}`;

startServer();
