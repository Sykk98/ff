// Cloudflare Pages Function: ponte verso l'API di Mistral.
//
// Perché serve: Mistral non accetta richieste dirette dal browser (CORS), quindi la versione
// per telefono non può chiamarlo da sola. Questa funzione gira sullo stesso indirizzo dell'app
// e inoltra le richieste a Mistral, aggiungendo lo streaming senza modificarlo.
//
// Due modi di fornire la chiave di Mistral:
// 1. accesso automatico: la chiave è salvata come segreto MISTRAL_API_KEY nelle impostazioni
//    di Cloudflare Pages. L'app non deve conoscerla. Serve anche il segreto APP_PASSWORD,
//    perché l'indirizzo pages.dev è pubblico: senza password chiunque lo trovi userebbe il tuo account.
// 2. chiave nell'app: il telefono invia la propria chiave a ogni richiesta (intestazione Authorization).
//
// Sicurezza:
// - inoltra solo verso api.mistral.ai e solo a /v1/chat/completions e /v1/models;
// - non registra né restituisce mai la chiave;
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

/** Confronto a tempo costante (tramite hash) per non rivelare la password con i tempi di risposta. */
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function onRequest(context) {
  const { request, params } = context;
  const env = context.env || {};
  const path = (Array.isArray(params.path) ? params.path : [params.path || '']).join('/');
  const url = new URL(request.url);

  // Controllo di salute usato dall'app per capire se il ponte è disponibile.
  if (path === 'health') {
    return json(200, {
      ok: true,
      service: 'mistral-proxy',
      serverKey: Boolean(env.MISTRAL_API_KEY), // accesso automatico configurato su Cloudflare
      passwordRequired: Boolean(env.MISTRAL_API_KEY),
      passwordSet: Boolean(env.APP_PASSWORD),
    });
  }

  const method = ALLOWED[path];
  if (!method) return json(404, { error: { message: 'Percorso non consentito' } });
  if (request.method !== method) return json(405, { error: { message: 'Metodo non consentito' } });

  // Solo la stessa origine dell'app (i browser inviano Origin sulle POST e sulle richieste cross-site).
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json(403, { error: { message: 'Origine non consentita' } });

  let auth = request.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) {
    // Nessuna chiave dal telefono: usa quella salvata su Cloudflare, protetta dalla password dell'app.
    if (!env.MISTRAL_API_KEY) {
      return json(401, { error: { message: 'Manca la chiave API di Mistral. Inseriscila nelle Impostazioni.' } });
    }
    if (!env.APP_PASSWORD) {
      return json(503, {
        error: {
          code: 'password_not_configured',
          message: 'Accesso automatico non attivo: su Cloudflare manca il segreto APP_PASSWORD. Aggiungilo nelle impostazioni del progetto.',
        },
      });
    }
    const given = request.headers.get('X-App-Password') || '';
    if (!given || !(await sameSecret(given, env.APP_PASSWORD))) {
      return json(401, { error: { code: 'bad_password', message: 'Password dell\'app errata o mancante. Controllala nelle Impostazioni.' } });
    }
    auth = `Bearer ${env.MISTRAL_API_KEY}`;
  }

  let body;
  if (method === 'POST') {
    body = await request.text();
    if (body.length > MAX_BODY) return json(413, { error: { message: 'Richiesta troppo grande' } });
  }

  const upstream = env.MISTRAL_UPSTREAM || UPSTREAM;
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
  // indicazioni sui limiti del piano: servono all'app per sapere quanto aspettare prima di riprovare
  for (const h of ['Retry-After', 'X-RateLimit-Limit-Requests', 'X-RateLimit-Remaining-Requests', 'X-RateLimit-Reset-Requests']) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
}
