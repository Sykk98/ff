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

## Requisiti

- Node.js 18 o superiore. Non servono altre dipendenze, quindi niente `npm install`.
- Un modello AI raggiungibile tramite un'API compatibile OpenAI.

## Avvio

```bash
npm start
```

Apri http://localhost:3000. Al primo avvio si apre la finestra **Impostazioni**: scegli il provider, inserisci chiave e nome del modello, premi «Prova connessione» e salva.

## Quale modello usare

L'app funziona con qualsiasi endpoint `/chat/completions` compatibile OpenAI. **Il tipo di contenuti che ottieni dipende dalle regole del provider e del modello**: molti modelli commerciali rifiutano scene esplicite o molto violente. Le strade più semplici sono:

| Opzione | URL base | Note |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | Un'unica chiave per centinaia di modelli. Scegli un modello la cui policy ammette contenuti per adulti. |
| Ollama (locale) | `http://localhost:11434/v1` | Gratis e privato, gira sul tuo PC. Nessuna chiave. |
| LM Studio (locale) | `http://localhost:1234/v1` | Interfaccia grafica per scaricare e avviare modelli locali. |
| llama.cpp / KoboldCpp | `http://localhost:8080/v1` | Server locali leggeri. |

Con «Carica elenco» nelle impostazioni vedi i modelli disponibili sul provider.

Puoi anche configurare tutto con un file `.env` (vedi `.env.example`).

### Impostazioni utili

- **Parole per capitolo** (predefinito 2000): decide in quanti capitoli viene divisa la storia. Un romanzo da 50.000 parole diventa 25 capitoli.
- **Max token per risposta** (predefinito 6000): abbassalo se il provider dà errore sul limite di token. Se un capitolo si interrompe, l'app chiede automaticamente al modello di continuarlo.
- **Temperatura**: più alta significa prosa più creativa e imprevedibile.

## Regola sui contenuti

L'app permette contenuti per adulti, ma il prompt di sistema vieta sempre contenuti sessuali che coinvolgono minori: i personaggi coinvolti in scene sessuali sono sempre adulti. Questa regola non è disattivabile.

## Provare senza chiave API

Un finto provider genera testo segnaposto per vedere l'interfaccia in azione:

```bash
npm run mock    # in un terminale
npm start       # in un altro
```

Nelle impostazioni usa URL `http://localhost:3999/v1` e modello `mock`.

## Test

```bash
npm test
```

Avvia il finto provider e il server, poi verifica scaletta, generazione dei capitoli, continuazione, riscrittura, chat ed esportazione.

## Struttura

```
server.js          server HTTP e API
lib/llm.js         client per API compatibili OpenAI, in streaming
lib/prompts.js     prompt di sistema, scaletta, capitoli, riscritture, chat
lib/generator.js   orchestrazione: richiesta → scaletta → capitoli
lib/store.js       salvataggio di storie e impostazioni in data/
public/            interfaccia web (HTML, CSS, JS senza framework)
scripts/           finto provider e test end-to-end
```

## Accesso da altri dispositivi

Il server ascolta solo su `127.0.0.1`. Per usarlo dal telefono sulla stessa rete, avvialo con `HOST=0.0.0.0 npm start`. Non c'è login, quindi non esporlo su internet.
