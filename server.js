// Fanfic Studio: server HTTP senza dipendenze esterne (Node >= 18).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));

const store = await import('./lib/store.js');
const { generateStory, continueStory, rewriteChapter, streamInto } = await import('./lib/generator.js');
const { chatSystemPrompt } = await import('./lib/prompts.js');
const { complete } = await import('./lib/llm.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(ROOT, 'public');
const running = new Map(); // storyId -> AbortController

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m || line.trim().startsWith('#')) continue;
      const val = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch {}
}

// ---------- utilità HTTP ----------

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req, limit = 10 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Richiesta troppo grande'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON non valido'), { status: 400 });
  }
}

/** Avvia una risposta NDJSON in streaming; restituisce { emit, signal, end }. */
function startStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  const emit = (obj) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
  };
  return { emit, signal: ac.signal, ac, end: () => res.end() };
}

async function runJob(req, res, story, fn) {
  if (running.has(story.id)) return sendJson(res, 409, { error: 'Una generazione è già in corso per questa storia.' });
  const { emit, signal, ac, end } = startStream(req, res);
  running.set(story.id, ac);
  try {
    await fn(emit, signal);
    const fresh = await store.getStory(story.id);
    emit({ type: 'done', story: fresh });
  } catch (err) {
    if (err.name === 'AbortError' || signal.aborted) {
      emit({ type: 'aborted' });
    } else {
      console.error(err);
      emit({ type: 'error', message: err.message || String(err) });
    }
  } finally {
    running.delete(story.id);
    end();
  }
}

function exportStory(story, format) {
  const parts = [];
  if (format === 'md') {
    parts.push(`# ${story.title}\n`);
    for (const ch of story.chapters) {
      if (story.chapters.length > 1) parts.push(`## ${ch.title}\n`);
      parts.push(ch.content.trim() + '\n');
    }
  } else {
    parts.push(story.title.toUpperCase() + '\n');
    for (const ch of story.chapters) {
      if (story.chapters.length > 1) parts.push(`\n${ch.title}\n${'-'.repeat(Math.min(ch.title.length, 60))}\n`);
      parts.push(ch.content.trim() + '\n');
    }
  }
  return parts.join('\n');
}

// ---------- file statici ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Vietato' });
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    // fallback SPA
    const data = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(data);
  }
}

