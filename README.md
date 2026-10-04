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

Avvia il finto provider e il server, poi verifica stato e download dei modelli Ollama, passaggio del contesto, scaletta, generazione dei capitoli, continuazione, riscrittura, chat, cambio di provider ed esportazione.

## Struttura

```
server.js          server HTTP e API
lib/llm.js         client in streaming: sceglie tra Ollama e API compatibili OpenAI
lib/ollama.js      API nativa di Ollama: chat, modelli installati, download
lib/prompts.js     prompt di sistema, scaletta, capitoli, riscritture, chat
lib/generator.js   orchestrazione: richiesta → scaletta → capitoli
lib/store.js       salvataggio di storie e impostazioni in data/
public/            interfaccia web (HTML, CSS, JS senza framework)
scripts/           finto provider e test end-to-end
```

## Accesso da altri dispositivi

Il server ascolta solo su `127.0.0.1`. Per usarlo dal telefono sulla stessa rete, avvialo con `HOST=0.0.0.0 npm start`. Non c'è login, quindi non esporlo su internet.
