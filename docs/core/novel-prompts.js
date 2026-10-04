// Prompt della modalità romanzo: progetto (story bible + scaletta), capitoli lunghi scritti
// per scene, memoria di continuità aggiornata dopo ogni capitolo, revisione del progetto.
import { systemPrompt, briefToText, tail } from './prompts.js';

/** Taglia un testo lungo tenendo l'inizio (per la story bible, che è ordinata per importanza). */
export function head(text, chars) {
  if (!text || text.length <= chars) return text || '';
  return text.slice(0, chars) + '\n[…]';
}

const PLAN_RULES = `Regole del progetto:
- Riporta fedelmente TUTTI i dettagli che l'autore ha già stabilito (nomi, età, altezze, aspetto, capelli, passioni, relazioni, trama, richieste sulla struttura) senza cambiarli né ammorbidirli. Sono canon.
- Inventa con coerenza tutto ciò che manca, in modo concreto e specifico (nomi, luoghi, date, mestieri, famiglie), mai generico.
- Rispetta le richieste strutturali dell'autore (per esempio in che punto del romanzo nasce la coppia e cosa racconta la seconda metà).
- I personaggi devono essere imperfetti, con problemi e obiettivi propri indipendenti dalla storia d'amore. Anche i personaggi di supporto hanno personalità, problemi e piccoli archi narrativi propri.
- Tutti i personaggi coinvolti in scene sessuali sono maggiorenni.`;

export function bibleMessages(story, nChapters, wordsPerChapter) {
  return [
    { role: 'system', content: systemPrompt(story.brief) + '\n\nIn questa fase sei un editor e progetti un romanzo prima di scriverlo.' },
    {
      role: 'user',
      content: `Richiesta dell'autore:
"""
${story.brief.freeText || briefToText(story.brief)}
"""

Scheda ricavata dalla richiesta:
${briefToText(story.brief)}

Il romanzo avrà ${nChapters} capitoli di circa ${wordsPerChapter} parole ciascuno.

Scrivi la STORY BIBLE completa del romanzo: il documento di riferimento che garantisce la coerenza dal primo all'ultimo capitolo.

${PLAN_RULES}

Usa esattamente queste sezioni in Markdown:
# Story bible: <titolo>
## Premessa
## Ambientazione
(città, epoca, stagione di inizio, luoghi ricorrenti descritti in modo concreto: case, locali, scuole o lavori, strade)
## Protagonisti
(per ciascuno: nome completo, età e data di nascita, aspetto fisico dettagliato, stile nel vestire, personalità, modo di parlare e di ragionare, abitudini e piccoli gesti tipici, passioni, difetti, ferite del passato, famiglia, situazione economica e lavorativa o di studio, obiettivo personale indipendente dalla relazione, arco personale dall'inizio alla fine)
## Personaggi di supporto
(i due principali con la stessa profondità: personalità, problemi, relazioni, arco narrativo proprio; poi i personaggi minori in breve)
## Relazioni tra i personaggi
(chi conosce chi, da quanto, con quale storia comune)
## Conflitto principale
## Conflitti personali
(di ciascun protagonista, indipendenti dalla storia d'amore)
## Arco romantico
(se la storia ne ha uno: tutte le tappe in ordine, con il capitolo indicativo: conoscenza, amicizia, incomprensioni, momenti piccoli che contano, gelosia non riconosciuta, paura di perdersi, consapevolezza, primo bacio, decisione di stare insieme, prima volta, primo "ti amo", vita di coppia, crisi, crescita)
## Colpi di scena principali
## Finale
## Temi, tono e stile
## Timeline
(date, stagioni ed età nel corso del romanzo)
## Regole di canon
(fatti che non devono mai cambiare; chi sa cosa e quando lo scopre)

Sii dettagliata e concreta. Non scrivere ancora nessun capitolo.`,
    },
  ];
}

