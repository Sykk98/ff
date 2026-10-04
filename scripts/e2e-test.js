// Test end-to-end: avvia il mock LLM e il server, poi genera una storia completa.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fanfic-test-'));
const env = { ...process.env, DATA_DIR: dataDir, PORT: '3456', MOCK_PORT: '3998', LLM_BASE_URL: 'http://localhost:3998/v1', LLM_MODEL: 'mock', LLM_API_KEY: '' };
const procs = [spawn('node', ['scripts/mock-llm.js'], { env, stdio: 'inherit' }), spawn('node', ['server.js'], { env, stdio: 'inherit' })];
const base = 'http://127.0.0.1:3456';

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(base + '/api/settings');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server non avviato');
}

async function json(p, opts = {}) {
  const r = await fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  return r.json();
}

async function stream(p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  return text.trim().split('\n').map((l) => JSON.parse(l));
}

try {
  await waitUp();
  const settings = await json('/api/settings');
  assert.equal(settings.model, 'mock');

  const test = await json('/api/settings/test', { method: 'POST' });
  assert.equal(test.reply, 'OK');

  const story = await json('/api/stories', {
    method: 'POST',
    body: { brief: { freeText: 'Una mercenaria e un principe prigioniero, dark fantasy', lengthPreset: 'medio', lengthLocked: true, explicitLevel: 'explicit', darkThemes: true } },
  });
  const events = await stream(`/api/stories/${story.id}/generate`, { userMessage: 'Una mercenaria e un principe' });
  const types = events.map((e) => e.type);
  assert.ok(types.includes('outline'), 'manca la scaletta');
  assert.ok(types.includes('done'), 'generazione non completata: ' + JSON.stringify(events.filter((e) => e.type === 'error')));
  const done = events.find((e) => e.type === 'done').story;
  assert.equal(done.title, 'La Notte dei Corvi');
  assert.equal(done.outline.length, 3, 'medio (5000) / 2000 parole per capitolo = 3 capitoli');
  assert.equal(done.chapters.length, 3);
  assert.ok(!done.chapters[0].content.includes('<think>'), 'i blocchi <think> devono essere filtrati');
  assert.ok(done.chapters.every((c) => c.content.length > 100));

  const cont = await stream(`/api/stories/${story.id}/continue`, { direction: 'arriva un drago' });
  assert.equal(cont.at(-1).story.chapters.length, 4);

  const rw = await stream(`/api/stories/${story.id}/rewrite`, { index: 0, instructions: 'più dark' });
  assert.ok(rw.at(-1).story.chapters[0].previous);

  const chat = await stream(`/api/stories/${story.id}/chat`, { message: 'Scrivi una scena extra' });
  assert.ok(chat.some((e) => e.type === 'delta'));
  const after = await json(`/api/stories/${story.id}`);
  assert.equal(after.messages.at(-1).role, 'assistant');

  const md = await (await fetch(`${base}/api/stories/${story.id}/export?format=md`)).text();
  assert.ok(md.startsWith('# La Notte dei Corvi'));

  const traversal = await fetch(base + '/..%2f..%2fpackage.json');
  assert.ok(!(await traversal.text()).includes('"scripts"'), 'path traversal');

  console.log('\n✅ Tutti i test superati');
} catch (err) {
  console.error('\n❌ Test fallito:', err);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill());
  await fs.rm(dataDir, { recursive: true, force: true });
}
