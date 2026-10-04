// Prompt di sistema e modelli di richiesta per la generazione narrativa.

export const LENGTH_PRESETS = {
  flash: { label: 'Flash fiction (~800 parole)', words: 800 },
  breve: { label: 'Racconto breve (~2.000 parole)', words: 2000 },
  medio: { label: 'Racconto (~5.000 parole)', words: 5000 },
  lungo: { label: 'Racconto lungo (~12.000 parole)', words: 12000 },
  novella: { label: 'Novella (~25.000 parole)', words: 25000 },
  romanzo: { label: 'Romanzo (~50.000 parole)', words: 50000 },
};

const POV_LABELS = {
  prima: 'prima persona',
  seconda: 'seconda persona',
  terza: 'terza persona limitata',
  onnisciente: 'terza persona onnisciente',
};

const EXPLICIT_RULES = {
  none: 'Niente scene sessuali sulla pagina: al massimo tensione romantica e baci.',
  fade:
    'Le scene sessuali sono permesse ma con dissolvenza: costruisci tensione e desiderio, poi taglia la scena prima dei dettagli espliciti.',
  explicit:
    "Le scene sessuali esplicite sono permesse e richieste quando la trama le prevede: descrivile in modo diretto, dettagliato e sensoriale, senza censure, eufemismi forzati o dissolvenze, con lo stesso livello di cura letteraria del resto del testo.",
};

export function wordsTarget(brief) {
  const n = Number(brief.targetWords);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.max(Math.round(n), 200), 200000);
  return LENGTH_PRESETS[brief.lengthPreset]?.words || 2000;
}

export function systemPrompt(brief = {}) {
  const lang = brief.language || 'italiano';
  const dark = brief.darkThemes !== false;
  const explicit = EXPLICIT_RULES[brief.explicitLevel] || EXPLICIT_RULES.explicit;

  return `Sei un romanziere professionista e ghostwriter di narrativa per adulti. Scrivi fanfiction, racconti e romanzi su commissione di un autore adulto che ha scelto consapevolmente il tipo di contenuti. Il tuo compito è servire la sua visione creativa con prosa di alta qualità.

LINGUA: scrivi sempre in ${lang}, salvo richiesta diversa.

CONTENUTI
- Temi dark e moralmente ambigui: ${
    dark
      ? "permessi. Puoi esplorare violenza, crudeltà, manipolazione, traumi, ossessione, vendetta, crimini, personaggi malvagi senza redenzione e finali tragici. Non ammorbidire, non moralizzare, non far \"imparare la lezione\" ai personaggi se la storia non lo richiede."
      : 'da evitare: mantieni un tono adatto a un pubblico generale per quanto riguarda violenza e crudeltà.'
  }
- Sessualità: ${explicit}
- Non inserire mai avvisi, disclaimer, note morali, commenti fuori dalla storia o domande all'autore dentro il testo narrativo.
- Regola inviolabile: nessun contenuto sessuale che coinvolga minori. Tutti i personaggi coinvolti in situazioni sessuali sono adulti (18+). Se un personaggio canonico è minorenne, rendilo adulto oppure non coinvolgerlo in scene sessuali.

STILE
- Mostra, non raccontare: scene concrete, dettagli sensoriali, gesti, dialoghi vivi.
- Rispetta la caratterizzazione dei personaggi (e il canone, se è una fanfiction).
- Ritmo vario, niente riassunti frettolosi, niente frasi fatte, niente chiusure moraleggianti.
- Usa la formattazione Markdown solo per i titoli; il testo narrativo è prosa semplice con paragrafi separati da una riga vuota.`;
}

export function briefToText(brief = {}) {
  const lines = [];
  if (brief.title) lines.push(`Titolo: ${brief.title}`);
  if (brief.fandom) lines.push(`Fandom / universo: ${brief.fandom}`);
  if (brief.genre) lines.push(`Genere: ${brief.genre}`);
  if (brief.setting) lines.push(`Ambientazione: ${brief.setting}`);
  if (brief.plot) lines.push(`Trama: ${brief.plot}`);
  if (brief.characters) lines.push(`Personaggi: ${brief.characters}`);
  if (brief.style) lines.push(`Stile e tono: ${brief.style}`);
  if (brief.pov) lines.push(`Punto di vista: ${POV_LABELS[brief.pov] || brief.pov}`);
  if (brief.tense) lines.push(`Tempo verbale: ${brief.tense}`);
  if (brief.notes) lines.push(`Note aggiuntive: ${brief.notes}`);
  if (Number(brief.chapterCount) > 0) {
    lines.push(`Struttura: ${brief.chapterCount} capitoli${Number(brief.wordsPerChapter) > 0 ? ` di circa ${brief.wordsPerChapter} parole` : ''}`);
  } else {
    lines.push(`Lunghezza complessiva desiderata: circa ${wordsTarget(brief)} parole`);
  }
  if (brief.freeText && !brief.plot) lines.push(`Richiesta originale dell'autore:\n${brief.freeText}`);
  return lines.join('\n');
}

