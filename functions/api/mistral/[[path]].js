// Cloudflare Pages Function: ponte verso l'API di Mistral.
//
// Perché serve: Mistral non accetta richieste dirette dal browser (CORS), quindi la versione
// per telefono non può chiamarlo da sola. Questa funzione gira sullo stesso indirizzo dell'app
// e inoltra le richieste a Mistral, aggiungendo lo streaming senza modificarlo.
//
// Sicurezza:
// - inoltra solo verso api.mistral.ai e solo a /v1/chat/completions e /v1/models;
// - non conserva la chiave: arriva dal telefono a ogni richiesta e va solo a Mistral;
// - accetta solo richieste dalla stessa origine dell'app.

const UPSTREAM = 'https://api.mistral.ai';
const ALLOWED = {
  'v1/chat/completions': 'POST',
  'v1/models': 'GET',
};
const MAX_BODY = 2 * 1024 * 1024;

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, params, env } = context;
  const path = (Array.isArray(params.path) ? params.path : [params.path || '']).join('/');
  const url = new URL(request.url);

  // Controllo di salute usato dall'app per capire se il ponte è disponibile.
  if (path === 'health') return json(200, { ok: true, service: 'mistral-proxy' });

  const method = ALLOWED[path];
  if (!method) return json(404, { error: { message: 'Percorso non consentito' } });
  if (request.method !== method) return json(405, { error: { message: 'Metodo non consentito' } });

  // Solo la stessa origine dell'app (i browser inviano Origin sulle POST e sulle richieste cross-site).
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json(403, { error: { message: 'Origine non consentita' } });

  const auth = request.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) {
    return json(401, { error: { message: 'Manca la chiave API di Mistral. Inseriscila nelle Impostazioni.' } });
  }

  let body;
  if (method === 'POST') {
    body = await request.text();
    if (body.length > MAX_BODY) return json(413, { error: { message: 'Richiesta troppo grande' } });
  }

  const upstream = (env && env.MISTRAL_UPSTREAM) || UPSTREAM;
  let res;
  try {
    res = await fetch(`${upstream}/${path}`, {
      method,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: method === 'POST' ? 'text/event-stream, application/json' : 'application/json',
      },
      body,
    });
  } catch (err) {
    return json(502, { error: { message: `Mistral non raggiungibile: ${err.message}` } });
  }

  // Restituisce la risposta così com'è (anche in streaming).
  const headers = new Headers();
  headers.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
  headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}
