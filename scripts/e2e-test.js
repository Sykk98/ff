// Test end-to-end: avvia il mock LLM e il server, poi genera una storia completa.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fanfic-test-'));
const env = { ...process.env, DATA_DIR: dataDir, PORT: '3456', MOCK_PORT: '3998', OLLAMA_URL: 'http://localhost:3998', OLLAMA_MODEL: 'mock-nemo' };
for (const k of ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY']) delete env[k];
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
  assert.equal(settings.provider, 'ollama', 'Ollama deve essere il provider predefinito');
  assert.equal(settings.activeModel, 'mock-nemo');
  assert.equal(settings.configured, true);

  // stato di Ollama e download di un modello
  const status = await json('/api/ollama/status');
  assert.equal(status.running, true);
  assert.ok(status.models.some((m) => m.name === 'mock-nemo:latest'));
  assert.ok(status.recommended.length >= 3);
  const down = await json('/api/ollama/status?url=' + encodeURIComponent('http://localhost:1'));
  assert.equal(down.running, false);
  const pull = await stream('/api/ollama/pull', { name: 'mistral-nemo' });
  assert.ok(pull.some((e) => e.type === 'progress' && e.total > 0), 'manca l\'avanzamento del download');
  assert.ok(pull.at(-1).models.some((m) => m.name === 'mistral-nemo:latest'));
  const badName = await fetch(base + '/api/ollama/pull', { method: 'POST', body: JSON.stringify({ name: 'x; rm -rf' }) });
  assert.equal(badName.status, 400);

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
  const last = await (await fetch('http://localhost:3998/__last-ollama')).json();
  assert.equal(last.options.num_ctx, 12288, 'il contesto deve essere passato a Ollama');
  assert.equal(last.keep_alive, '30m');

  const cont = await stream(`/api/stories/${story.id}/continue`, { direction: 'arriva un drago' });
  assert.equal(cont.at(-1).story.chapters.length, 4);

  const rw = await stream(`/api/stories/${story.id}/rewrite`, { index: 0, instructions: 'più dark' });
  assert.ok(rw.at(-1).story.chapters[0].previous);

  // modalità romanzo: prima il progetto, poi un capitolo alla volta, con memoria di continuità
  const novelText = 'Voglio un romanzo fanfiction molto lungo. Punta a 25-35 capitoli molto corposi (5000 parole a capitolo). Per adesso NON iniziare il Capitolo 1: prima story bible e outline.';
  const novel = await json('/api/stories', { method: 'POST', body: { brief: { freeText: novelText, lengthLocked: false, flow: 'auto', explicitLevel: 'explicit' } } });
  const plan = await stream(`/api/stories/${novel.id}/generate`, { userMessage: novelText });
  assert.ok(plan.some((e) => e.type === 'bible'), 'manca la story bible');
  const planned = plan.find((e) => e.type === 'done')?.story;
  assert.ok(planned, 'progetto non completato: ' + JSON.stringify(plan.filter((e) => e.type === 'error')));
  assert.equal(planned.mode, 'plan');
  assert.equal(planned.planComplete, true);
  assert.equal(planned.brief.chapterCount, 30, '25-35 capitoli -> 30');
  assert.equal(planned.brief.wordsPerChapter, 5000);
  assert.equal(planned.outline.length, 30, 'scaletta di tutti i capitoli, a blocchi');
  assert.equal(planned.chapters.length, 0, 'il capitolo 1 non deve essere scritto durante il progetto');
  assert.match(planned.bible, /## Protagonisti/);
  assert.match(planned.messages.at(-1).content, /Scrivi il capitolo 1/);
  const ch1 = await stream(`/api/stories/${novel.id}/continue`, { direction: 'inizia con una giornata di pioggia' });
  const afterCh1 = ch1.find((e) => e.type === 'done')?.story;
  assert.ok(afterCh1, 'capitolo 1 non scritto: ' + JSON.stringify(ch1.filter((e) => e.type === 'error')));
  assert.equal(afterCh1.chapters.length, 1);
  assert.equal(ch1.filter((e) => e.type === 'status' && /Scrivo il capitolo 1 di 30… \d+%/.test(e.message)).length, 4, 'capitolo lungo scritto in 4 parti');
  assert.ok(!/scena\s+\d/i.test(afterCh1.chapters[0].content), 'nessuna etichetta "Scena N" nel capitolo');
  assert.ok(!/riassunto che non deve comparire/.test(afterCh1.chapters[0].content), 'nessun riassunto del piano nel capitolo');
  assert.ok(afterCh1.chapters[0].content.split(/\s+/).length > 1500, 'capitolo lungo');
  assert.match(afterCh1.memory[0], /Questioni aperte/, 'memoria di continuità del capitolo 1');
  const rev = await stream(`/api/stories/${novel.id}/revise`, { instructions: 'Lyra ha 29 anni' });
  const revised = rev.find((e) => e.type === 'done')?.story;
  assert.ok(revised, 'revisione fallita: ' + JSON.stringify(rev.filter((e) => e.type === 'error')));
  assert.match(revised.bible, /Versione rivista/);
  assert.ok(revised.previousBible, 'la bible precedente resta recuperabile');
  assert.equal(revised.chapters.length, 1, 'i capitoli scritti non cambiano');
  assert.equal(revised.outline.length, 30);
  assert.equal(revised.planComplete, true);

  // modello Ollama inesistente: errore comprensibile
  await json('/api/settings', { method: 'POST', body: { ollamaModel: 'non-esiste' } });
  const missing = await stream(`/api/stories/${story.id}/chat`, { message: 'ciao' });
  assert.match(missing.find((e) => e.type === 'error').message, /Scarica il modello/);

  // passaggio al provider compatibile OpenAI
  await json('/api/settings', { method: 'POST', body: { provider: 'openai', baseUrl: 'http://localhost:3998/v1', model: 'mock' } });
  const chat = await stream(`/api/stories/${story.id}/chat`, { message: 'Scrivi una scena extra' });
  assert.ok(chat.some((e) => e.type === 'delta'));
  const after = await json(`/api/stories/${story.id}`);
  assert.equal(after.messages.at(-1).role, 'assistant');

  const md = await (await fetch(`${base}/api/stories/${story.id}/export?format=md`)).text();
  assert.ok(md.startsWith('# La Notte dei Corvi'));

  const traversal = await fetch(base + '/..%2f..%2fpackage.json');
  assert.ok(!(await traversal.text()).includes('"scripts"'), 'path traversal');

  // ponte Cloudflare per Mistral (functions/api/mistral)
  const { onRequest } = await import('../functions/api/mistral/[[path]].js');
  const env2 = { MISTRAL_UPSTREAM: 'http://localhost:3998' };
  const call = (p, init = {}) =>
    onRequest({ request: new Request('https://app.pages.dev/api/mistral/' + p, init), params: { path: p.split('/') }, env: env2 });
  const auth = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' };
  assert.equal((await (await call('health')).json()).service, 'mistral-proxy');
  assert.equal((await call('v1/files', { headers: auth })).status, 404, 'percorsi diversi da chat e models vietati');
  assert.equal((await call('v1/chat/completions', { headers: auth })).status, 405, 'chat solo in POST');
  const chatBody = JSON.stringify({ model: 'mock', stream: true, messages: [{ role: 'user', content: 'Rispondi solo con: OK' }] });
  assert.equal((await call('v1/chat/completions', { method: 'POST', body: chatBody })).status, 401, 'chiave obbligatoria');
  const foreign = await call('v1/chat/completions', { method: 'POST', body: chatBody, headers: { ...auth, Origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403, 'altre origini vietate');
  const proxied = await call('v1/chat/completions', { method: 'POST', body: chatBody, headers: { ...auth, Origin: 'https://app.pages.dev' } });
  assert.equal(proxied.status, 200);
  const sse = await proxied.text();
  assert.ok(sse.includes('data:') && sse.includes('[DONE]'), 'lo streaming deve passare invariato');
  const models = await (await call('v1/models', { headers: auth })).json();
  assert.ok(models.data.some((m) => m.id === 'mock'));

  // modello non incluso nel piano Mistral: passa da solo a uno disponibile e lo ricorda
  const { streamWithModelFallback } = await import('../docs/core/openai.js');
  const fbSettings = { baseUrl: 'http://localhost:3998/x/api/mistral/v1', model: 'mistral-large-latest', apiKey: 'k' };
  let remembered = null;
  let fbText = '';
  for await (const part of streamWithModelFallback(fbSettings, [{ role: 'user', content: 'Rispondi solo con: OK' }], {}, (m) => (remembered = m))) {
    if (part.text) fbText += part.text;
  }
  assert.equal(fbText, 'OK');
  assert.equal(remembered, 'mistral-small-latest', 'large e medium non disponibili -> small');
  assert.equal(fbSettings.model, 'mistral-small-latest', 'le richieste successive usano subito il modello buono');

  // accesso automatico: chiave su Cloudflare protetta dalla password dell'app
  const callEnv = (envX, p, init = {}) =>
    onRequest({ request: new Request('https://app.pages.dev/api/mistral/' + p, init), params: { path: p.split('/') }, env: envX });
  const auto = { MISTRAL_UPSTREAM: 'http://localhost:3998', MISTRAL_API_KEY: 'server-key', APP_PASSWORD: 'segreta' };
  const health = await (await callEnv(auto, 'health')).json();
  assert.equal(health.serverKey, true);
  assert.equal(health.passwordSet, true);
  assert.ok(!JSON.stringify(health).includes('server-key'), 'la chiave non deve mai uscire dal ponte');
  const post = (envX, headers) => callEnv(envX, 'v1/chat/completions', { method: 'POST', body: chatBody, headers: { 'Content-Type': 'application/json', ...headers } });
  assert.equal((await post(auto, {})).status, 401, 'senza password');
  const wrong = await post(auto, { 'X-App-Password': 'sbagliata' });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, 'bad_password');
  const right = await post(auto, { 'X-App-Password': 'segreta' });
  assert.equal(right.status, 200);
  await right.text();
  const seenAuth = await (await fetch('http://localhost:3998/__last-openai-auth')).json();
  assert.equal(seenAuth.authorization, 'Bearer server-key', 'il ponte deve usare la chiave salvata su Cloudflare');
  const noPw = await post({ ...auto, APP_PASSWORD: '' }, {});
  assert.equal(noPw.status, 503, 'senza APP_PASSWORD su Cloudflare l\'accesso automatico resta spento');
  const ownKey = await post(auto, { Authorization: 'Bearer chiave-del-telefono' });
  assert.equal(ownKey.status, 200, 'una chiave inviata dal telefono continua a funzionare');
  await ownKey.text();

  // Worker di Cloudflare (worker/index.js): smista tra ponte, API inesistenti e file dell'app
  const worker = (await import('../worker/index.js')).default;
  const assets = { fetch: async (req) => new Response('asset:' + new URL(req.url).pathname) };
  const wenv = { ...auto, ASSETS: assets };
  const wfetch = (p, init) => worker.fetch(new Request('https://ff.example.workers.dev' + p, init), wenv);
  assert.equal((await (await wfetch('/api/mistral/health')).json()).service, 'mistral-proxy');
  assert.equal((await wfetch('/api/settings')).status, 404, 'nessun server Node: l\'app deve passare alla modalità telefono');
  assert.equal(await (await wfetch('/core/engine.js')).text(), 'asset:/core/engine.js');
  const wchat = await wfetch('/api/mistral/v1/chat/completions', { method: 'POST', body: chatBody, headers: { 'Content-Type': 'application/json', 'X-App-Password': 'segreta' } });
  assert.equal(wchat.status, 200);
  assert.ok((await wchat.text()).includes('[DONE]'));

  console.log('\n✅ Tutti i test superati');
} catch (err) {
  console.error('\n❌ Test fallito:', err);
  process.exitCode = 1;
} finally {
  procs.forEach((p) => p.kill());
  await fs.rm(dataDir, { recursive: true, force: true });
}
