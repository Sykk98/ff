// Client per l'API nativa di Ollama (/api/chat, /api/tags, /api/pull).
// Usa node:http invece di fetch: niente timeout di default, utile perché i modelli
// locali possono impiegare minuti a caricarsi o a elaborare prompt lunghi su CPU.
import http from 'node:http';
import https from 'node:https';

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** Modelli consigliati per narrativa con contenuti per adulti (scaricabili dall'app). */
export const RECOMMENDED_MODELS = [
  {
    name: 'CognitiveComputations/dolphin-mistral-nemo:12b',
    label: 'Dolphin Mistral Nemo 12B',
    size: '~7 GB',
    vram: '12 GB',
    note: 'Consigliato. Versione non censurata di Mistral Nemo, buon italiano.',
  },
  {
    name: 'mistral-nemo',
    label: 'Mistral Nemo 12B',
    size: '~7 GB',
    vram: '12 GB',
    note: 'Modello ufficiale, ottimo italiano, pochi filtri.',
  },
  {
    name: 'dolphin3',
    label: 'Dolphin 3.0 (Llama 3.1 8B)',
    size: '~5 GB',
    vram: '8 GB',
    note: 'Non censurato e leggero. Italiano meno curato.',
  },
  {
    name: 'mistral-small',
    label: 'Mistral Small 24B',
    size: '~14 GB',
    vram: '16–24 GB',
    note: 'La qualità migliore se hai una scheda video potente.',
  },
];

export function ollamaBase(url) {
  return String(url || DEFAULT_OLLAMA_URL)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '')
    .replace(/\/api$/, '');
}

function friendlyError(err, base) {
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET'].includes(err.code)) {
    return new Error(
      `Ollama non risponde su ${base}. Controlla che sia installato (ollama.com/download) e avviato.`,
    );
  }
  return err;
}

/**
 * Richiesta HTTP verso Ollama. Restituisce la risposta Node (stream leggibile).
 * Rifiuta con un errore leggibile se lo status non è 2xx.
 */
function request(base, path, { method = 'GET', body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = lib.request(
      url,
      {
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        signal,
      },
      (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res);
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let msg = text;
          try {
            msg = JSON.parse(text).error || text;
          } catch {}
          if (res.statusCode === 404 && /model/i.test(msg)) {
            msg = `${msg}. Scarica il modello dalle Impostazioni o con "ollama pull".`;
          }
          reject(new Error(`Errore da Ollama (${res.statusCode}): ${String(msg).slice(0, 400)}`));
        });
      },
    );
    req.on('error', (err) => reject(err.name === 'AbortError' ? err : friendlyError(err, base)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function* ndjson(res) {
  let buf = '';
  res.setEncoding('utf8');
  for await (const chunk of res) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.error) throw new Error(`Errore da Ollama: ${obj.error}`);
      yield obj;
    }
  }
  if (buf.trim()) {
    const obj = JSON.parse(buf);
    if (obj.error) throw new Error(`Errore da Ollama: ${obj.error}`);
    yield obj;
  }
}

/** Stream di chat con /api/chat. Stesso formato di llm.streamChat: { text } e infine { finishReason }. */
export async function* streamOllamaChat(settings, messages, { maxTokens, temperature, signal } = {}) {
  if (!settings.model) throw new Error('Nessun modello Ollama selezionato. Apri Impostazioni.');
  const base = ollamaBase(settings.baseUrl);
  const options = {
    temperature: Number(temperature ?? settings.temperature ?? 0.9),
    num_ctx: Number(settings.numCtx) > 0 ? Math.round(Number(settings.numCtx)) : 12288,
    num_predict: Number(maxTokens ?? settings.maxTokens) > 0 ? Math.round(Number(maxTokens ?? settings.maxTokens)) : -1,
    repeat_penalty: 1.08,
  };
  if (Number(settings.topP) > 0 && Number(settings.topP) < 1) options.top_p = Number(settings.topP);

  const res = await request(base, '/api/chat', {
    method: 'POST',
    body: { model: settings.model, messages, stream: true, options, keep_alive: '30m' },
    signal,
  });

  let finishReason = null;
  for await (const obj of ndjson(res)) {
    const text = obj.message?.content || '';
    if (text) yield { text };
    if (obj.done) {
      finishReason = obj.done_reason === 'length' ? 'length' : 'stop';
      break;
    }
  }
  yield { finishReason };
}

/** Stato del server Ollama e modelli installati. */
export async function ollamaStatus(url) {
  const base = ollamaBase(url);
  try {
    const vRes = await request(base, '/api/version');
    let version = '';
    for await (const obj of ndjson(vRes)) version = obj.version || version;
    const models = await listOllamaModels(base);
    return { running: true, version, models, url: base };
  } catch (err) {
    return { running: false, error: err.message, models: [], url: base };
  }
}

export async function listOllamaModels(url) {
  const res = await request(ollamaBase(url), '/api/tags');
  let data = { models: [] };
  for await (const obj of ndjson(res)) data = obj;
  return (data.models || [])
    .map((m) => ({
      name: m.name || m.model,
      sizeGb: m.size ? Math.round((m.size / 1e9) * 10) / 10 : null,
      params: m.details?.parameter_size || '',
      quant: m.details?.quantization_level || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Scarica un modello. onProgress riceve { status, total, completed }. */
export async function pullOllamaModel(url, name, onProgress, signal) {
  const res = await request(ollamaBase(url), '/api/pull', { method: 'POST', body: { model: name, stream: true }, signal });
  let last = null;
  for await (const obj of ndjson(res)) {
    last = obj;
    onProgress(obj);
  }
  if (last?.status !== 'success') throw new Error('Download non completato');
}
