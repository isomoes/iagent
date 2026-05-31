// ============================================================================
// Build @isomoes/iagent into a self-contained, publishable dist/:
//
//   dist/iagent.js   — the bin: server + @iagent/shared bundled into one
//                      Bun-target file, prefixed with a #!/usr/bin/env bun shebang
//   dist/public/     — the Vite client build, served by the bin at runtime
//
// No npm runtime deps end up in the package: the only non-builtin imports are
// Bun.* globals (kept external by target:'bun') and the workspace packages,
// which are bundled in. Run: `bun run build` (also runs on `npm pack`/publish
// via the prepack script).
// ============================================================================

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(cliDir, '..', '..');
const distDir = join(cliDir, 'dist');
const clientDist = join(repoRoot, 'packages', 'client', 'dist');

// 1. Clean slate.
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// 2. Build the client (Vite) -> packages/client/dist.
console.log('• building client (vite)…');
const client = Bun.spawnSync(['bun', 'run', '--filter', '@iagent/client', 'build'], {
  cwd: repoRoot,
  stdout: 'inherit',
  stderr: 'inherit',
});
if (!client.success) throw new Error('client build failed');
if (!existsSync(join(clientDist, 'index.html'))) {
  throw new Error(`client build produced no index.html at ${clientDist}`);
}

// 3. Bundle the server (+ @iagent/shared, + the bin shim) into one file.
console.log('• bundling server → dist/iagent.js…');
const result = await Bun.build({
  entrypoints: [join(cliDir, 'src', 'cli.ts')],
  outdir: distDir,
  target: 'bun',
  naming: 'iagent.[ext]',
  // Make the bin directly executable under Bun via the shebang.
  banner: '#!/usr/bin/env bun',
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error('server bundle failed');
}

// 4. Ship the client build next to the bin (the bin points IAGENT_PUBLIC_DIR here).
console.log('• copying client → dist/public…');
cpSync(clientDist, join(distDir, 'public'), { recursive: true });

// 5. Mark the bin executable (npm preserves the bit on install).
chmodSync(join(distDir, 'iagent.js'), 0o755);

console.log('✓ built @isomoes/iagent → packages/cli/dist');
