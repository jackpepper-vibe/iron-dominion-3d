/* Minimal static file server for Iron Dominion 3D.
 *
 *   npm run serve            -> http://localhost:5173/
 *   node scripts/serve.mjs 8080
 *
 * The game is an ES module that imports the vendored Three.js through an import
 * map, and browsers refuse module scripts over file:// — so the page has to be
 * served, even for a headless screenshot. The harnesses import startServer()
 * and bind an ephemeral port; the CLI form is for a human, or for pointing the
 * shared C:/Claude/Tools/shot tool at http://localhost:5173/.
 *
 * Deliberately dependency-free and read-only: GET/HEAD of files under the
 * project root, nothing else.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Resolve a request path to a file under root, or null if it escapes root. */
function localPath(root, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const target = resolve(root, '.' + (clean.endsWith('/') ? clean + 'index.html' : clean));
  return target === root || target.startsWith(root + sep) ? target : null;
}

/**
 * Serve `root` over HTTP on `port` (0 = any free port).
 * @returns {Promise<{origin: string, close: () => Promise<void>}>}
 */
export function startServer({ root = ROOT, port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const file = localPath(root, req.url);
    const info = file && await stat(file).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      const { port: bound } = server.address();
      ok({
        origin: `http://${host === '127.0.0.1' ? 'localhost' : host}:${bound}`,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.argv[2] ?? 5173);
  const { origin } = await startServer({ port });
  console.log(`Iron Dominion 3D -> ${origin}/`);
}
