# 🖋️ Fanfic Studio

Studio di scrittura con AI per **fanfiction, racconti e romanzi**, anche con temi dark, moralmente ambigui e scene sessuali esplicite tra adulti.

Scrivi nella chat trama, personaggi e lunghezza: l'AI prepara una scaletta e scrive la storia completa in automatico, capitolo per capitolo. Poi puoi chattare sulla storia, chiedere riscritture, aggiungere capitoli ed esportare il testo.

## Funzioni

- **Chat AI**: descrivi la storia a parole tue. L'app estrae titolo, trama, personaggi e lunghezza dalla richiesta.
- **Generazione automatica a capitoli**: dalla flash fiction (~800 parole) al romanzo (~50.000), oppure una lunghezza a scelta. Ogni capitolo riceve scaletta e finale del capitolo precedente per mantenere la continuità.
- **Opzioni di contenuto per storia**: temi dark sì/no, scene sessuali esplicite / con dissolvenza / assenti, punto di vista, tempo verbale, lingua, genere e stile.
- **Scheda Storia**: lettura impaginata, modifica a mano, riscrittura AI di un capitolo con istruzioni («più dark», «scena più esplicita», «aggiungi un dialogo»), annulla riscrittura, elimina capitolo.
- **Continua la storia**: aggiunge nuovi capitoli oltre la scaletta, con indicazioni facoltative.
- **Testo dalla chat alla storia**: ogni risposta della chat può diventare un capitolo con un clic.
- **Esportazione** in Markdown o testo semplice, copia negli appunti.
- **Interruzione e ripresa**: puoi fermare la generazione e riprenderla dal capitolo successivo.
- Tutto resta sul tuo computer, in file JSON nella cartella `data/`.

## Versione per telefono

L'app funziona anche solo dal telefono, senza computer e senza installare niente. L'AI lavora online con **Mistral** e le storie restano salvate nel browser del telefono.

Mistral non accetta richieste dirette da una pagina web. Per questo la versione per telefono si pubblica su **Cloudflare**, gratis, come Worker o come progetto Pages: oltre all'app ospita un piccolo ponte che inoltra le richieste a Mistral. Il ponte inoltra solo verso Mistral e accetta solo richieste dall'app. La chiave può stare sul telefono oppure, per l'accesso automatico, nei segreti di Cloudflare.

### 1. Pubblicare l'app su Cloudflare (una volta sola, dal telefono)

**Come Worker (consigliato).** Il repository contiene `wrangler.jsonc`, che Cloudflare legge da solo.

