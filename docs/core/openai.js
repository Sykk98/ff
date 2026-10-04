// Client in streaming per API compatibili OpenAI /chat/completions.
// Usa solo fetch e ReadableStream, quindi funziona sia in Node (>= 18) sia nel browser del telefono.

function buildHeaders(settings) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  if (/openrouter\.ai/.test(settings.baseUrl || '')) {
    const origin = typeof location !== 'undefined' && location.origin?.startsWith('http') ? location.origin : 'http://localhost';
    headers['HTTP-Referer'] = origin;
    headers['X-Title'] = 'Fanfic Studio';
  }
  return headers;
}

function networkError(url, err) {
  const inBrowser = typeof window !== 'undefined';
  if (inBrowser) {
    return new Error(
      `Impossibile contattare ${new URL(url).host}. Controlla la connessione. ` +
        'Se il problema continua, questo servizio potrebbe non accettare richieste dirette dal browser: usa OpenRouter, che le accetta.',
    );
  }
  return new Error(`Impossibile contattare ${url}: ${err.message}`);
}

/** Itera le righe di un body in streaming (compatibile anche con Safari, che non itera i ReadableStream). */
async function* lines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        yield buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * Stream di testo dal modello: async iterator di { text } e, alla fine, { finishReason }.
 */
export async function* streamOpenAI(settings, messages, { maxTokens, temperature, signal } = {}) {
  if (!settings.baseUrl) throw new Error('Indirizzo del servizio non configurato. Apri Impostazioni.');
  if (!settings.model) throw new Error('Modello non configurato. Apri Impostazioni.');

  const body = {
    model: settings.model,
    messages,
    stream: true,
    temperature: Number(temperature ?? settings.temperature ?? 0.9),
  };
  const limit = maxTokens ?? settings.maxTokens;
  if (limit && Number(limit) > 0) body.max_tokens = Math.round(Number(limit));
  if (Number(settings.topP) > 0 && Number(settings.topP) < 1) body.top_p = Number(settings.topP);

  const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: buildHeaders(settings), body: JSON.stringify(body), signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw networkError(url, err);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || j.message || j.detail || text;
    } catch {}
    if (res.status === 401) detail = `chiave API non valida o mancante. ${detail}`;
    if (res.status === 429) detail = `limite di richieste raggiunto, riprova più tardi. ${detail}`;
    throw new Error(`Errore dal servizio (${res.status}): ${String(detail).slice(0, 500)}`);
  }

  let finishReason = null;
  for await (const raw of lines(res.body)) {
    const line = raw.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.error) throw new Error(`Errore dal servizio: ${json.error.message || JSON.stringify(json.error)}`);
    const choice = json.choices?.[0];
    if (!choice) continue;
    const text = choice.delta?.content ?? choice.text ?? '';
    if (text) yield { text };
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  yield { finishReason };
}

/** Elenco dei modelli disponibili sul servizio. */
export async function listOpenAIModels(settings) {
  const url = settings.baseUrl.replace(/\/+$/, '') + '/models';
  let r;
  try {
    r = await fetch(url, { headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {} });
  } catch (err) {
    throw networkError(url, err);
  }
  if (!r.ok) throw new Error(`Il servizio ha risposto ${r.status}`);
  const j = await r.json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}
