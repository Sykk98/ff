// Motore di scrittura condiviso tra server (Node) e versione per telefono (browser).
// Orchestrazione: richiesta -> scheda -> scaletta -> capitoli, più chat e riscritture.
// Le dipendenze esterne (client del modello e salvataggio) vengono passate a createEngine.
import { parseJsonLoose, countWords, storyWords } from './text.js';
import {
  wordsTarget,
  extractBriefMessages,
  outlineMessages,
  nextChapterPlanMessages,
  chapterMessages,
  continueChapterMessages,
  rewriteMessages,
  chatSystemPrompt,
} from './prompts.js';
import {
  bibleMessages,
  outlineBatchMessages,
  scenePlanMessages,
  sceneMessages,
  memoryMessages,
  revisePlanMessages,
} from './novel-prompts.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const abortError = () => Object.assign(new Error('Interrotto'), { name: 'AbortError' });

/** Filtra i blocchi <think>…</think> che alcuni modelli locali emettono nello stream. */
function makeThinkFilter() {
  let inThink = false;
  let pending = '';
  return (chunk) => {
    pending += chunk;
    let out = '';
    while (pending) {
      if (inThink) {
        const end = pending.indexOf('</think>');
        if (end === -1) {
          pending = pending.slice(-8);
          return out;
        }
        pending = pending.slice(end + 8);
        inThink = false;
      } else {
        const start = pending.indexOf('<think>');
        if (start === -1) {
          // trattieni un possibile inizio di tag spezzato
          const lt = pending.lastIndexOf('<');
          if (lt !== -1 && pending.length - lt < 7 && '<think>'.startsWith(pending.slice(lt))) {
            out += pending.slice(0, lt);
            pending = pending.slice(lt);
          } else {
            out += pending;
            pending = '';
          }
          return out;
        }
        out += pending.slice(0, start);
        pending = pending.slice(start + 7);
        inThink = true;
      }
    }
    return out;
  };
}

/** Pulizia per documenti (story bible): toglie solo i blocchi di ragionamento e i recinti ```. */
function cleanDocument(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*```(?:markdown|md)?\s*\n?|\n?\s*```\s*$/g, '')
    .trim();
}

const ORDINALS =
  'uno|una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|prima|primo|seconda|secondo|terza|terzo|quarta|quarto|quinta|quinto|sesta|sesto|finale|iniziale|one|two|three|four|five|six|first|second|third|final|[ivx]+|\\d+';
const LABEL_LINE = new RegExp(`^[ \\t>*_#(\\[]*(?:scena|parte|momento|scene|part)\\s+(?:${ORDINALS})\\b[^\\n]{0,160}$`, 'gim');