export function outlineBatchMessages(story, from, to, nChapters, wordsPerChapter) {
  const done = story.outline
    .slice(0, from)
    .map((c, i) => `${i + 1}. ${c.title}: ${c.summary}`)
    .join('\n');
  return [
    { role: 'system', content: systemPrompt(story.brief) + '\n\nIn questa fase pianifichi il romanzo. Rispondi SOLO con JSON valido.' },
    {
      role: 'user',
      content: `Story bible del romanzo:
"""
${head(story.bible, 24000)}
"""

Il romanzo ha ${nChapters} capitoli di circa ${wordsPerChapter} parole.
${done ? `Capitoli già pianificati:\n${done}\n` : ''}
Pianifica ora i capitoli da ${from + 1} a ${to}, coerenti con la story bible (in particolare con l'arco romantico, i conflitti personali e i colpi di scena previsti) e in continuità diretta con i capitoli precedenti.
Ogni capitolo deve avere una propria mini-struttura narrativa (apertura, sviluppo, svolta, chiusura che porta al successivo), alternare momenti condivisi e momenti in cui ciascun protagonista affronta da solo le proprie sfide, e far vivere anche i personaggi di supporto.
${to === nChapters ? "L'ultimo capitolo porta al finale previsto dalla story bible." : ''}

Rispondi con:
{
  "chapters": [
    { "title": "titolo del capitolo", "summary": "6-10 frasi concrete: punto di vista o focus, scene principali in ordine, eventi, sviluppo emotivo, sottotrame dei personaggi di supporto, cosa resta aperto alla fine" }
  ]
}`,
    },
  ];
}

/** Contesto di continuità: story bible + memoria dei capitoli già scritti. */
export function canonContext(story, index) {
  const memory = (story.memory || [])
    .slice(0, index)
    .map((m, i) => (m ? `### Capitolo ${i + 1}: ${story.chapters[i]?.title || ''}\n${m}` : ''))
    .filter(Boolean)
    .join('\n\n');
  return `STORY BIBLE (canon):
"""
${head(story.bible, 20000)}
"""
${memory ? `\nMEMORIA DEI CAPITOLI GIÀ SCRITTI (canon, in ordine):\n"""\n${head(memory, 30000)}\n"""\n` : ''}`;
}

function chapterFrame(story, index) {
  const ch = story.outline[index];
  const next = story.outline[index + 1];
  return `Capitolo da scrivere: ${index + 1} di ${story.outline.length}, "${ch.title}"
Contenuto previsto: ${ch.summary}
${next ? `(Il capitolo successivo, da NON anticipare: "${next.title}": ${next.summary})` : 'È l\'ultimo capitolo del romanzo.'}`;
}