1. Crea un account gratuito su [dash.cloudflare.com](https://dash.cloudflare.com).
2. Apri **Workers & Pages**, premi **Create** e scegli di importare un repository da GitHub.
3. Collega GitHub, scegli il repository `ff` e lascia le impostazioni proposte (comando di pubblicazione `npx wrangler deploy`).
4. Premi **Deploy**. L'app è online su `https://ff.TUO-ACCOUNT.workers.dev`. Lo trovi anche nel progetto, alla voce **Domains & Routes** o con il pulsante **Visit**.

Ogni volta che il branch su GitHub cambia, Cloudflare ripubblica l'app da solo.

**Come progetto Pages (alternativa).** In **Workers & Pages** → **Create** scegli la scheda **Pages** → **Connect to Git**, poi imposta Framework preset `None`, Build command vuoto e Build output directory `docs`. Il ponte in questo caso è `functions/api/mistral`.

### 2. Creare la chiave di Mistral

1. Vai su [console.mistral.ai](https://console.mistral.ai) e crea un account.
2. Attiva il piano gratuito **Experiment**. Mistral chiede di verificare il numero di telefono e di accettare che i testi possano essere usati per addestrare i suoi modelli.
3. In **API Keys** crea una nuova chiave e copiala.

### 3. Accesso automatico a Mistral (consigliato)

Invece di incollare la chiave nell'app, salvala una volta su Cloudflare: il ponte la aggiunge da solo a ogni richiesta.

1. Nel progetto su Cloudflare apri **Settings → Variables and Secrets** e aggiungi due variabili di tipo **Secret**. Usa proprio «Secret» e non «Text»: le variabili di tipo testo vengono cancellate a ogni nuova pubblicazione.
   - `MISTRAL_API_KEY`: la chiave di Mistral;
   - `APP_PASSWORD`: una password a tua scelta.
2. Su un Worker i segreti si attivano appena li salvi. Su un progetto Pages invece apri **Deployments** e ripubblica l'ultima versione (**Retry deployment**).
3. Apri sul telefono `https://TUO-INDIRIZZO/#accesso=LA-TUA-PASSWORD`, per esempio `https://ff.TUO-ACCOUNT.workers.dev/#accesso=...`. L'app salva la password, cancella il link dalla barra degli indirizzi ed è subito collegata.

La password serve perché l'indirizzo dell'app è pubblico: senza, chiunque lo trovi userebbe il tuo account Mistral. Senza `APP_PASSWORD` il ponte rifiuta l'accesso automatico. In alternativa al link puoi scrivere la password nelle Impostazioni, una volta sola. Il pulsante «Copia link di accesso» crea il link per un altro telefono o browser.

Se preferisci, puoi saltare questo passo e incollare la chiave direttamente nelle Impostazioni dell'app.

### 4. Usare l'app

1. Apri l'indirizzo dell'app sul telefono. È già scelto **Mistral Large**.
2. Se non hai usato il link di accesso, inserisci la password dell'app oppure la chiave, premi «Prova connessione» e poi Salva.
3. Dal menu del browser scegli «Aggiungi a schermata Home» per aprirla come un'app. Su iPhone l'icona sulla schermata Home ha una memoria separata da Safari: la prima volta che la apri inserisci di nuovo la password nelle Impostazioni.

### Da sapere

- **Regole di Mistral:** la narrativa esplicita è permessa. Sono vietati i contenuti sessuali con minori e, secondo le sue regole d'uso, la violenza sessuale anche inventata.
- **Alternative nella stessa finestra:** Mistral Small, più veloce, e OpenRouter, che funziona anche senza ponte. Il modello gratuito Venice Uncensored di OpenRouter non ha filtri, ma ha un limite di 50 richieste al giorno.
- **Le storie** sono salvate solo nel browser del telefono. Usa ogni tanto «Scarica backup» nelle Impostazioni.
- **GitHub Pages** può ospitare l'app, ma senza ponte: lì funziona solo OpenRouter.
- **Provarla sul computer:** `npm run dev:phone` emula Cloudflare Pages in locale. Con `MISTRAL_UPSTREAM=http://localhost:3999` e `npm run mock` usa il finto provider. Aggiungi `MISTRAL_API_KEY` e `APP_PASSWORD` per provare l'accesso automatico.

## Requisiti

- Node.js 18 o superiore. Non servono altre dipendenze, quindi niente `npm install`.
- [Ollama](https://ollama.com/download) per usare un modello AI sul tuo computer, gratis e senza filtri esterni. In alternativa, un servizio online compatibile con l'API OpenAI.

## Avvio rapido con Ollama

1. Installa Ollama da [ollama.com/download](https://ollama.com/download). Su Windows e Mac parte da solo; su Linux avvialo con `ollama serve`.
2. Avvia l'app:

   ```bash
   npm start
   ```

3. Apri http://localhost:3000. Si apre la finestra **Impostazioni** sulla scheda Ollama.
4. Scegli un modello dall'elenco dei consigliati e premi per scaricarlo. L'avanzamento compare nella finestra.
5. Premi «Prova connessione», poi Salva. Il primo caricamento del modello in memoria può richiedere un minuto.

Tutto resta sul tuo computer: nessun servizio esterno legge le tue storie e non ci sono limiti di utilizzo.

### Quale modello scaricare

Dipende dalla memoria della scheda video (VRAM):

| Modello | Download | VRAM consigliata | Note |
|---|---|---|---|
| Dolphin Mistral Nemo 12B | ~7 GB | 12 GB | Consigliato. Non censurato, buon italiano. |
| Mistral Nemo 12B | ~7 GB | 12 GB | Ufficiale, ottimo italiano, pochi filtri. |
| Dolphin 3.0 (Llama 3.1 8B) | ~5 GB | 8 GB | Non censurato e leggero, italiano meno curato. |
| Mistral Small 24B | ~14 GB | 16–24 GB | La qualità migliore. |

Senza una scheda video adatta i modelli girano sul processore, ma molto più lentamente. Nel campo «oppure scrivi un nome» puoi scaricare qualsiasi altro modello della libreria di Ollama, oppure un modello GGUF da Hugging Face con il formato `hf.co/utente/repository`.

### Perché l'app usa l'API nativa di Ollama

L'app comunica con Ollama tramite la sua API nativa, non tramite quella compatibile OpenAI. Solo così può impostare il **contesto**, cioè quanto testo il modello tiene a mente. Ollama di default usa 4.096 token sulle schede con meno di 24 GB, troppo pochi per scaletta, fine del capitolo precedente e nuovo capitolo insieme: il prompt verrebbe tagliato senza avviso. L'app usa 12.288 token, modificabili in Impostazioni → Avanzate. Abbassali a 8.192 se la scheda video ha poca memoria.

## Servizi online

Nella scheda «Servizio online» delle Impostazioni puoi usare qualsiasi API compatibile OpenAI: OpenRouter, Mistral, DeepSeek, LM Studio, llama.cpp, Groq e altri. **Il tipo di contenuti che ottieni dipende dalle regole del servizio e del modello**: molti modelli commerciali rifiutano scene esplicite o molto violente.

### Impostazioni utili

- **Parole per capitolo** (predefinito 2000): decide in quanti capitoli viene divisa la storia. Un romanzo da 50.000 parole diventa 25 capitoli.
- **Max token per risposta** (predefinito 6000): se un capitolo si interrompe, l'app chiede automaticamente al modello di continuarlo.
- **Temperatura**: più alta significa prosa più creativa e imprevedibile.

Puoi anche configurare tutto con un file `.env` (vedi `.env.example`).

## Regola sui contenuti

L'app permette contenuti per adulti, ma il prompt di sistema vieta sempre contenuti sessuali che coinvolgono minori: i personaggi coinvolti in scene sessuali sono sempre adulti. Questa regola non è disattivabile.

## Provare senza chiave API

Un finto provider genera testo segnaposto per vedere l'interfaccia in azione. Imita sia Ollama sia le API compatibili OpenAI:

```bash
npm run mock    # in un terminale
npm start       # in un altro
```

Nelle impostazioni, scheda Ollama, apri Avanzate e usa l'indirizzo `http://localhost:3999`. Il modello finto `mock-nemo` risulta già installato, e i download dei modelli consigliati sono simulati.

## Test

```bash
npm test
```

Avvia il finto provider e il server, poi verifica il ponte per Mistral (sicurezza e streaming), stato e download dei modelli Ollama, passaggio del contesto, scaletta, generazione dei capitoli, continuazione, riscrittura, chat, cambio di provider ed esportazione.

## Struttura

```
server.js          server HTTP e API
lib/llm.js         client in streaming: sceglie tra Ollama e API compatibili OpenAI
lib/ollama.js      API nativa di Ollama: chat, modelli installati, download
lib/store.js       salvataggio di storie e impostazioni in data/
docs/              interfaccia web, pubblicata anche come versione per telefono
docs/core/         motore condiviso tra server e telefono: prompt, scaletta, capitoli, chat
docs/local-backend.js  versione per telefono: storie nel browser, AI chiamata direttamente
functions/api/mistral/ ponte per Mistral (Mistral non accetta richieste dal browser)
worker/index.js        Worker di Cloudflare: serve docs/ e usa lo stesso ponte
wrangler.jsonc         configurazione del Worker letta da Cloudflare a ogni pubblicazione
scripts/pages-dev.js   emulazione locale di Cloudflare Pages
scripts/           finto provider e test end-to-end
```

## Accesso da altri dispositivi

Il server ascolta solo su `127.0.0.1`. Per usarlo dal telefono sulla stessa rete, avvialo con `HOST=0.0.0.0 npm start`. Non c'è login, quindi non esporlo su internet.
