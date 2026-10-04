// Emula in locale la versione pubblicata su Cloudflare Pages: file statici di docs/
// più la funzione functions/api/mistral, senza il server Node dell'app.
// Uso: npm run dev:phone   (MISTRAL_UPSTREAM=http://localhost:3999 per usare il finto provider)
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/mistral/[[path]].js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const PORT = Number(process.env.PORT) || 8788;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/mistral/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const params = { path: url.pathname.slice('/api/mistral/'.length).split('/') };
      const response = await onRequest({ request, params, env: { MISTRAL_UPSTREAM: process.env.MISTRAL_UPSTREAM } });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      return res.end();
    }
    // Come Cloudflare Pages: POST su file statici non consentita
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(DOCS, rel));
    try {
      if (!file.startsWith(DOCS + path.sep)) throw new Error('fuori da docs');
      const data = await fsp.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      // Cloudflare Pages senza 404.html serve index.html (modalità SPA)
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(await fsp.readFile(path.join(DOCS, 'index.html')));
    }
  })
  .listen(PORT, () => console.log(`Versione per telefono (emulazione Cloudflare Pages) su http://localhost:${PORT}`));