export function scenePlanMessages(story, index, nScenes, wordsPerChapter, extra) {
  return [
    { role: 'system', content: systemPrompt(story.brief) + '\n\nIn questa fase pianifichi le scene di un capitolo. Rispondi SOLO con JSON valido.' },
    {
      role: 'user',
      content: `${canonContext(story, index)}
${chapterFrame(story, index)}
${extra ? `Indicazioni dell'autore per questo capitolo: ${extra}\n` : ''}
Pianifica il capitolo (circa ${wordsPerChapter} parole) in ${nScenes} momenti consecutivi che formino una mini-struttura narrativa completa: apertura, sviluppo, svolta, chiusura con un aggancio al capitolo successivo. È solo un piano di lavoro interno: il capitolo finale sarà un testo unico e fluido, senza divisioni visibili.
Il capitolo deve iniziare in continuità diretta con la fine del capitolo precedente.

Rispondi con:
{ "scenes": [ { "summary": "3-5 frasi: luogo e momento, personaggi presenti, cosa succede, cosa cambia emotivamente" } ] }`,
    },
  ];
}

export function sceneMessages(story, index, scenes, k, sceneWords, textSoFar, extra) {
  const prev = index > 0 ? story.chapters[index - 1]?.content || '' : '';
  const plan = scenes.map((sc, i) => `${i + 1}) ${sc}${i === k ? '   ← QUESTO È IL MOMENTO DA SCRIVERE ORA' : ''}`).join('\n');
  const isLastPart = k === scenes.length - 1;
  const isLastChapter = index === story.outline.length - 1;
  const context = textSoFar
    ? `Testo del capitolo scritto finora. Il tuo testo verrà attaccato subito dopo l'ultima frase, quindi riprendi da lì senza ripetere nulla:\n"""\n${tail(textSoFar, 7000)}\n"""`
    : prev
      ? `Fine del capitolo precedente (il nuovo capitolo riparte da qui):\n"""\n${tail(prev, 5000)}\n"""`
      : "È l'inizio del romanzo.";
  const ending = isLastPart
    ? isLastChapter
      ? 'È la parte finale del romanzo: chiudi la storia come previsto.'
      : 'È la parte finale del capitolo: chiudilo con un aggancio verso il successivo, senza concludere la storia.'
    : 'Non chiudere il capitolo: lascia la narrazione aperta verso il momento successivo.';
  return [
    { role: 'system', content: systemPrompt(story.brief) },
    {
      role: 'user',
      content: `${canonContext(story, index)}
${chapterFrame(story, index)}

Piano interno del capitolo (serve solo a te per orientarti: NON va mai scritto, citato o riassunto nel testo):
${plan}
${extra ? `\nIndicazioni dell'autore per questo capitolo: ${extra}\n` : ''}
${context}

Scrivi ora il momento ${k + 1} del piano, circa ${sceneWords} parole, come parte continua dello stesso capitolo di un libro stampato.
- Il lettore NON deve accorgersi della divisione: niente titoli, niente parole come "Scena", "Parte", "Momento", niente numeri, niente parentesi con descrizioni, niente riassunti del piano o anticipazioni.
- ${k > 0 ? 'Collegati alla frase precedente con una transizione narrativa naturale (un gesto, un cambio di luogo o di tempo raccontato nella prosa), così che il capitolo scorra fluido.' : 'Apri il capitolo direttamente con la narrazione.'}
- Rispetta lo stile richiesto dall'autore nella story bible: linguaggio semplice, naturale e diretto, ma molto dettagliato (espressioni, piccoli gesti, tono di voce, silenzi, esitazioni, linguaggio del corpo, ambiente, reazioni degli altri).
- Dialoghi realistici; emozioni mostrate attraverso azioni, parole e non detti, non spiegate dal narratore.
- Rispetta il canon e la memoria dei capitoli: nessuna contraddizione su età, aspetto, luoghi, date, eventi, cose che i personaggi sanno o non sanno.
- ${ending}
Rispondi solo con il testo narrativo.`,
    },
  ];
}

export function memoryMessages(story, index) {
  const ch = story.chapters[index];
  return [
    {
      role: 'system',
      content:
        "Sei l'editor di continuità di un romanzo. Annoti con precisione i fatti di ogni capitolo perché gli autori non commettano incongruenze. Scrivi in italiano, in modo asciutto e preciso.",
    },
    {
      role: 'user',
      content: `Story bible (per riferimento):
"""
${head(story.bible, 8000)}
"""

Capitolo ${index + 1} appena scritto, "${ch.title}":
"""
${ch.content}
"""

Scrivi la scheda di continuità di questo capitolo, massimo 300 parole, con queste sezioni in Markdown:
**Cosa succede:** eventi in ordine, con luogo, giorno o data se indicati.
**Nuovi fatti di canon:** nomi, età, dettagli fisici, luoghi, oggetti, abitudini introdotti.
**Chi sa cosa:** informazioni scoperte o tenute nascoste, da chi.
**Stato emotivo e delle relazioni:** a che punto sono i protagonisti, tra loro e ciascuno con se stesso.
**Questioni aperte:** promesse, segreti, conflitti e tensioni da riprendere.`,
    },
  ];
}

export function revisePlanMessages(story, instructions, recentChat) {
  const written = story.chapters.length;
  return [
    { role: 'system', content: systemPrompt(story.brief) + '\n\nIn questa fase sei un editor e aggiorni il progetto di un romanzo.' },
    {
      role: 'user',
      content: `Story bible attuale:
"""
${story.bible}
"""
${written ? `\nCapitoli già scritti: ${written}. Ciò che è già successo nei capitoli scritti NON può cambiare.\n` : ''}
${recentChat ? `Conversazione recente con l'autore sul progetto:\n"""\n${recentChat}\n"""\n` : ''}
Modifiche richieste dall'autore: ${instructions || 'applica le modifiche discusse nella conversazione recente.'}

Riscrivi la story bible COMPLETA con le modifiche applicate, mantenendo le stesse sezioni e tutto ciò che non va cambiato.
${PLAN_RULES}
Restituisci solo la nuova story bible in Markdown.`,
    },
  ];
}
