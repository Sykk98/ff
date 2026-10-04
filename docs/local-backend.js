// Versione per telefono: lo stesso "server" dell'app, ma eseguito interamente nel browser.
// Le storie stanno in IndexedDB, le impostazioni in localStorage, e l'AI viene chiamata
// direttamente da qui (serve un servizio che accetti richieste dal browser, come OpenRouter).
import { createEngine } from './core/engine.js';
import { streamOpenAI, listOpenAIModels } from './core/openai.js';
import { storyWords } from './core/text.js';

const SETTINGS_KEY = 'fanfic-studio-settings';

export const PHONE_PRESETS = [
  {
    id: 'mistral',
    label: 'Mistral Large',
    badge: 'consigliato · piano gratuito · ottimo italiano',
    baseUrl: '/api/mistral/v1', // ponte sullo stesso indirizzo dell'app (worker/ o functions/api/mistral)
    model: 'mistral-large-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
    needsProxy: true,
  },
  {
    id: 'mistral-small',
    label: 'Mistral Small',
    badge: 'piano gratuito · più veloce, meno raffinato',
    baseUrl: '/api/mistral/v1',
    model: 'mistral-small-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
    needsProxy: true,
  },
  {
    id: 'venice',
    label: 'OpenRouter · Venice Uncensored',
    badge: 'gratis · senza filtri · 50 richieste al giorno',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'venice/uncensored:free',
    keyUrl: 'https://openrouter.ai/settings/keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter · altro modello',
    badge: 'scegli dall\'elenco, anche a pagamento',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    keyUrl: 'https://openrouter.ai/settings/keys',
  },
];

const DEFAULTS = {
  provider: 'openai',
  baseUrl: PHONE_PRESETS[0].baseUrl,
  model: PHONE_PRESETS[0].model,
  apiKey: '',
  appPassword: '', // password dell'app per l'accesso automatico a Mistral tramite il ponte
  temperature: 0.9,
  topP: 0,
  maxTokens: 6000,
  wordsPerChapter: 2000,
};
const NUMERIC = ['temperature', 'topP', 'maxTokens', 'wordsPerChapter'];

// ---------- archiviazione ----------

function readSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'), provider: 'openai' };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    throw new Error('Il browser non permette di salvare le impostazioni (navigazione privata?).');
  }
}

const isProxyUrl = (u) => /^\/api\/mistral\//.test(u || '');

function publicSettings(s, proxy) {
  const { apiKey, appPassword, ...rest } = s;
  // accesso automatico: chiave su Cloudflare + password dell'app salvata sul telefono
  const autoLogin = Boolean(isProxyUrl(s.baseUrl) && proxy?.serverKey && appPassword);
  return {
    ...rest,
    apiKeySet: Boolean(apiKey),
    apiKeyHint: apiKey ? `…${apiKey.slice(-4)}` : '',
    appPasswordSet: Boolean(appPassword),
    serverKey: Boolean(proxy?.serverKey),
    serverPasswordSet: Boolean(proxy?.passwordSet),
    autoLogin,
    // i servizi online richiedono una chiave; un server sulla rete di casa può non averla
    configured: Boolean(
      s.model && s.baseUrl && (apiKey || autoLogin || /^http:\/\/(localhost|127\.|192\.168\.|10\.)/.test(s.baseUrl)),
    ),
    preset: PHONE_PRESETS.find((p) => p.baseUrl === s.baseUrl && p.model === s.model)?.id || '',
    activeModel: s.model,
    local: true,
  };
}