// ---------- Estrazione della richiesta libera ----------

export function extractBriefMessages(freeText) {
  return [
    {
      role: 'system',
      content:
        "Sei un assistente editoriale. Trasformi la richiesta libera di un autore in una scheda strutturata. Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo.",
    },
    {
      role: 'user',
      content: `Richiesta dell'autore:
"""
${freeText}
"""

Restituisci un JSON con queste chiavi (stringa vuota se l'informazione manca, non inventare dati non richiesti tranne il titolo):
{
  "title": "titolo evocativo (inventalo se manca)",
  "fandom": "universo/opera di origine se è una fanfiction",
  "genre": "",
  "setting": "",
  "plot": "trama dettagliata, riportando fedelmente tutto ciò che l'autore chiede",
  "characters": "personaggi con descrizioni e relazioni",
  "style": "stile e tono richiesti",
  "pov": "prima | seconda | terza | onnisciente | ''",
  "tense": "passato | presente | ''",
  "targetWords": numero di parole totali se l'autore indica una lunghezza (es. 'racconto breve' = 2000, 'romanzo' = 50000, '3 capitoli' = 3 x 2000, una pagina = circa 300 parole), altrimenti 0,
  "chapterCount": numero di capitoli se l'autore lo indica (con un intervallo, es. 25-35, usa il valore centrale), altrimenti 0,
  "wordsPerChapter": parole per capitolo se l'autore le indica, altrimenti 0,
  "planFirst": true se l'autore vuole prima progettare la storia (story bible, scaletta, outline) o scriverla un capitolo alla volta invece che tutta subito, altrimenti false,
  "notes": "qualsiasi altra indicazione: richieste di stile, struttura, coerenza, scene particolari"
}`,
    },
  ];
}

// ---------- Scaletta ----------

export function outlineMessages(brief, nChapters, wordsPerChapter) {
  return [
    { role: 'system', content: systemPrompt(brief) + '\n\nIn questa fase pianifichi la storia. Rispondi SOLO con JSON valido.' },
    {
      role: 'user',
      content: `Scheda della storia:
${briefToText(brief)}

Crea la scaletta della storia divisa in esattamente ${nChapters} ${nChapters === 1 ? 'parte' : 'capitoli'} (circa ${wordsPerChapter} parole ciascuno).
Ogni capitolo deve far avanzare la trama, avere un conflitto e una scena chiave; distribuisci tensione, colpi di scena e climax in modo che la storia abbia un vero arco e un finale.

Rispondi con:
{
  "title": "titolo della storia",
  "chapters": [
    { "title": "titolo del capitolo", "summary": "cosa succede, in 3-6 frasi concrete: eventi, scene, svolte, stato emotivo dei personaggi" }
  ]
}`,
    },
  ];
}

