// Finto provider AI per provare l'app senza modelli veri.
// Imita sia l'API compatibile OpenAI (/v1/...) sia l'API nativa di Ollama (/api/...).
// Uso: npm run mock, poi nelle Impostazioni:
//   - Ollama: indirizzo http://localhost:3999 (in Avanzate), modello "mock-nemo"
//   - Servizio online: URL http://localhost:3999/v1, modello "mock"
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT) || 3999;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOREM =
  'La pioggia batteva sui vetri mentre lei attraversava il corridoio, il cuore che martellava contro le costole. ' +
  'Ogni passo era una promessa infranta, ogni ombra un ricordo che non voleva tornare. ' +
  '«Sei in ritardo» disse lui senza voltarsi, la voce bassa come un tuono lontano. ' +
  'Lei non rispose. Sapeva che qualsiasi parola sarebbe stata usata contro di lei.';

function reply(messages) {
  const sys = messages.find((m) => m.role === 'system')?.content || '';
  const user = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  if (sys.includes('assistente editoriale')) {
    const request = user.split('"""')[1] || user; // solo il testo dell'autore, non le istruzioni
    const range = request.match(/(\d+)\s*-\s*(\d+)\s*capitoli/);
    const wpc = request.match(/(\d+)\s*parole a capitolo/);
    return JSON.stringify({
      title: 'La Notte dei Corvi',
      genre: 'dark fantasy',
      plot: (user.split('"""')[1] || user).slice(0, 300),
      characters: 'Lyra, mercenaria; Kael, principe prigioniero',
      targetWords: 0,
      chapterCount: range ? Math.round((Number(range[1]) + Number(range[2])) / 2) : 0,
      wordsPerChapter: wpc ? Number(wpc[1]) : 0,
      planFirst: /NON iniziare|outline|story bible/i.test(request),
    });
  }
  if (sys.includes('editor di continuità')) {
    return '**Cosa succede:** Lyra incontra Kael.\n**Nuovi fatti di canon:**\n- Lyra ha 29 anni\n**Chi sa cosa:** nessuno sa del patto.\n**Stato emotivo e delle relazioni:** diffidenza.\n**Questioni aperte:** il patto segreto.';
  }
  if (sys.includes('aggiorni il progetto')) {
    return '# Story bible: La Notte dei Corvi\n\n## Premessa\nVersione rivista del progetto.\n\n## Protagonisti\n- Lyra, 29 anni\n- Kael, 31 anni';
  }
  if (sys.includes('progetti un romanzo')) {
    return '# Story bible: La Notte dei Corvi\n\n## Premessa\nUna mercenaria e un principe.\n\n## Protagonisti\n- Lyra, 28 anni, capelli neri\n- Kael, 30 anni\n\n## Finale\nAgrodolce.';
  }
  if (sys.includes('pianifichi le scene')) {
    const n = Number(user.match(/in (\d+) scene/)?.[1]) || 3;
    return JSON.stringify({ scenes: Array.from({ length: n }, (_, i) => ({ summary: `Scena ${i + 1} del capitolo.` })) });
  }
  const batch = user.match(/capitoli da (\d+) a (\d+)/);
  if (sys.includes('pianifichi') && batch) {
    const [from, to] = [Number(batch[1]), Number(batch[2])];
    return JSON.stringify({ chapters: Array.from({ length: to - from + 1 }, (_, i) => ({ title: `Capitolo ${from + i}: Ombre ${from + i}`, summary: `Eventi del capitolo ${from + i}.` })) });
  }
  if (sys.includes('pianifichi')) {
    const m = user.match(/esattamente (\d+)/);
    if (m) {
      const n = Number(m[1]);
      return '```json\n' + JSON.stringify({
        title: 'La Notte dei Corvi',
        chapters: Array.from({ length: n }, (_, i) => ({ title: `Capitolo ${i + 1}: Ombre ${i + 1}`, summary: `Eventi del capitolo ${i + 1}.` })),
      }) + '\n```';
    }
    return JSON.stringify({ title: 'Un nuovo inizio', summary: 'La storia prosegue.' });
  }
  if (user.includes('Rispondi solo con: OK')) return 'OK';
  const words = Number(user.match(/circa (\d+) parole/)?.[1]) || 120;
  let out = '<think>ragionamento nascosto</think>';
  while (out.split(/\s+/).length < Math.min(words, 600)) out += LOREM + '\n\n';
  return out;
}

const installed = new Set(['mock-nemo:latest']);
let lastOllamaRequest = null;
let lastOpenAIAuth = null;

async function readJson(req) {
  let body = '';
  for await (const c of req) body += c;
  return body ? JSON.parse(body) : {};
}

async function handleOllama(req, res) {
  const nd = (obj) => res.write(JSON.stringify(obj) + '\n');
  if (req.url === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ version: '0.0.0-mock' }));
  }
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      models: [...installed].map((name) => ({ name, model: name, size: 7.1e9, details: { parameter_size: '12B', quantization_level: 'Q4_0' } })),
    }));
  }
  if (req.url === '/api/pull') {
    const { model } = await readJson(req);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    nd({ status: 'pulling manifest' });
    const total = 5e8;
    for (let done = 0; done <= total; done += 1e8) {
      nd({ status: 'pulling abc123', digest: 'sha256:abc123', total, completed: done });
      await sleep(30);
    }
    nd({ status: 'verifying sha256 digest' });
    nd({ status: 'writing manifest' });
    installed.add(model.includes(':') ? model : `${model}:latest`);
    nd({ status: 'success' });
    return res.end();
  }
  if (req.url === '/api/chat') {
    const body = await readJson(req);
    lastOllamaRequest = body;
    const known = [...installed].some((n) => n === body.model || n === `${body.model}:latest`);
    if (!known) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `model '${body.model}' not found` }));
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const text = reply(body.messages);
    for (const t of text.match(/[\s\S]{1,12}/g) || []) {
      nd({ model: body.model, message: { role: 'assistant', content: t }, done: false });
      await sleep(2);
    }
    nd({ model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' });
    return res.end();
  }
  res.writeHead(404);
  res.end();
}

http
  .createServer(async (req, res) => {
    if (req.url === '/__last-openai-auth') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ authorization: lastOpenAIAuth }));
    }
    if (req.url === '/__last-ollama') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(lastOllamaRequest));
    }
    if (req.url.startsWith('/api/')) return handleOllama(req, res);
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock' }, { id: 'mock-2' }] }));
    }
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404);
      return res.end();
    }
    lastOpenAIAuth = req.headers.authorization || null;
    let body = '';
    for await (const c of req) body += c;
    const { messages } = JSON.parse(body);
    const text = reply(messages);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const tokens = text.match(/[\s\S]{1,12}/g) || [];
    for (const t of tokens) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      await sleep(2);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  })
  .listen(PORT, () => console.log(`Mock LLM su http://localhost:${PORT} (Ollama) e http://localhost:${PORT}/v1 (OpenAI)`));