/** Toglie titoli interni ed etichette come "Scena uno (…)" che a volte il modello aggiunge. */
export function stripSceneLabels(text) {
  return text
    .replace(LABEL_LINE, '')
    .replace(/^[ \t]*#{1,6}[ \t]+[^\n]*$/gm, '') // nessun titolo dentro un capitolo
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanChapterText(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*#{1,6}\s+.*\n+/, '') // titolo iniziale ripetuto dal modello
    .replace(/^\s*(capitolo|chapter)\s+\d+[^\n]*\n+/i, '')
    .trim();
}

/** Numero di capitoli e parole per capitolo: prima le indicazioni dell'autore, poi le impostazioni. */
function chapterPlan(story, settings) {
  const b = story.brief || {};
  const askedChapters = Number(b.chapterCount) > 0 ? clamp(Math.round(Number(b.chapterCount)), 1, 80) : 0;
  const askedWords = Number(b.wordsPerChapter) > 0 ? clamp(Math.round(Number(b.wordsPerChapter)), 300, 10000) : 0;
  if (askedChapters) {
    return { n: askedChapters, perChapter: askedWords || Math.round(wordsTarget(b) / askedChapters) };
  }
  const target = wordsTarget(b);
  const wpc = askedWords || Math.max(500, Number(settings.wordsPerChapter) || 2000);
  const n = Math.max(1, Math.round(target / wpc));
  return { n, perChapter: askedWords || Math.round(target / n) };
}

/** "plan" = prima il progetto, poi un capitolo alla volta; "all" = scrive tutto subito. */
function resolveMode(story, settings, planFirst = false) {
  const flow = story.brief?.flow || 'auto';
  if (flow === 'plan' || flow === 'all') return flow;
  const { n, perChapter } = chapterPlan(story, settings);
  return planFirst || n * perChapter > 15000 || n >= 6 ? 'plan' : 'all';
}

function tokensFor(words, settings) {
  const est = Math.ceil(words * 2.2) + 400;
  const cap = Number(settings.maxTokens) || 0;
  return cap > 0 ? Math.min(cap, est) : est;
}

/**
 * Crea il motore.
 * @param {object} deps
 * @param {(settings, messages, opts) => AsyncIterable<{text?: string, finishReason?: string}>} deps.streamChat
 * @param {(story) => Promise<any>} deps.saveStory
 */
export function createEngine({ streamChat, saveStory }) {
  async function complete(settings, messages, opts = {}) {
    let text = '';
    let finishReason = null;
    const { emit, ...rest } = opts;
    for await (const part of streamChat(settings, messages, { onWait: waitNotice(emit), ...rest })) {
      if (part.text) text += part.text;
      if (part.finishReason !== undefined) finishReason = part.finishReason;
    }
    return { text, finishReason };
  }

const waitNotice = (emit) => (seconds) =>
  emit?.({ type: 'status', message: `Il servizio AI ha raggiunto il limite di richieste del piano gratuito: riprovo tra ${seconds} secondi…` });

async function streamInto(settings, messages, opts, emit, signal) {
  const filter = makeThinkFilter();
  let text = '';
  let finishReason = null;
  for await (const part of streamChat(settings, messages, { onWait: waitNotice(emit), ...opts, signal })) {
    if (part.text) {
      const visible = filter(part.text);
      if (visible) {
        text += visible;
        emit({ type: 'delta', text: visible });
      }
    }
    if (part.finishReason !== undefined) finishReason = part.finishReason;
  }
  return { text, finishReason };
}

/** Scrive un capitolo in un'unica richiesta, con fino a 2 continuazioni se è troppo corto o troncato. */
async function writeShortChapter(story, index, perChapter, settings, emit, signal, extra) {
  const base = chapterMessages(story, index, perChapter, extra);

  let { text, finishReason } = await streamInto(settings, base, { maxTokens: tokensFor(perChapter, settings) }, emit, signal);

  for (let pass = 0; pass < 2; pass++) {
    const words = countWords(text);
    const tooShort = words < perChapter * 0.6;
    if (!(finishReason === 'length' || tooShort) || words === 0) break;
    const remaining = Math.max(300, perChapter - words);
    const sep = /[\s]$/.test(text) ? '' : ' ';
    emit({ type: 'delta', text: sep });
    text += sep;
    const more = await streamInto(
      settings,
      continueChapterMessages(base, text, remaining),
      { maxTokens: tokensFor(remaining, settings) },
      emit,
      signal,
    );
    text += more.text;
    finishReason = more.finishReason;
    if (countWords(more.text) < 50) break;
  }

  return stripSceneLabels(cleanChapterText(text));
}

/** Capitolo lungo: prima la scaletta delle scene, poi ogni scena in sequenza. */
async function writeLongChapter(story, index, perChapter, settings, emit, signal, extra) {
  const nScenes = clamp(Math.round(perChapter / 1300), 2, 6);
  const total = story.outline.length;
  emit({ type: 'status', message: `Capitolo ${index + 1} di ${total}: preparo la struttura…` });
  let scenes = [];
  for (let attempt = 0; attempt < 2 && scenes.length < 2; attempt++) {
    const { text } = await complete(settings, scenePlanMessages(story, index, nScenes, perChapter, extra), {
      temperature: 0.7,
      maxTokens: 1500,
      signal,
      emit,
    });
    const data = parseJsonLoose(text);
    scenes = (Array.isArray(data?.scenes) ? data.scenes : [])
      .map((x) => String(x?.summary || x || '').replace(/^\s*(?:scena|parte|momento)\s+\S+\s*[:.\-–—]\s*/i, '').trim())
      .filter(Boolean);
  }
  if (scenes.length < 2) {
    // ripiego: divide il riassunto del capitolo in parti
    scenes = Array.from({ length: nScenes }, (_, i) => `${i + 1}/${nScenes} di: ${story.outline[index].summary}`);
  }
  const sceneWords = Math.round(perChapter / scenes.length);
  let text = '';
  for (let k = 0; k < scenes.length; k++) {
    if (signal?.aborted) throw abortError();
    emit({ type: 'status', message: `Scrivo il capitolo ${index + 1} di ${total}… ${Math.round((k / scenes.length) * 100)}%` });
    if (text) {
      emit({ type: 'delta', text: '\n\n' });
      text += '\n\n';
    }
    const part = await streamInto(
      settings,
      sceneMessages(story, index, scenes, k, sceneWords, text, extra),
      { maxTokens: tokensFor(sceneWords * 1.3, settings) },
      emit,
      signal,
    );
    text += stripSceneLabels(cleanChapterText(part.text));
  }
  return stripSceneLabels(text);
}

/** Scrive un capitolo, lo salva e, nella modalità romanzo, aggiorna la memoria di continuità. */
async function writeChapter(story, index, perChapter, settings, emit, signal, extra) {
  emit({ type: 'chapter_start', index, title: story.outline[index].title, total: story.outline.length });
  const long = story.mode === 'plan' && story.bible && perChapter > 2600;
  const content = long
    ? await writeLongChapter(story, index, perChapter, settings, emit, signal, extra)
    : await writeShortChapter(story, index, perChapter, settings, emit, signal, extra);
  if (!content) throw new Error('Il modello ha restituito un testo vuoto. Prova un altro modello o controlla le impostazioni.');
  story.chapters[index] = { title: story.outline[index].title, content };
  await saveStory(story);
  emit({ type: 'chapter_end', index, words: countWords(content) });
  if (story.mode === 'plan') await updateMemory(story, index, settings, emit, signal);
}

/** Scheda di continuità del capitolo: fatti, chi sa cosa, stato emotivo, questioni aperte. */
async function updateMemory(story, index, settings, emit, signal) {
  emit({ type: 'status', message: `Aggiorno la memoria della storia (capitolo ${index + 1})…` });
  try {
    const { text } = await complete(settings, memoryMessages(story, index), { temperature: 0.2, maxTokens: 900, signal, emit });
    const note = cleanChapterText(text);
    if (!note) return;
    story.memory = story.memory || [];
    story.memory[index] = note;
    await saveStory(story);
  } catch (err) {
    if (err.name === 'AbortError' || signal?.aborted) throw err;
    // la memoria è utile ma non indispensabile: il capitolo resta salvato
    emit({ type: 'status', message: `Memoria del capitolo ${index + 1} non aggiornata: ${err.message}` });
  }
}

async function ensureBrief(story, settings, emit, signal) {
  const b = story.brief;
  if (!b.freeText || b.extracted) return;
  emit({ type: 'status', message: 'Analizzo la tua richiesta…' });
  const { text } = await complete(settings, extractBriefMessages(b.freeText), { temperature: 0.3, maxTokens: 2000, signal, emit });
  const data = parseJsonLoose(text) || {};
  for (const key of ['title', 'fandom', 'genre', 'setting', 'plot', 'characters', 'style', 'notes']) {
    if (!b[key] && typeof data[key] === 'string' && data[key].trim()) b[key] = data[key].trim();
  }
  for (const key of ['pov', 'tense']) {
    if (!b[key] && typeof data[key] === 'string' && data[key].trim()) b[key] = data[key].trim();
  }
  // La lunghezza indicata nel testo vince solo se l'autore non ha scelto un'opzione esplicita.
  const tw = Number(data.targetWords);
  if (!b.lengthLocked && Number.isFinite(tw) && tw > 0) b.targetWords = tw;
  if (!b.lengthLocked) {
    const cc = Number(data.chapterCount);
    const wpc = Number(data.wordsPerChapter);
    if (Number.isFinite(cc) && cc > 0) b.chapterCount = clamp(Math.round(cc), 1, 80);
    if (Number.isFinite(wpc) && wpc > 0) b.wordsPerChapter = clamp(Math.round(wpc), 300, 10000);
  }
  if (!b.plot) b.plot = b.freeText;
  b.extracted = true;
  story.mode = resolveMode(story, settings, data.planFirst === true);
  if (b.title && (!story.title || story.title === 'Nuova storia')) story.title = b.title;
  await saveStory(story);
  emit({ type: 'brief', brief: b, title: story.title });
}

async function ensureOutline(story, settings, emit, signal) {
  if (story.outline.length) return;
  const { n, perChapter } = chapterPlan(story, settings);
  emit({ type: 'status', message: n > 1 ? `Preparo la scaletta (${n} capitoli)…` : 'Preparo la scaletta…' });

  let data = null;
  for (let attempt = 0; attempt < 2 && !data?.chapters?.length; attempt++) {
    const { text } = await complete(settings, outlineMessages(story.brief, n, perChapter), {
      temperature: 0.8,
      maxTokens: Math.min(Number(settings.maxTokens) || 8000, 400 + n * 250) || undefined,
      signal,
      emit,
    });
    data = parseJsonLoose(text);
  }

  let chapters = Array.isArray(data?.chapters) ? data.chapters : [];
  chapters = chapters
    .map((c, i) => ({
      title: String(c?.title || `Capitolo ${i + 1}`).trim(),
      summary: String(c?.summary || '').trim(),
    }))
    .slice(0, n);
  while (chapters.length < n) {
    const i = chapters.length;
    chapters.push({
      title: n === 1 ? story.title : `Capitolo ${i + 1}`,
      summary: i === 0 ? story.brief.plot || story.brief.freeText || '' : 'Prosegui la storia in modo coerente con la trama.',
    });
  }
  story.outline = chapters;
  if (data?.title && (!story.title || story.title === 'Nuova storia')) story.title = String(data.title);
  await saveStory(story);
  emit({ type: 'outline', outline: story.outline, title: story.title });
}

/** Stream con continuazioni automatiche se la risposta viene troncata per lunghezza. */
async function streamLong(settings, messages, opts, emit, signal, maxPasses = 2) {
  let { text, finishReason } = await streamInto(settings, messages, opts, emit, signal);
  for (let pass = 0; pass < maxPasses && finishReason === 'length'; pass++) {
    const more = await streamInto(
      settings,
      [
        ...messages,
        { role: 'assistant', content: text },
        { role: 'user', content: 'Continua esattamente da dove ti sei interrotto, senza ripetere nulla e senza commenti.' },
      ],
      opts,
      emit,
      signal,
    );
    text += more.text;
    finishReason = more.finishReason;
  }
  return text;
}

/** Modalità romanzo: story bible e scaletta completa, senza scrivere capitoli. */
async function planStory(story, settings, emit, signal) {
  const { n, perChapter } = chapterPlan(story, settings);
  story.planComplete = false;
  if (!story.bible) {
    emit({ type: 'phase', message: 'Scrivo la story bible del romanzo…' });
    const text = await streamLong(settings, bibleMessages(story, n, perChapter), { temperature: 0.8 }, emit, signal);
    story.bible = cleanDocument(text);
    if (!story.bible) throw new Error('Il modello non ha restituito la story bible. Riprova.');
    const title = story.bible.match(/^#\s*Story bible:\s*(.+)$/im)?.[1]?.trim();
    if (title && (!story.title || story.title === 'Nuova storia' || story.title === story.brief.title)) story.title = title.replace(/[*_]/g, '');
    await saveStory(story);
    emit({ type: 'bible', bible: story.bible, title: story.title });
  }
  const BATCH = 8;
  for (let from = story.outline.length; from < n; from += BATCH) {
    if (signal?.aborted) throw abortError();
    const to = Math.min(n, from + BATCH);
    emit({ type: 'phase', message: `Preparo la scaletta: capitoli ${from + 1}–${to} di ${n}…` });
    let chapters = [];
    for (let attempt = 0; attempt < 2 && !chapters.length; attempt++) {
      const { text } = await complete(settings, outlineBatchMessages(story, from, to, n, perChapter), {
        temperature: 0.8,
        maxTokens: Math.min(Number(settings.maxTokens) || 8000, 800 + (to - from) * 400),
        signal,
      emit,
      });
      const data = parseJsonLoose(text);
      chapters = Array.isArray(data?.chapters) ? data.chapters : [];
    }
    for (let i = from; i < to; i++) {
      const c = chapters[i - from];
      story.outline[i] = {
        title: String(c?.title || `Capitolo ${i + 1}`).trim(),
        summary: String(c?.summary || 'Da definire: prosegui la storia secondo la story bible.').trim(),
      };
    }
    await saveStory(story);
    emit({ type: 'outline', outline: story.outline, title: story.title });
  }
  story.planComplete = true;
  await saveStory(story);
}

/** Aggiorna il progetto (story bible e capitoli non ancora scritti) con le modifiche dell'autore. */
async function revisePlan(story, instructions, settings, emit, signal) {
  if (!story.bible) throw Object.assign(new Error('Questa storia non ha ancora un progetto da modificare.'), { status: 400 });
  const recentChat = story.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.kind !== 'generation')
    .slice(-10)
    .map((m) => `${m.role === 'user' ? 'Autore' : 'Assistente'}: ${m.content}`)
    .join('\n\n')
    .slice(-12000);
  emit({ type: 'phase', message: 'Aggiorno la story bible…' });
  const text = await streamLong(settings, revisePlanMessages(story, instructions, recentChat), { temperature: 0.7 }, emit, signal);
  const bible = cleanDocument(text);
  if (!bible) throw new Error('Il modello non ha restituito la nuova story bible. Riprova.');
  story.previousBible = story.bible;
  story.bible = bible;
  // i capitoli già scritti restano; quelli futuri vengono ripianificati sulla nuova bible
  story.outline = story.outline.slice(0, story.chapters.length);
  await saveStory(story);
  emit({ type: 'bible', bible: story.bible, title: story.title });
  await planStory(story, settings, emit, signal);
}

/** Generazione: nella modalità romanzo prepara il progetto, altrimenti scrive tutta la storia. */
async function generateStory(story, settings, emit, signal) {
  await ensureBrief(story, settings, emit, signal);
  story.mode = story.mode || resolveMode(story, settings);
  if (story.mode === 'plan') return planStory(story, settings, emit, signal);
  await ensureOutline(story, settings, emit, signal);
  const { perChapter } = chapterPlan(story, settings);
  const wpc = story.outline.length === 1 ? wordsTarget(story.brief) : perChapter;
  for (let i = story.chapters.length; i < story.outline.length; i++) {
    if (signal?.aborted) throw abortError();
    await writeChapter(story, i, wpc, settings, emit, signal);
  }
}

/** Aggiunge un nuovo capitolo oltre la scaletta. */
async function continueStory(story, settings, direction, emit, signal) {
  // Se la scaletta non è ancora finita, scrivi il prossimo capitolo previsto.
  if (story.chapters.length < story.outline.length) {
    const { perChapter } = chapterPlan(story, settings);
    return writeChapter(story, story.chapters.length, perChapter, settings, emit, signal, direction);
  }
  emit({ type: 'status', message: 'Pianifico il prossimo capitolo…' });
  const { text } = await complete(settings, nextChapterPlanMessages(story, direction), { temperature: 0.8, maxTokens: 800, signal, emit });
  const data = parseJsonLoose(text) || {};
  story.outline.push({
    title: String(data.title || `Capitolo ${story.outline.length + 1}`),
    summary: String(data.summary || direction || 'Prosegui la storia in modo coerente.'),
  });
  await saveStory(story);
  emit({ type: 'outline', outline: story.outline, title: story.title });
  return writeChapter(story, story.outline.length - 1, chapterPlan(story, settings).perChapter, settings, emit, signal, direction);
}

/** Riscrive un capitolo esistente secondo le indicazioni dell'autore. */
async function rewriteChapter(story, index, instructions, settings, emit, signal) {
  const ch = story.chapters[index];
  if (!ch) throw Object.assign(new Error('Capitolo inesistente'), { status: 404 });
  const words = Math.max(countWords(ch.content), 300);
  emit({ type: 'chapter_start', index, title: ch.title, total: story.chapters.length, rewrite: true });
  const text = await streamLong(
    settings,
    rewriteMessages(story, index, instructions, words),
    { maxTokens: tokensFor(words * 1.3, settings) },
    emit,
    signal,
    3,
  );
  const content = stripSceneLabels(cleanChapterText(text));
  if (!content) throw new Error('Il modello ha restituito un testo vuoto.');
  story.chapters[index] = { ...ch, content, previous: ch.content };
  await saveStory(story);
  emit({ type: 'chapter_end', index, words: countWords(content) });
  if (story.mode === 'plan') await updateMemory(story, index, settings, emit, signal);
}


  // ---------- azioni complete (con la cronologia dei messaggi della chat) ----------

  const now = () => new Date().toISOString();

  async function actionGenerate(story, body, settings, emit, signal) {
    if (body.userMessage) story.messages.push({ role: 'user', content: String(body.userMessage), at: now() });
    await saveStory(story);
    const before = story.chapters.length;
    const hadPlan = Boolean(story.bible) && story.outline.length > 0;
    try {
      await generateStory(story, settings, emit, signal);
      if (story.mode === 'plan' && !hadPlan) {
        const { n, perChapter } = chapterPlan(story, settings);
        story.messages.push({
          role: 'assistant',
          kind: 'generation',
          content:
            `Ho preparato il progetto di «${story.title}»: la story bible e la scaletta di ${n} capitoli da circa ${perChapter} parole. ` +
            'Li trovi nella scheda Storia. Leggili con calma: se vuoi cambiare qualcosa, scrivimelo qui e poi premi «Modifica il progetto». ' +
            'Quando vuoi iniziare, premi «Scrivi il capitolo 1».',
          at: now(),
        });
        await saveStory(story);
      }
    } finally {
      const written = story.chapters.length - before;
      if (written > 0) {
        const words = storyWords(story);
        const n = story.chapters.length;
        const finished = n >= story.outline.length;
        story.messages.push({
          role: 'assistant',
          kind: 'generation',
          content: finished
            ? `Ho scritto «${story.title}»: ${n} ${n === 1 ? 'capitolo' : 'capitoli'}, circa ${words} parole. La trovi nella scheda Storia. Puoi chiedermi modifiche, scene aggiuntive o di continuarla.`
            : `Generazione interrotta dopo ${n} di ${story.outline.length} capitoli (${words} parole). Premi «Riprendi» per completarla.`,
          at: now(),
        });
        await saveStory(story);
      }
    }
  }

  async function actionContinue(story, body, settings, emit, signal) {
    const direction = String(body.direction || '').trim();
    if (direction) story.messages.push({ role: 'user', content: `Continua la storia: ${direction}`, at: now() });
    await continueStory(story, settings, direction, emit, signal);
    const ch = story.chapters.at(-1);
    story.messages.push({
      role: 'assistant',
      kind: 'generation',
      content: `Ho aggiunto il capitolo ${story.chapters.length}, «${ch.title}» (${countWords(ch.content)} parole).`,
      at: now(),
    });
    await saveStory(story);
  }

  async function actionRewrite(story, body, settings, emit, signal) {
    const index = Number(body.index);
    const instructions = String(body.instructions || '').trim();
    await rewriteChapter(story, index, instructions, settings, emit, signal);
    story.messages.push({
      role: 'assistant',
      kind: 'generation',
      content: `Ho riscritto il capitolo ${index + 1}, «${story.chapters[index].title}»${instructions ? ` (${instructions})` : ''}.`,
      at: now(),
    });
    await saveStory(story);
  }

  async function actionRevise(story, body, settings, emit, signal) {
    const instructions = String(body.instructions || '').trim();
    if (instructions) story.messages.push({ role: 'user', content: `Modifica il progetto: ${instructions}`, at: now() });
    await revisePlan(story, instructions, settings, emit, signal);
    story.messages.push({
      role: 'assistant',
      kind: 'generation',
      content: `Ho aggiornato la story bible e la scaletta dei capitoli ancora da scrivere (${story.outline.length - story.chapters.length}). Le trovi nella scheda Storia.`,
      at: now(),
    });
    await saveStory(story);
  }

  async function actionChat(story, body, settings, emit, signal) {
    const message = String(body.message || '').trim();
    if (!message) throw Object.assign(new Error('Messaggio vuoto'), { status: 400 });
    story.messages.push({ role: 'user', content: message, at: now() });
    await saveStory(story);
    const history = story.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));
    const messages = [{ role: 'system', content: chatSystemPrompt(story) }, ...history];
    let text = '';
    const collect = (ev) => {
      if (ev.type === 'delta') text += ev.text;
      emit(ev);
    };
    try {
      await streamInto(settings, messages, {}, collect, signal);
    } finally {
      // salva anche le risposte parziali (es. se l'utente interrompe)
      if (text.trim()) {
        story.messages.push({ role: 'assistant', content: text.trim(), at: now() });
        await saveStory(story);
      }
    }
  }

  return {
    complete,
    streamInto,
    generateStory,
    continueStory,
    rewriteChapter,
    revisePlan,
    actions: { generate: actionGenerate, continue: actionContinue, rewrite: actionRewrite, revise: actionRevise, chat: actionChat },
  };
}