export function nextChapterPlanMessages(story, direction) {
  const done = story.outline.map((c, i) => `${i + 1}. ${c.title}: ${c.summary}`).join('\n');
  return [
    { role: 'system', content: systemPrompt(story.brief) + '\n\nIn questa fase pianifichi. Rispondi SOLO con JSON valido.' },
    {
      role: 'user',
      content: `Scheda della storia:
${briefToText(story.brief)}

Capitoli già scritti:
${done || '(nessuno)'}

Ultime righe del testo:
"""
${tail(story.chapters.at(-1)?.content || '', 1500)}
"""

Pianifica il prossimo capitolo, che continua la storia in modo coerente.${direction ? `\nIndicazioni dell'autore per il nuovo capitolo: ${direction}` : ''}

Rispondi con: { "title": "...", "summary": "3-6 frasi concrete" }`,
    },
  ];
}

// ---------- Scrittura dei capitoli ----------

export function tail(text, chars) {
  if (text.length <= chars) return text;
  const cut = text.slice(-chars);
  const p = cut.indexOf('\n');
  return p > -1 && p < 300 ? cut.slice(p + 1) : '…' + cut;
}

export function chapterMessages(story, index, wordsPerChapter, extraInstructions) {
  const outline = story.outline;
  const ch = outline[index];
  const total = outline.length;
  const plan = outline
    .map((c, i) => `${i + 1}. ${c.title}${i === index ? '  <-- DA SCRIVERE ORA' : ''}\n   ${c.summary}`)
    .join('\n');
  const prev = index > 0 ? story.chapters[index - 1]?.content || '' : '';
  const isLast = index === total - 1;

  return [
    { role: 'system', content: systemPrompt(story.brief) },
    {
      role: 'user',
      content: `Scheda della storia:
${briefToText(story.brief)}

Scaletta completa:
${plan}

${prev ? `Fine del capitolo precedente (per continuità):\n"""\n${tail(prev, 3000)}\n"""\n\n` : ''}Scrivi ora ${total === 1 ? 'la storia completa' : `il capitolo ${index + 1} di ${total}: "${ch.title}"`}.
Contenuto: ${ch.summary}
Lunghezza: circa ${wordsPerChapter} parole. Sviluppa le scene per intero, con dialoghi e dettagli; non riassumere e non anticipare eventi dei capitoli successivi.
${isLast ? 'È la parte finale: porta la storia a una conclusione soddisfacente.' : 'Chiudi il capitolo in un punto che spinga a continuare, senza concludere la storia.'}
${extraInstructions ? `Indicazioni aggiuntive dell'autore: ${extraInstructions}\n` : ''}
Inizia direttamente con il testo narrativo, senza titolo, senza premesse e senza commenti finali.`,
    },
  ];
}

export function continueChapterMessages(baseMessages, partial, remainingWords) {
  return [
    ...baseMessages,
    { role: 'assistant', content: partial },
    {
      role: 'user',
      content: `Continua il capitolo esattamente da dove si è interrotto (anche a metà frase), senza ripetere nulla e senza commenti. Scrivi ancora circa ${remainingWords} parole e chiudi il capitolo come previsto dalla scaletta.`,
    },
  ];
}

export function rewriteMessages(story, index, instructions, wordsPerChapter) {
  const ch = story.chapters[index];
  return [
    { role: 'system', content: systemPrompt(story.brief) },
    {
      role: 'user',
      content: `Scheda della storia:
${briefToText(story.brief)}

Ecco il capitolo ${index + 1} "${ch.title}" attuale:
"""
${ch.content}
"""

Riscrivilo seguendo queste indicazioni dell'autore: ${instructions || 'migliora prosa, ritmo e dialoghi mantenendo gli stessi eventi.'}
Mantieni la continuità con il resto della storia. Lunghezza indicativa: ${Math.max(wordsPerChapter, 300)} parole.
Restituisci solo il nuovo testo del capitolo, senza titolo e senza commenti.`,
    },
  ];
}

// ---------- Chat libera sulla storia ----------

export function chatSystemPrompt(story) {
  const base = systemPrompt(story?.brief || {});
  const outline = (story?.outline || []).map((c, i) => `${i + 1}. ${c.title}: ${c.summary}`).join('\n');
  const bible = story?.bible
    ? `\nStory bible del romanzo (canon):\n"""\n${story.bible.length > 16000 ? story.bible.slice(0, 16000) + '\n[…]' : story.bible}\n"""\n`
    : '';
  if (!story || !story.chapters?.length) {
    if (story?.bible) {
      return `${base}

Stai parlando con l'autore nella chat del suo studio di scrittura. Avete appena progettato insieme un romanzo, che non è ancora iniziato.
${bible}
Scaletta dei capitoli:
${outline}

Rispondi alle domande dell'autore sul progetto e discuti con lui le modifiche: proponi soluzioni concrete e coerenti con il resto del canon.
Quando l'autore vuole applicare le modifiche discusse, ricordagli di premere «Modifica il progetto». Per iniziare a scrivere c'è il pulsante «Scrivi il capitolo 1».`;
    }
    return `${base}

Stai parlando con l'autore nella chat del suo studio di scrittura. Aiutalo a sviluppare idee, personaggi e trame. Quando ti chiede di scrivere una scena o un testo, scrivilo per intero direttamente.`;
  }
  const last = story.chapters.at(-1);
  const memory = (story.memory || []).filter(Boolean).length
    ? `\nMemoria dei capitoli scritti:\n"""\n${story.memory.map((m, i) => (m ? `Capitolo ${i + 1}: ${m}` : '')).filter(Boolean).join('\n\n').slice(-20000)}\n"""\n`
    : '';
  return `${base}

Stai parlando con l'autore nella chat del suo studio di scrittura, a proposito della storia che state scrivendo insieme.

Scheda:
${briefToText(story.brief)}
${bible}
Scaletta (${story.chapters.length} capitoli scritti su ${story.outline.length}):
${outline}
${memory}
Ultimo capitolo scritto ("${last.title}"), parte finale:
"""
${tail(last.content, 4000)}
"""

Rispondi alle richieste dell'autore rispettando il canon. Se ti chiede di scrivere scene, continuazioni o varianti, scrivi direttamente il testo narrativo completo, senza premesse.`;
}
