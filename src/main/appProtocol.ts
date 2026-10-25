import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type SurfaceRoots = Record<'wallet' | 'unlock' | 'settings', string>;

/** Inspect the raw path before WHATWG URL parsing can erase dot segments. */
export function appAssetPath(
  raw: string,
  roots: SurfaceRoots,
): { root: string; file: string } | null {
  const match = /^app:\/\/(wallet|unlock|settings)(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/.exec(raw);
  const host = match?.[1];
  if (host !== 'wallet' && host !== 'unlock' && host !== 'settings') return null;
  const encoded = match?.[2] ?? '/';
  if (/%(?:2f|5c|00)/i.test(encoded) || encoded.includes('\\')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const segments = decoded.slice(1).split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  // Also refuse Windows drive/alternate-stream syntax and control characters.
  for (const c of decoded) {
    if (c.charCodeAt(0) < 32 || c === ':') return null;
  }
  if (decoded.includes('\\')) return null;
  const root = roots[host];
  return { root, file: path.resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded)) };
}

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}

export function securityHeaders(csp: string): Headers {
  return new Headers({
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-DNS-Prefetch-Control': 'off',
  });
}

/** File reads happen in main, after resolving both the root and target symlinks. */
export function createAppProtocolHandler(
  roots: SurfaceRoots,
  csp: string,
  fetchFile: (url: string) => Promise<Response>,
): (request: { url: string; method: string }) => Promise<Response> {
  return async (request) => {
    const headers = securityHeaders(csp);
    const reject = (status: number) => new Response(null, { status, headers });
    if (request.method !== 'GET' && request.method !== 'HEAD') return reject(405);
    const target = appAssetPath(request.url, roots);
    if (!target) return reject(403);
    try {
      const [root, file] = await Promise.all([realpath(target.root), realpath(target.file)]);
      if (!contained(root, file)) return reject(403);
      if (!(await stat(file)).isFile()) return reject(404);
      const served = await fetchFile(pathToFileURL(file).href);
      const combined = new Headers(served.headers);
      for (const [key, value] of headers) combined.set(key, value);
      return new Response(request.method === 'HEAD' ? null : served.body, {
        status: served.status,
        statusText: served.statusText,
        headers: combined,
      });
    } catch {
      return reject(404);
    }
  };
}
