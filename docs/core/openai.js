// Client in streaming per API compatibili OpenAI /chat/completions.
// Usa solo fetch e ReadableStream, quindi funziona sia in Node (>= 18) sia nel browser del telefono.

const isMistralProxy = (url) => /^\/api\/mistral\//.test(url);

function buildHeaders(settings) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  // La password dell'app va solo al ponte per Mistral sullo stesso indirizzo, mai a servizi esterni.
  if (settings.appPassword && isMistralProxy(settings.baseUrl || '')) headers['X-App-Password'] = settings.appPassword;
  if (/openrouter\.ai/.test(settings.baseUrl || '')) {
    const origin = typeof location !== 'undefined' && location.origin?.startsWith('http') ? location.origin : 'http://localhost';
    headers['HTTP-Referer'] = origin;
    headers['X-Title'] = 'Fanfic Studio';
  }
  return headers;
}

const hostOf = (url) => {
  try {
    return new URL(url, globalThis.location?.href).host;
  } catch {
    return url;
  }
};

function networkError(url, err) {
  const inBrowser = typeof window !== 'undefined';
  if (inBrowser) {
    if (isMistralProxy(url)) return new Error('Impossibile contattare il ponte per Mistral. Controlla la connessione.');
    return new Error(
      `Impossibile contattare ${hostOf(url)}. Controlla la connessione. ` +
        'Se il problema continua, questo servizio potrebbe non accettare richieste dirette dal browser: usa OpenRouter, che le accetta.',
    );
  }
  return new Error(`Impossibile contattare ${url}: ${err.message}`);
}

// Distanza minima tra due richieste allo stesso servizio (i piani gratuiti limitano le richieste al secondo).
const lastRequestAt = new Map();
async function throttle(url, settings, signal) {
  const gap = /mistral/.test(settings.baseUrl || '') ? 1500 : 300;
  const key = hostOf(url);
  const wait = (lastRequestAt.get(key) || 0) + gap - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastRequestAt.set(key, Date.now());
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Interrotto'), { name: 'AbortError' }));
    }, { once: true });
  });
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
export async function* streamOpenAI(settings, messages, { maxTokens, temperature, signal, onWait } = {}) {
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
  // Limite di richieste (frequente sui piani gratuiti): attende e riprova per circa 3 minuti.
  const waits = [5, 10, 20, 40, 60, 60];
  for (let attempt = 0; ; attempt++) {
    await throttle(url, settings, signal);
    try {
      res = await fetch(url, { method: 'POST', headers: buildHeaders(settings), body: JSON.stringify(body), signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw networkError(url, err);
    }
    if (res.status !== 429 || attempt >= waits.length) break;
    const retryAfter = Number(res.headers.get('retry-after'));
    const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(Math.ceil(retryAfter), 90) : waits[attempt];
    await res.body?.cancel?.().catch(() => {});
    onWait?.(seconds, attempt + 1);
    await sleep(seconds * 1000, signal);
  }
  if (res.status === 429) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || j.message || text;
    } catch {}
    throw new Error(
      'Il servizio continua a rispondere che è stato superato il limite di richieste del tuo piano. ' +
        'Aspetta qualche minuto e riprova: il lavoro già fatto resta salvato e l\'app riprende da dove si è fermata. ' +
        'I limiti del tuo account Mistral sono indicati su console.mistral.ai, alla voce Limits. ' +
        `Dettaglio: ${String(detail).slice(0, 200)}`,
    );
  }

  if (!res.ok) {
    if (isMistralProxy(url) && [404, 405].includes(res.status) && !(res.headers.get('content-type') || '').includes('json')) {
      throw new Error(PROXY_MISSING);
    }
    const text = await res.text().catch(() => '');
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || j.message || j.detail || text;
    } catch {}
    if (res.status === 401 && !isMistralProxy(url)) detail = `chiave API non valida o mancante. ${detail}`;
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

// Modelli Mistral in ordine di qualità: se il piano dell'utente non include un modello,
// l'app prova automaticamente il successivo e ricorda quello che funziona.
export const MISTRAL_FALLBACKS = ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'open-mistral-nemo'];
const TIER_ERROR = /not available in your|subscription tier|not (?:included|available) (?:in|with) your|upgrade your plan|invalid model|model .*not found|no such model/i;

const isMistral = (settings) => /api\.mistral\.ai|(?:^|\/)api\/mistral\//.test(settings.baseUrl || '');

/**
 * Come streamOpenAI, ma con Mistral passa a un modello incluso nel piano se quello scelto non lo è.
 * onModelChange(nuovoModello) viene chiamata quando un modello alternativo funziona.
 */
export async function* streamWithModelFallback(settings, messages, opts = {}, onModelChange) {
  const chain = isMistral(settings) ? [settings.model, ...MISTRAL_FALLBACKS.filter((m) => m !== settings.model)] : [settings.model];
  let lastError = null;
  for (const model of chain) {
    let started = false;
    try {
      for await (const part of streamOpenAI({ ...settings, model }, messages, opts)) {
        started = true;
        yield part;
      }
      if (model !== settings.model) {
        settings.model = model; // le richieste successive della stessa operazione usano subito il modello buono
        await onModelChange?.(model);
      }
      return;
    } catch (err) {
      if (started || err.name === 'AbortError' || !TIER_ERROR.test(err.message || '')) throw err;
      lastError = err;
    }
  }
  throw new Error(
    'Nessun modello di Mistral è disponibile con il tuo piano. Su console.mistral.ai controlla di aver attivato il piano gratuito «Experiment» ' +
      '(sezione Billing o Subscription) e che la chiave sia di quell\'account. Dettaglio: ' + (lastError?.message || ''),
  );
}

export const PROXY_MISSING =
  'Mistral non è disponibile a questo indirizzo: serve la versione dell\'app pubblicata su Cloudflare (Worker o Pages), che contiene il ponte per Mistral. ' +
  'Qui puoi usare OpenRouter.';

/** Elenco dei modelli disponibili sul servizio. */
export async function listOpenAIModels(settings) {
  const url = settings.baseUrl.replace(/\/+$/, '') + '/models';
  let r;
  try {
    const { 'Content-Type': _, ...headers } = buildHeaders(settings);
    r = await fetch(url, { headers });
  } catch (err) {
    throw networkError(url, err);
  }
  if (!r.ok) {
    const type = r.headers.get('content-type') || '';
    if (isMistralProxy(url) && !type.includes('json')) throw new Error(PROXY_MISSING);
    const j = type.includes('json') ? await r.json().catch(() => ({})) : {};
    throw new Error(j.error?.message || j.message || `Il servizio ha risposto ${r.status}`);
  }
  const j = await r.json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}
