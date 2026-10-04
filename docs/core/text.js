// Utilità di testo condivise tra server (Node) e versione per telefono (browser).

export function countWords(text) {
  return (text || '').split(/\s+/).filter(Boolean).length;
}

export function storyWords(story) {
  return (story.chapters || []).reduce((n, c) => n + countWords(c.content), 0);
}

/** Estrae un oggetto JSON da una risposta del modello, tollerando ```json e testo extra. */
export function parseJsonLoose(text) {
  if (!text) return null;
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1];
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const candidate = t.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/** Testo della storia in Markdown o testo semplice. */
export function exportStory(story, format) {
  const parts = [];
  const many = story.chapters.length > 1;
  if (format === 'md') {
    parts.push(`# ${story.title}\n`);
    for (const ch of story.chapters) {
      if (many) parts.push(`## ${ch.title}\n`);
      parts.push(ch.content.trim() + '\n');
    }
  } else {
    parts.push(story.title.toUpperCase() + '\n');
    for (const ch of story.chapters) {
      if (many) parts.push(`\n${ch.title}\n${'-'.repeat(Math.min(ch.title.length, 60))}\n`);
      parts.push(ch.content.trim() + '\n');
    }
  }
  return parts.join('\n');
}

export function safeFileName(title) {
  return (title || 'storia').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 80) || 'storia';
}