/** Archivio storie su IndexedDB, con ripiego in memoria se il browser lo blocca. */
function createStoryDb() {
  const memory = new Map();
  let dbPromise = null;
  let persistent = true;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open('fanfic-studio', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('stories', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          persistent = false;
          resolve(null);
        };
      } catch {
        persistent = false;
        resolve(null);
      }
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await open();
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
      const t = db.transaction('stories', mode);
      const store = t.objectStore('stories');
      let result;
      Promise.resolve(fn(store)).then((r) => (result = r));
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error || new Error('Errore del database del browser'));
      t.onabort = () => reject(t.error || new Error('Spazio esaurito o database bloccato'));
    });
  }

  const req2promise = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  return {
    get persistent() {
      return persistent;
    },
    async all() {
      const db = await open();
      if (!db) return [...memory.values()];
      return req2promise(db.transaction('stories').objectStore('stories').getAll());
    },
    async get(id) {
      const db = await open();
      const s = db ? await req2promise(db.transaction('stories').objectStore('stories').get(id)) : memory.get(id);
      if (!s) throw Object.assign(new Error('Storia non trovata'), { status: 404 });
      return s;
    },
    async put(story) {
      const copy = JSON.parse(JSON.stringify(story));
      await tx('readwrite', (store) => (store ? store.put(copy) : memory.set(copy.id, copy)));
      return story;
    },
    async delete(id) {
      await tx('readwrite', (store) => (store ? store.delete(id) : memory.delete(id)));
    },
  };
}

const uuid = () =>
  globalThis.crypto?.randomUUID?.() ||
  'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));

const abortError = () => {
  try {
    return new DOMException('Interrotto', 'AbortError');
  } catch {
    return Object.assign(new Error('Interrotto'), { name: 'AbortError' });
  }
};

// ---------- backend ----------

let proxyCheck = null;
/** Stato del ponte per Mistral su questo indirizzo (versione su Cloudflare), o null se manca. */
function proxyInfo() {
  proxyCheck ??= fetch('/api/mistral/health', { cache: 'no-store' })
    .then(async (r) => {
      const j = r.ok ? await r.json().catch(() => null) : null;
      return j?.service === 'mistral-proxy' ? j : null;
    })
    .catch(() => null);
  return proxyCheck;
}

