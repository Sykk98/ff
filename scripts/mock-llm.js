// Finto provider compatibile OpenAI, utile per provare l'app senza chiave API.
// Uso: npm run mock   ->   poi in Impostazioni: URL http://localhost:3999/v1, modello "mock"
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
    return JSON.stringify({
      title: 'La Notte dei Corvi',
      genre: 'dark fantasy',
      plot: user.slice(0, 300),
      characters: 'Lyra, mercenaria; Kael, principe prigioniero',
      targetWords: 0,
    });
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

http
  .createServer(async (req, res) => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock' }, { id: 'mock-2' }] }));
    }
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404);
      return res.end();
    }
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
  .listen(PORT, () => console.log(`Mock LLM su http://localhost:${PORT}/v1`));
