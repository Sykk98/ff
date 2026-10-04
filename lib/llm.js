// Client minimale per qualsiasi endpoint compatibile con OpenAI /chat/completions.
// Funziona con OpenRouter, OpenAI, Ollama (/v1), LM Studio, llama.cpp server, vLLM, DeepSeek, Mistral, ecc.

function buildHeaders(settings) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  if (/openrouter\.ai/.test(settings.baseUrl || '')) {
    headers['HTTP-Referer'] = 'http://localhost';
    headers['X-Title'] = 'Fanfic Studio';
  }
  return headers;
}

/**
 * Stream di testo dal modello. Restituisce un async iterator di oggetti
 * { text } per i pezzi di testo e, alla fine, { finishReason }.
 */
export async function* streamChat(settings, messages, { maxTokens, temperature, signal } = {}) {
  if (!settings.baseUrl) throw new Error('Endpoint API non configurato. Apri Impostazioni.');
  if (!settings.model) throw new Error('Modello non configurato. Apri Impostazioni.');

  const body = {
    model: settings.model,
    messages,
    stream: true,
    temperature: temperature ?? settings.temperature ?? 0.9,
  };
  const limit = maxTokens ?? settings.maxTokens;
  if (limit && Number(limit) > 0) body.max_tokens = Math.round(Number(limit));
  if (settings.topP && Number(settings.topP) > 0 && Number(settings.topP) < 1) body.top_p = Number(settings.topP);

  const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(settings),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(`Impossibile contattare ${url}: ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || j.message || text;
    } catch {}
    throw new Error(`Errore dal provider (${res.status}): ${String(detail).slice(0, 500)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = null;

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        yield { finishReason };
        return;
      }
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) throw new Error(`Errore dal provider: ${json.error.message || JSON.stringify(json.error)}`);
      const choice = json.choices?.[0];
      if (!choice) continue;
      const text = choice.delta?.content ?? choice.text ?? '';
      if (text) yield { text };
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  yield { finishReason };
}

/** Chiamata completa (non in streaming lato client): restituisce { text, finishReason }. */
export async function complete(settings, messages, opts = {}) {
  let text = '';
  let finishReason = null;
  for await (const part of streamChat(settings, messages, opts)) {
    if (part.text) text += part.text;
    if (part.finishReason !== undefined) finishReason = part.finishReason;
  }
  return { text, finishReason };
}

/** Estrae un oggetto JSON da una risposta del modello, tollerando ```json e testo extra. */
export function parseJsonLoose(text) {
  if (!text) return null;
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1];
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const candidate = t.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // tentativo di pulizia: virgole finali
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}
