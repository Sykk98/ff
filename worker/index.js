// Cloudflare Worker: pubblica l'app (cartella docs/) e il ponte per Mistral.
// È l'alternativa a Cloudflare Pages: stesso risultato, configurato da wrangler.jsonc.
// Il ponte è lo stesso codice usato da Pages (functions/api/mistral).
import { onRequest as mistralProxy } from '../functions/api/mistral/[[path]].js';

const PREFIX = '/api/mistral/';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(PREFIX)) {
      const path = url.pathname.slice(PREFIX.length).split('/').filter(Boolean);
      return mistralProxy({ request, env, params: { path } });
    }
    if (url.pathname.startsWith('/api/')) {
      // Nessun server dell'app qui: l'interfaccia passa da sola alla modalità telefono.
      return new Response('Not found', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