// ---------- router API ----------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // senza "api"
  const method = req.method;

  // Impostazioni
  if (parts[0] === 'settings') {
    if (parts.length === 1 && method === 'GET') return sendJson(res, 200, store.publicSettings(await store.getSettings()));
    if (parts.length === 1 && method === 'POST') {
      const body = await readBody(req);
      if (body.apiKey === undefined || body.apiKey === null) delete body.apiKey;
      if (body.clearApiKey) body.apiKey = '';
      return sendJson(res, 200, store.publicSettings(await store.saveSettings(body)));
    }
    if (parts[1] === 'test' && method === 'POST') {
      const settings = await store.getSettings();
      const started = Date.now();
      const { text } = await complete(settings, [{ role: 'user', content: 'Rispondi solo con: OK' }], { maxTokens: 20, temperature: 0 });
      return sendJson(res, 200, { ok: true, reply: text.trim().slice(0, 200), ms: Date.now() - started });
    }
  }

  // Elenco modelli dal provider
  if (parts[0] === 'models' && method === 'GET') {
    const s = await store.getSettings();
    const r = await fetch(s.baseUrl.replace(/\/+$/, '') + '/models', {
      headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
    });
    if (!r.ok) return sendJson(res, 502, { error: `Il provider ha risposto ${r.status}` });
    const j = await r.json();
    const models = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
    return sendJson(res, 200, { models });
  }

  // Storie
  if (parts[0] === 'stories') {
    if (parts.length === 1 && method === 'GET') return sendJson(res, 200, await store.listStories());
    if (parts.length === 1 && method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 201, await store.createStory({ title: body.title, brief: body.brief }));
    }

    const id = parts[1];
    const story = await store.getStory(id);
    const action = parts[2];

    if (!action) {
      if (method === 'GET') return sendJson(res, 200, { ...story, running: running.has(id) });
      if (method === 'PUT') {
        const body = await readBody(req);
        if (typeof body.title === 'string') story.title = body.title.trim() || story.title;
        if (body.brief && typeof body.brief === 'object') story.brief = { ...story.brief, ...body.brief };
        if (Array.isArray(body.chapters)) {
          story.chapters = body.chapters.map((c) => ({ title: String(c.title || ''), content: String(c.content || '') }));
        }
        if (Array.isArray(body.outline)) {
          story.outline = body.outline.map((c) => ({ title: String(c.title || ''), summary: String(c.summary || '') }));
        }
        if (Array.isArray(body.messages)) story.messages = body.messages;
        return sendJson(res, 200, await store.saveStory(story));
      }
      if (method === 'DELETE') {
        running.get(id)?.abort();
        await store.deleteStory(id);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (action === 'export' && method === 'GET') {
      const format = url.searchParams.get('format') === 'txt' ? 'txt' : 'md';
      const name = (story.title || 'storia').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 80) || 'storia';
      res.writeHead(200, {
        'Content-Type': format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.${format}`,
      });
      return res.end(exportStory(story, format));
    }

    if (action === 'stop' && method === 'POST') {
      running.get(id)?.abort();
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'generate' && method === 'POST') {
      const body = await readBody(req);
      if (body.userMessage) story.messages.push({ role: 'user', content: String(body.userMessage), at: new Date().toISOString() });
      await store.saveStory(story);
      const settings = await store.getSettings();
      return runJob(req, res, story, async (emit, signal) => {
        const before = story.chapters.length;
        try {
          await generateStory(story, settings, emit, signal);
        } finally {
          const words = store.storyWords(story);
          const written = story.chapters.length - before;
          if (written > 0) {
            const finished = story.chapters.length >= story.outline.length;
            story.messages.push({
              role: 'assistant',
              kind: 'generation',
              content: finished
                ? `Ho scritto «${story.title}»: ${story.chapters.length} ${story.chapters.length === 1 ? 'capitolo' : 'capitoli'}, circa ${words} parole. La trovi nella scheda Storia. Puoi chiedermi modifiche, scene aggiuntive o di continuarla.`
                : `Generazione interrotta dopo ${story.chapters.length} di ${story.outline.length} capitoli (${words} parole). Premi «Riprendi» per completarla.`,
              at: new Date().toISOString(),
            });
            await store.saveStory(story);
          }
        }
      });
    }

    if (action === 'continue' && method === 'POST') {
      const body = await readBody(req);
      const direction = String(body.direction || '').trim();
      if (direction) story.messages.push({ role: 'user', content: `Continua la storia: ${direction}`, at: new Date().toISOString() });
      const settings = await store.getSettings();
      return runJob(req, res, story, async (emit, signal) => {
        await continueStory(story, settings, direction, emit, signal);
        const ch = story.chapters.at(-1);
        story.messages.push({
          role: 'assistant',
          kind: 'generation',
          content: `Ho aggiunto il capitolo ${story.chapters.length}, «${ch.title}» (${store.countWords(ch.content)} parole).`,
          at: new Date().toISOString(),
        });
        await store.saveStory(story);
      });
    }

    if (action === 'rewrite' && method === 'POST') {
      const body = await readBody(req);
      const index = Number(body.index);
      const instructions = String(body.instructions || '').trim();
      const settings = await store.getSettings();
      return runJob(req, res, story, async (emit, signal) => {
        await rewriteChapter(story, index, instructions, settings, emit, signal);
        story.messages.push({
          role: 'assistant',
          kind: 'generation',
          content: `Ho riscritto il capitolo ${index + 1}, «${story.chapters[index].title}»${instructions ? ` (${instructions})` : ''}.`,
          at: new Date().toISOString(),
        });
        await store.saveStory(story);
      });
    }

    if (action === 'chat' && method === 'POST') {
      const body = await readBody(req);
      const message = String(body.message || '').trim();
      if (!message) return sendJson(res, 400, { error: 'Messaggio vuoto' });
      story.messages.push({ role: 'user', content: message, at: new Date().toISOString() });
      await store.saveStory(story);
      const settings = await store.getSettings();
      return runJob(req, res, story, async (emit, signal) => {
        const history = story.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.content }));
        const messages = [{ role: 'system', content: chatSystemPrompt(story) }, ...history];
        let text = '';
        const collect = (ev) => {
          if (ev.type === 'delta') text += ev.text;
          emit(ev);
        };
        try {
          await streamInto(settings, messages, {}, collect, signal);
        } finally {
          // salva anche le risposte parziali (es. se l'utente interrompe)
          if (text.trim()) {
            const s = await store.getStory(id);
            s.messages.push({ role: 'assistant', content: text.trim(), at: new Date().toISOString() });
            await store.saveStory(s);
          }
        }
      });
    }
  }

  return sendJson(res, 404, { error: 'Endpoint non trovato' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Metodo non permesso' });
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message || 'Errore interno' });
    else res.end();
    if (!err.status) console.error(err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Fanfic Studio è attivo su http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
});
