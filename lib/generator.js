// Orchestrazione della generazione: scheda -> scaletta -> capitoli.
import { streamChat, complete, parseJsonLoose } from './llm.js';
import {
  wordsTarget,
  extractBriefMessages,
  outlineMessages,
  nextChapterPlanMessages,
  chapterMessages,
  continueChapterMessages,
  rewriteMessages,
} from './prompts.js';
import { saveStory, countWords } from './store.js';

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

function cleanChapterText(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*#{1,6}\s+.*\n+/, '') // titolo iniziale ripetuto dal modello
    .replace(/^\s*(capitolo|chapter)\s+\d+[^\n]*\n+/i, '')
    .trim();
}

function chapterPlan(story, settings) {
  const target = wordsTarget(story.brief);
  const wpc = Math.max(500, Number(settings.wordsPerChapter) || 2000);
  const n = Math.max(1, Math.round(target / wpc));
  return { n, perChapter: Math.round(target / n) };
}

async function streamInto(settings, messages, opts, emit, signal) {
  const filter = makeThinkFilter();
  let text = '';
  let finishReason = null;
  for await (const part of streamChat(settings, messages, { ...opts, signal })) {
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

function tokensFor(words, settings) {
  const est = Math.ceil(words * 2.2) + 400;
  const cap = Number(settings.maxTokens) || 0;
  return cap > 0 ? Math.min(cap, est) : est;
}

/** Scrive un capitolo in streaming, con fino a 2 continuazioni se è troppo corto o troncato. */
async function writeChapter(story, index, perChapter, settings, emit, signal, extra) {
  const base = chapterMessages(story, index, perChapter, extra);
  emit({ type: 'chapter_start', index, title: story.outline[index].title, total: story.outline.length });

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

  const content = cleanChapterText(text);
  if (!content) throw new Error('Il modello ha restituito un testo vuoto. Prova un altro modello o controlla le impostazioni.');
  story.chapters[index] = { title: story.outline[index].title, content };
  await saveStory(story);
  emit({ type: 'chapter_end', index, words: countWords(content) });
}

async function ensureBrief(story, settings, emit, signal) {
  const b = story.brief;
  if (!b.freeText || b.extracted) return;
  emit({ type: 'status', message: 'Analizzo la tua richiesta…' });
  const { text } = await complete(settings, extractBriefMessages(b.freeText), { temperature: 0.3, maxTokens: 2000, signal });
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
  if (!b.plot) b.plot = b.freeText;
  b.extracted = true;
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

/** Generazione completa: dalla richiesta fino all'ultimo capitolo previsto. */
export async function generateStory(story, settings, emit, signal) {
  await ensureBrief(story, settings, emit, signal);
  await ensureOutline(story, settings, emit, signal);
  const { perChapter } = chapterPlan(story, settings);
  const wpc = story.outline.length === 1 ? wordsTarget(story.brief) : perChapter;
  for (let i = story.chapters.length; i < story.outline.length; i++) {
    if (signal?.aborted) throw Object.assign(new Error('Interrotto'), { name: 'AbortError' });
    await writeChapter(story, i, wpc, settings, emit, signal);
  }
}

/** Aggiunge un nuovo capitolo oltre la scaletta. */
export async function continueStory(story, settings, direction, emit, signal) {
  // Se la scaletta non è ancora finita, scrivi il prossimo capitolo previsto.
  if (story.chapters.length < story.outline.length) {
    const { perChapter } = chapterPlan(story, settings);
    return writeChapter(story, story.chapters.length, perChapter, settings, emit, signal, direction);
  }
  emit({ type: 'status', message: 'Pianifico il prossimo capitolo…' });
  const { text } = await complete(settings, nextChapterPlanMessages(story, direction), { temperature: 0.8, maxTokens: 800, signal });
  const data = parseJsonLoose(text) || {};
  story.outline.push({
    title: String(data.title || `Capitolo ${story.outline.length + 1}`),
    summary: String(data.summary || direction || 'Prosegui la storia in modo coerente.'),
  });
  await saveStory(story);
  emit({ type: 'outline', outline: story.outline, title: story.title });
  const wpc = Math.max(500, Number(settings.wordsPerChapter) || 2000);
  return writeChapter(story, story.outline.length - 1, wpc, settings, emit, signal, direction);
}

/** Riscrive un capitolo esistente secondo le indicazioni dell'autore. */
export async function rewriteChapter(story, index, instructions, settings, emit, signal) {
  const ch = story.chapters[index];
  if (!ch) throw Object.assign(new Error('Capitolo inesistente'), { status: 404 });
  const words = Math.max(countWords(ch.content), 300);
  emit({ type: 'chapter_start', index, title: ch.title, total: story.chapters.length, rewrite: true });
  const { text } = await streamInto(
    settings,
    rewriteMessages(story, index, instructions, words),
    { maxTokens: tokensFor(words * 1.3, settings) },
    emit,
    signal,
  );
  const content = cleanChapterText(text);
  if (!content) throw new Error('Il modello ha restituito un testo vuoto.');
  story.chapters[index] = { ...ch, content, previous: ch.content };
  await saveStory(story);
  emit({ type: 'chapter_end', index, words: countWords(content) });
}

export { streamInto };
