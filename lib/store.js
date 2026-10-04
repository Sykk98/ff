// Archiviazione su file JSON locali (cartella data/).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const STORIES_DIR = path.join(DATA_DIR, 'stories');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const ID_RE = /^[a-f0-9-]{8,64}$/;

export const DEFAULT_SETTINGS = {
  provider: 'ollama', // "ollama" (locale) oppure "openai" (qualsiasi API compatibile OpenAI)
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: '',
  numCtx: 12288, // contesto per Ollama: deve contenere scaletta, fine del capitolo precedente e nuovo testo
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  model: '',
  temperature: 0.9,
  topP: 0,
  maxTokens: 6000,
  wordsPerChapter: 2000,
};

const NUMERIC = ['temperature', 'topP', 'maxTokens', 'wordsPerChapter', 'numCtx'];

/** Il modello attivo per il provider scelto (stringa vuota se non configurato). */
export function activeModel(s) {
  return s.provider === 'ollama' ? s.ollamaModel : s.model;
}

async function ensureDirs() {
  await fs.mkdir(STORIES_DIR, { recursive: true });
}

async function writeAtomic(file, data) {
  await ensureDirs();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

export function countWords(text) {
  return (text || '').split(/\s+/).filter(Boolean).length;
}

export function storyWords(story) {
  return (story.chapters || []).reduce((n, c) => n + countWords(c.content), 0);
}

// ---------- Impostazioni ----------

export async function getSettings() {
  let saved = {};
  try {
    saved = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
  } catch {}
  const env = {};
  if (process.env.LLM_PROVIDER) env.provider = process.env.LLM_PROVIDER;
  if (process.env.OLLAMA_URL) env.ollamaUrl = process.env.OLLAMA_URL;
  if (process.env.OLLAMA_MODEL) env.ollamaModel = process.env.OLLAMA_MODEL;
  if (process.env.LLM_BASE_URL) {
    env.baseUrl = process.env.LLM_BASE_URL;
    if (!process.env.LLM_PROVIDER) env.provider = 'openai';
  }
  if (process.env.LLM_API_KEY) env.apiKey = process.env.LLM_API_KEY;
  if (process.env.LLM_MODEL) env.model = process.env.LLM_MODEL;
  // Impostazioni salvate con la prima versione dell'app (senza "provider"): erano tutte OpenAI-compatibili.
  if (saved.baseUrl && !saved.provider) saved.provider = 'openai';
  // I valori salvati dall'interfaccia hanno la precedenza sulle variabili d'ambiente,
  // tranne quando sono vuoti.
  const merged = { ...DEFAULT_SETTINGS, ...env };
  for (const [k, v] of Object.entries(saved)) {
    if (v !== '' && v !== null && v !== undefined) merged[k] = v;
  }
  return merged;
}

export async function saveSettings(patch) {
  let saved = {};
  try {
    saved = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
  } catch {}
  const allowed = Object.keys(DEFAULT_SETTINGS);
  for (const key of allowed) {
    if (!(key in patch)) continue;
    let v = patch[key];
    if (NUMERIC.includes(key)) {
      v = v === '' || v === null ? '' : Number(v);
      if (v !== '' && !Number.isFinite(v)) continue;
    } else {
      v = String(v ?? '').trim();
      if (key === 'provider' && !['ollama', 'openai'].includes(v)) continue;
    }
    saved[key] = v;
  }
  await writeAtomic(SETTINGS_FILE, JSON.stringify(saved, null, 2));
  return getSettings();
}

export function publicSettings(s) {
  const { apiKey, ...rest } = s;
  return {
    ...rest,
    apiKeySet: Boolean(apiKey),
    apiKeyHint: apiKey ? `…${apiKey.slice(-4)}` : '',
    configured: Boolean(activeModel(s)),
    activeModel: activeModel(s),
  };
}

// ---------- Storie ----------

function storyFile(id) {
  if (!ID_RE.test(id)) throw Object.assign(new Error('ID storia non valido'), { status: 400 });
  return path.join(STORIES_DIR, `${id}.json`);
}

export async function listStories() {
  await ensureDirs();
  const files = (await fs.readdir(STORIES_DIR)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(await fs.readFile(path.join(STORIES_DIR, f), 'utf8'));
      out.push({
        id: s.id,
        title: s.title || 'Senza titolo',
        updatedAt: s.updatedAt,
        chapters: (s.chapters || []).length,
        words: storyWords(s),
      });
    } catch {}
  }
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return out;
}

export async function getStory(id) {
  try {
    return JSON.parse(await fs.readFile(storyFile(id), 'utf8'));
  } catch (err) {
    if (err.status) throw err;
    throw Object.assign(new Error('Storia non trovata'), { status: 404 });
  }
}

export async function saveStory(story) {
  story.updatedAt = new Date().toISOString();
  await writeAtomic(storyFile(story.id), JSON.stringify(story, null, 2));
  return story;
}

export async function createStory(data = {}) {
  const now = new Date().toISOString();
  const story = {
    id: crypto.randomUUID(),
    title: data.title || 'Nuova storia',
    brief: data.brief || {},
    outline: [],
    chapters: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  return saveStory(story);
}

export async function deleteStory(id) {
  await fs.rm(storyFile(id), { force: true });
}