/** Accesso da link: #accesso=PASSWORD salva la password, sceglie Mistral e pulisce l'indirizzo. */
function consumeAccessLink() {
  const m = /[#&]accesso=([^&]+)/.exec(location.hash || '');
  if (!m) return;
  const s = readSettings();
  s.appPassword = decodeURIComponent(m[1]);
  if (!isProxyUrl(s.baseUrl)) {
    s.baseUrl = PHONE_PRESETS[0].baseUrl;
    s.model = PHONE_PRESETS[0].model;
  }
  try {
    writeSettings(s);
  } catch {}
  history.replaceState(null, '', location.pathname + location.search);
}

export function createLocalBackend() {
  consumeAccessLink();
  const db = createStoryDb();
  const running = new Map(); // storyId -> AbortController

  async function saveStory(story) {
    story.updatedAt = new Date().toISOString();
    return db.put(story);
  }

  const engine = createEngine({ streamChat: (s, m, o) => streamOpenAI(s, m, o), saveStory });

  // Chiede al browser di non cancellare i dati quando lo spazio scarseggia.
  try {
    navigator.storage?.persist?.();
  } catch {}

  async function api(path, opts = {}) {
    const method = opts.method || 'GET';
    const body = opts.body || {};
    const url = new URL(path, 'http://local');
    const parts = url.pathname.split('/').filter(Boolean).slice(1);

    if (parts[0] === 'settings') {
      if (parts.length === 1 && method === 'GET') return publicSettings(readSettings(), await proxyInfo());
      if (parts.length === 1 && method === 'POST') {
        const s = readSettings();
        for (const key of Object.keys(DEFAULTS)) {
          if (!(key in body) || key === 'provider') continue;
          if ((key === 'apiKey' || key === 'appPassword') && (body[key] === undefined || body[key] === null)) continue;
          let v = body[key];
          if (NUMERIC.includes(key)) {
            v = Number(v);
            if (!Number.isFinite(v)) continue;
          } else v = String(v ?? '').trim();
          s[key] = v;
        }
        if (body.clearApiKey) s.apiKey = '';
        writeSettings(s);
        return publicSettings(s, await proxyInfo());
      }
      if (parts[1] === 'test' && method === 'POST') {
        const started = Date.now();
        const { text } = await engine.complete(readSettings(), [{ role: 'user', content: 'Rispondi solo con: OK' }], {
          maxTokens: 20,
          temperature: 0,
        });
        return { ok: true, reply: text.trim().slice(0, 200), ms: Date.now() - started };
      }
    }

    if (parts[0] === 'models' && method === 'GET') return { models: await listOpenAIModels(readSettings()) };

    if (parts[0] === 'backup') {
      if (method === 'GET') return { app: 'fanfic-studio', exportedAt: new Date().toISOString(), stories: await db.all() };
      if (method === 'POST') {
        const list = Array.isArray(body.stories) ? body.stories : [];
        let imported = 0;
        for (const s of list) {
          if (!s || typeof s.id !== 'string' || !Array.isArray(s.chapters)) continue;
          await db.put({ outline: [], messages: [], brief: {}, ...s });
          imported++;
        }
        return { imported };
      }
    }

    if (parts[0] === 'stories') {
      if (parts.length === 1 && method === 'GET') {
        const all = await db.all();
        return all
          .map((s) => ({
            id: s.id,
            title: s.title || 'Senza titolo',
            updatedAt: s.updatedAt,
            chapters: (s.chapters || []).length,
            words: storyWords(s),
          }))
          .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      }
      if (parts.length === 1 && method === 'POST') {
        const now = new Date().toISOString();
        const story = { id: uuid(), title: body.title || 'Nuova storia', brief: body.brief || {}, outline: [], chapters: [], messages: [], createdAt: now, updatedAt: now };
        return saveStory(story);
      }
      const id = parts[1];
      const action = parts[2];
      if (!action && method === 'GET') return { ...(await db.get(id)), running: running.has(id) };
      if (!action && method === 'PUT') {
        const story = await db.get(id);
        if (typeof body.title === 'string') story.title = body.title.trim() || story.title;
        if (body.brief && typeof body.brief === 'object') story.brief = { ...story.brief, ...body.brief };
        if (Array.isArray(body.chapters)) story.chapters = body.chapters.map((c) => ({ title: String(c.title || ''), content: String(c.content || '') }));
        if (Array.isArray(body.outline)) story.outline = body.outline.map((c) => ({ title: String(c.title || ''), summary: String(c.summary || '') }));
        if (Array.isArray(body.messages)) story.messages = body.messages;
        return saveStory(story);
      }
      if (!action && method === 'DELETE') {
        running.get(id)?.abort();
        await db.delete(id);
        return { ok: true };
      }
      if (action === 'stop' && method === 'POST') {
        running.get(id)?.abort();
        return { ok: true };
      }
    }
    throw Object.assign(new Error('Operazione non disponibile nella versione per telefono'), { status: 404 });
  }

  /** Equivalente delle risposte in streaming del server: chiama onEvent per ogni evento. */
  async function streamApi(path, body, onEvent, signal) {
    const parts = new URL(path, 'http://local').pathname.split('/').filter(Boolean).slice(1);
    const [section, id, action] = parts;
    if (section !== 'stories' || !Object.hasOwn(engine.actions, action)) {
      throw new Error('Operazione non disponibile nella versione per telefono');
    }
    if (running.has(id)) throw new Error('Una generazione è già in corso per questa storia.');
    const story = await db.get(id);
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort);
    running.set(id, ac);
    try {
      await engine.actions[action](story, body || {}, readSettings(), onEvent, ac.signal);
      onEvent({ type: 'done', story: await db.get(id) });
    } catch (err) {
      if (ac.signal.aborted || err.name === 'AbortError') {
        onEvent({ type: 'aborted' });
        throw abortError();
      }
      onEvent({ type: 'error', message: err.message || String(err) });
    } finally {
      running.delete(id);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Link che configura l'accesso automatico su un altro browser o telefono. */
  function accessLink() {
    const pw = readSettings().appPassword;
    if (!pw) return '';
    return `${location.origin}${location.pathname}#accesso=${encodeURIComponent(pw)}`;
  }

  return {
    api,
    streamApi,
    presets: PHONE_PRESETS,
    mistralProxyAvailable: async () => Boolean(await proxyInfo()),
    proxyInfo,
    accessLink,
    get persistent() {
      return db.persistent;
    },
  };
}
