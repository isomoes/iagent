// ============================================================================
// Static client serving — the packaged CLI ships a pre-built client and serves
// it from the same origin as the API/WS. In dev this is OFF (publicDir empty);
// Vite serves the UI and proxies /api + /ws to us.
//
// Routing contract: this is the LAST fallback in the fetch handler, reached only
// after /ws/* and /api/* (and /health) have had their turn. So any request that
// gets here is a UI asset or an SPA route:
//   - exact file hit            -> serve it (hashed /assets/* get immutable cache)
//   - no extension, not /assets -> SPA fallback to index.html
//   - missing asset             -> undefined (caller emits 404)
// ============================================================================

import { join, normalize, resolve, sep } from 'node:path';

export type StaticHandler = (req: Request) => Promise<Response | undefined>;

/**
 * Build a static-file handler rooted at `publicDir`, or `undefined` when
 * static serving is disabled (empty dir). The root is resolved once so every
 * request can be checked for path-traversal escapes.
 */
export function makeStaticHandler(publicDir: string): StaticHandler | undefined {
  if (!publicDir) return undefined;
  const root = resolve(publicDir);
  const indexPath = join(root, 'index.html');

  return async (req: Request): Promise<Response | undefined> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return undefined;

    const url = new URL(req.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return undefined; // malformed %-encoding
    }

    // Resolve under root and reject anything that escapes it (path traversal).
    const candidate = resolve(root, '.' + normalize('/' + pathname));
    if (candidate !== root && !candidate.startsWith(root + sep)) return undefined;

    const isAsset = pathname.startsWith('/assets/');
    let file = Bun.file(pathname === '/' ? indexPath : candidate);

    if (!(await file.exists())) {
      // SPA fallback: client-routed paths (no file extension, not an asset)
      // get index.html so deep links work. A missing real asset stays a 404.
      if (isAsset || /\.[a-z0-9]+$/i.test(pathname)) return undefined;
      file = Bun.file(indexPath);
      if (!(await file.exists())) return undefined;
    }

    return new Response(req.method === 'HEAD' ? null : file, {
      headers: {
        // Hashed assets are content-addressed -> cache forever; the HTML shell
        // must always revalidate so new builds are picked up.
        'cache-control': isAsset
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      },
    });
  };
}
