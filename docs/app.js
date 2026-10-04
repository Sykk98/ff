// Fanfic Studio — interfaccia client (vanilla JS, nessuna dipendenza).
// Funziona in due modi:
// - con il server Node (computer): le richieste /api/... vanno al server;
// - senza server (telefono, GitHub Pages): le stesse richieste sono gestite da local-backend.js nel browser.
import { exportStory, safeFileName } from './core/text.js';

export const APP_VERSION = '2026-10-04.5';

// Nessun errore deve passare in silenzio: mostralo all'utente.
window.addEventListener('error', (e) => toastError(e.message));
window.addEventListener('unhandledrejection', (e) => toastError(e.reason?.message || String(e.reason)));
function toastError(msg) {
  if (!msg || /ResizeObserver/.test(msg)) return;
  try {
    toast('⚠️ Errore: ' + msg, 8000);
  } catch {}
}

// localStorage può essere bloccato (navigazione privata, impostazioni del browser).
const local = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  remove: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  settings: null,
  stories: [],
  story: null, // storia aperta (null = nuova storia non ancora creata)
  busy: false,
  controller: null,
  tab: 'chat',
  editing: null, // indice del capitolo in modifica
};

// ---------- utilità ----------

let backend = null; // null = server Node; altrimenti backend locale nel browser

async function detectBackend() {
  // Su GitHub Pages e Cloudflare non c'è mai il server Node: evita una richiesta inutile.
  const staticHost = /\.(github\.io|pages\.dev|workers\.dev)$/.test(location.hostname) || !location.protocol.startsWith('http');
  if (!staticHost) {
    try {
      const r = await fetch('/api/settings', { cache: 'no-store' });
      if (r.ok && (r.headers.get('content-type') || '').includes('json')) return;
    } catch {}
  }
  const mod = await import('./local-backend.js');
  backend = mod.createLocalBackend();
  document.body.classList.add('local-mode');
}

async function api(path, opts = {}) {
  if (backend) return backend.api(path, opts);
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
  return data;
}

/** POST con risposta NDJSON in streaming. */
async function streamApi(path, body, onEvent, signal) {
  if (backend) return backend.streamApi(path, body, onEvent, signal);
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Errore ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inlineMd(s) {
  return escapeHtml(s)
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|\W)_(?!\s)(.+?)_(?=\W|$)/g, '$1<em>$2</em>');
}

/** Markdown essenziale. Con lists:true riconosce anche gli elenchi (story bible, memoria):
 *  nei capitoli no, perché i dialoghi possono iniziare con un trattino. */
function renderMd(text, { lists = false } = {}) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let html = '';
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) html += `<p>${para.map(inlineMd).join('<br>')}</p>`;
    para = [];
  };
  const flushList = () => {
    if (list) html += `<ul>${list.map((li) => `<li>${inlineMd(li)}</li>`).join('')}</ul>`;
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const lv = Math.min(h[1].length + 1, 6);
      html += `<h${lv}>${inlineMd(h[2])}</h${lv}>`;
      continue;
    }
    if (/^\s*(\*\s*){3,}$|^\s*-{3,}\s*$/.test(line)) {
      flushPara();
      flushList();
      html += '<p style="text-align:center">⁂</p>';
      continue;
    }
    const li = lists && (line.match(/^\s*[-*•]\s+(.*)$/) || line.match(/^\s*\d+[.)]\s+(.*)$/));
    if (li) {
      flushPara();
      (list ||= []).push(li[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return html;
}

const countWords = (t) => (t || '').split(/\s+/).filter(Boolean).length;
const fmt = (n) => n.toLocaleString('it-IT');

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function askText(title, text, value = '') {
  return new Promise((resolve) => {
    const d = $('#promptDialog');
    $('#promptTitle').textContent = title;
    $('#promptText').textContent = text;
    $('#promptInput').value = value;
    d.returnValue = '';
    d.showModal();
    $('#promptInput').focus();
    d.addEventListener('close', function onClose() {
      d.removeEventListener('close', onClose);
      resolve(d.returnValue === 'ok' ? $('#promptInput').value : null);
    });
  });
}

// ---------- opzioni della storia ----------

function readOptions() {
  const len = $('#optLength').value;
  const o = {
    pov: $('#optPov').value,
    tense: $('#optTense').value,
    language: $('#optLang').value,
    explicitLevel: $('#optExplicit').value,
    darkThemes: $('#optDark').checked,
    style: $('#optStyle').value.trim(),
    flow: $('#optFlow').value,
    lengthPreset: '',
    lengthLocked: true,
  };
  // "come scritto nella richiesta": non azzera la lunghezza già ricavata dal testo
  if (len === 'custom') o.targetWords = Number($('#optWords').value) || 3000;
  else if (len === 'auto') o.lengthLocked = false;
  else {
    o.lengthPreset = len;
    o.targetWords = 0;
  }
  return o;
}

function applyOptions(b = {}) {
  let len = 'auto';
  if (b.lengthPreset) len = b.lengthPreset;
  else if (Number(b.targetWords) > 0 && b.lengthLocked === true) len = 'custom';
  $('#optLength').value = len;
  $('#optFlow').value = ['plan', 'all'].includes(b.flow) ? b.flow : 'auto';
  $('#optWords').value = Number(b.targetWords) > 0 ? b.targetWords : 3000;
  $('#optPov').value = b.pov && ['prima', 'seconda', 'terza', 'onnisciente'].includes(b.pov) ? b.pov : '';
  $('#optTense').value = ['passato', 'presente'].includes(b.tense) ? b.tense : '';
  $('#optLang').value = b.language || 'italiano';
  $('#optExplicit').value = b.explicitLevel || 'explicit';
  $('#optDark').checked = b.darkThemes !== false;
  $('#optStyle').value = b.style || '';
  updateOptionsSummary();
}

function updateOptionsSummary() {
  $('#customWordsWrap').hidden = $('#optLength').value !== 'custom';
  const lenText = $('#optLength').selectedOptions[0].textContent.replace(/\s*\(.*\)/, '');
  const bits = [$('#optLength').value === 'auto' ? 'lunghezza dalla richiesta' : lenText];
  if ($('#optFlow').value === 'plan') bits.push('prima il progetto');
  if ($('#optFlow').value === 'all') bits.push('tutto subito');
  if ($('#optDark').checked) bits.push('dark');
  bits.push({ explicit: 'esplicito', fade: 'dissolvenza', none: 'no sesso' }[$('#optExplicit').value]);
  if ($('#optLang').value !== 'italiano') bits.push($('#optLang').selectedOptions[0].textContent);
  $('#optSummary').textContent = '· ' + bits.join(' · ');
}

let saveOptionsTimer;
function onOptionsChange() {
  updateOptionsSummary();
  if (!state.story) return;
  clearTimeout(saveOptionsTimer);
  saveOptionsTimer = setTimeout(async () => {
    try {
      const o = readOptions();
      // non modificare la lunghezza di una storia già pianificata se l'utente sceglie "dal testo"
      state.story = await api(`/api/stories/${state.story.id}`, { method: 'PUT', body: { brief: o } });
    } catch (e) {
      toast(e.message);
    }
  }, 400);
}

// ---------- sidebar ----------

async function loadStories() {
  state.stories = await api('/api/stories');
  renderSidebar();
}

function renderSidebar() {
  const list = $('#storyList');
  if (!state.stories.length) {
    list.innerHTML = '<div class="muted" style="padding:8px 4px">Ancora nessuna storia.</div>';
    return;
  }
  list.innerHTML = state.stories
    .map(
      (s) => `<div class="story-item ${state.story?.id === s.id ? 'active' : ''}" data-id="${s.id}">
        <div class="t">${escapeHtml(s.title)}</div>
        <div class="m">${s.chapters} cap. · ${fmt(s.words)} parole${state.busy && state.story?.id === s.id ? ' · <span class="running">in scrittura…</span>' : ''}</div>
      </div>`,
    )
    .join('');
}

$('#storyList').addEventListener('click', (e) => {
  const item = e.target.closest('.story-item');
  if (!item || state.busy) {
    if (state.busy) toast('Attendi la fine della generazione o premi Stop.');
    return;
  }
  openStory(item.dataset.id);
  $('#sidebar').classList.remove('open');
});

async function openStory(id) {
  state.story = await api(`/api/stories/${id}`);
  state.editing = null;
  local.set('lastStory', id);
  renderAll();
}

function newStory() {
  if (state.busy) return toast('Attendi la fine della generazione o premi Stop.');
  state.story = null;
  state.editing = null;
  local.remove('lastStory');
  applyOptions({});
  $('#optionsPanel').open = window.innerWidth > 760;
  switchTab('chat');
  renderAll();
  $('#chatInput').focus();
  $('#sidebar').classList.remove('open');
}

// ---------- rendering ----------

function renderAll() {
  const s = state.story;
  $('#titleInput').value = s ? s.title : '';
  if (s) applyOptions(s.brief);
  renderSidebar();
  renderMessages();
  renderStory();
  renderComposer();
}

function renderComposer() {
  const s = state.story;
  const hasText = s?.chapters?.length > 0;
  const incomplete = s && s.outline.length > s.chapters.length;
  const novel = s?.mode === 'plan' && Boolean(s?.bible);
  $('#quickActions').hidden = !hasText && !incomplete && !novel;
  // modalità romanzo: un capitolo alla volta, quando lo decide l'autore
  $('#writeNextBtn').hidden = !(novel && incomplete);
  if (novel && incomplete) $('#writeNextBtn').textContent = `✍️ Scrivi il capitolo ${s.chapters.length + 1}`;
  $('#reviseBtn').hidden = !novel;
  const planPending = s?.mode === 'plan' && !s?.planComplete && (s?.bible || s?.outline.length);
  $('#resumeBtn').hidden = !(planPending || (incomplete && !novel));
  $('#resumeBtn').textContent = planPending ? '▶️ Completa il progetto' : '▶️ Riprendi generazione';
  if (planPending) {
    $('#quickActions').hidden = false;
    $('#writeNextBtn').hidden = true;
  }
  $('[data-quick="continue"]').hidden = !hasText || (novel && incomplete);
  $('#sendBtn').hidden = state.busy;
  $('#stopBtn').hidden = !state.busy;
  $('#chatInput').disabled = state.busy;
  const fresh = !s || (!hasText && !s.outline.length && !s.bible);
  $('#chatInput').placeholder = fresh
    ? 'Descrivi trama, personaggi e lunghezza… (Invio per inviare, Maiusc+Invio per andare a capo)'
    : novel && !hasText
      ? 'Fai domande o chiedi modifiche al progetto… (Invio per inviare)'
      : 'Chiedi una scena, una variante, un consiglio… (Invio per inviare)';
  $('#modeHint').textContent = fresh
    ? 'Il messaggio verrà usato come richiesta. Per le storie lunghe, o se lo chiedi, l\'AI prepara prima il progetto (story bible e scaletta) e poi scrivete un capitolo alla volta; per le storie brevi scrive tutto subito.'
    : novel
      ? 'Chatta sul romanzo: domande, idee, modifiche. «Modifica il progetto» applica le modifiche discusse; «Scrivi il capitolo» scrive il prossimo capitolo.'
      : 'Chatta sulla storia: chiedi scene, varianti, idee o modifiche. Usa «Continua la storia» per aggiungere un capitolo.';
  const words = s ? s.chapters.reduce((n, c) => n + countWords(c.content), 0) : 0;
  $('#wordBadge').textContent = words ? fmt(words) : '';
}

const EXAMPLES = [
  "Fanfiction dark su Harry Potter: Draco Malfoy (adulto, 25 anni) ed Hermione, nemici costretti a collaborare in un Ministero corrotto. Tensione, manipolazione, slow burn con scene esplicite. Racconto lungo.",
  "Thriller psicologico: una scrittrice scopre che il suo stalker conosce dettagli dei romanzi che non ha ancora pubblicato. Prima persona, presente, finale amaro. 3 capitoli.",
  "Dark fantasy: una regina mercenaria e il principe che ha imprigionato. Guerra, tradimenti, nessun eroe buono. Romanzo, terza persona, prosa cruda.",
];

function renderMessages() {
  const box = $('#messages');
  const s = state.story;
  if (!s || !s.messages.length) {
    box.innerHTML = `<div class="welcome">
      <h1>Che storia scriviamo?</h1>
      <p>Scrivi nella chat trama, personaggi, ambientazione e lunghezza. L'AI prepara una scaletta e scrive tutta la storia, capitolo per capitolo. Poi puoi chiedere modifiche, riscritture e nuovi capitoli.</p>
      <div class="examples">${EXAMPLES.map((e) => `<div class="example">${escapeHtml(e)}</div>`).join('')}</div>
    </div>`;
    box.querySelectorAll('.example').forEach((el) =>
      el.addEventListener('click', () => {
        $('#chatInput').value = el.textContent;
        $('#chatInput').focus();
      }),
    );
    return;
  }
  box.innerHTML = '';
  s.messages.forEach((m, i) => box.appendChild(messageEl(m, i)));
  box.scrollTop = box.scrollHeight;
}

function messageEl(m, i) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (m.role === 'user') {
    bubble.textContent = m.content;
  } else {
    const isProse = m.kind !== 'generation' && countWords(m.content) > 120;
    if (isProse) bubble.classList.add('prose');
    bubble.innerHTML = renderMd(m.content, { lists: !isProse });
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    if (m.kind === 'generation') {
      actions.innerHTML = `<button class="btn" data-act="open">📖 Apri la storia</button>`;
    } else {
      actions.innerHTML = `<button class="btn" data-act="copy">📋 Copia</button>
        <button class="btn" data-act="add">➕ Aggiungi come capitolo</button>`;
    }
    actions.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'open') switchTab('story');
      if (act === 'copy') navigator.clipboard.writeText(m.content).then(() => toast('Copiato'));
      if (act === 'add') addMessageAsChapter(m.content);
    });
    bubble.appendChild(actions);
  }
  wrap.appendChild(bubble);
  return wrap;
}

/** Messaggio "live" per le generazioni in corso. */
function liveMessage({ prose = false } = {}) {
  const box = $('#messages');
  if (box.querySelector('.welcome')) box.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = `<div class="bubble ${prose ? 'prose' : ''}">
    <div class="progress"><span class="status">Avvio…</span><div class="progress-bar" hidden><div></div></div></div>
    <div class="live-text cursor"></div>
  </div>`;
  box.appendChild(wrap);
  const status = wrap.querySelector('.status');
  const bar = wrap.querySelector('.progress-bar');
  const live = wrap.querySelector('.live-text');
  const stick = () => {
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
    if (nearBottom) box.scrollTop = box.scrollHeight;
    live.scrollTop = live.scrollHeight;
  };
  stick();
  box.scrollTop = box.scrollHeight;
  return {
    status(t) {
      status.textContent = t;
    },
    progress(done, total) {
      bar.hidden = total <= 1;
      bar.firstElementChild.style.width = `${Math.round((done / total) * 100)}%`;
    },
    clear() {
      live.textContent = '';
    },
    delta(t) {
      live.textContent += t;
      stick();
    },
    hideProgress() {
      wrap.querySelector('.progress').hidden = true;
    },
    error(msg) {
      live.classList.remove('cursor');
      const e = document.createElement('div');
      e.className = 'error';
      e.textContent = '⚠️ ' + msg;
      wrap.querySelector('.bubble').appendChild(e);
    },
    end() {
      live.classList.remove('cursor');
    },
  };
}

function renderStory() {
  const s = state.story;
  const reader = $('#reader');
  const hasStory = Boolean(s);
  $$('.story-toolbar .btn').forEach((b) => (b.style.visibility = hasStory ? '' : 'hidden'));
  if (!s || (!s.chapters.length && !s.outline.length && !s.bible)) {
    $('#storyStats').textContent = '';
    reader.innerHTML = '<div class="empty">La storia apparirà qui quando l\'AI avrà iniziato a scrivere.<br>Vai nella scheda Chat e descrivi cosa vuoi.</div>';
    return;
  }
  const words = s.chapters.reduce((n, c) => n + countWords(c.content), 0);
  $('#storyStats').textContent =
    `${s.chapters.length}/${Math.max(s.outline.length, s.chapters.length)} capitoli · ${fmt(words)} parole` +
    (words ? ` · ~${Math.max(1, Math.round(words / 230))} min di lettura` : '');

  const single = s.outline.length <= 1 && s.chapters.length <= 1;
  let html = `<div class="reader-inner"><h1 class="story-title">${escapeHtml(s.title)}</h1>`;
  if (s.bible) {
    const editingBible = state.editing === 'bible';
    html += `<details class="project" ${s.chapters.length && !editingBible ? '' : 'open'}>
      <summary>📖 Story bible <span class="muted">· il canon del romanzo</span></summary>
      ${
        editingBible
          ? `<textarea class="chapter-edit bible-edit">${escapeHtml(s.bible)}</textarea>
             <div class="msg-actions"><button class="btn primary" data-ch="bible-save">Salva</button><button class="btn ghost" data-ch="cancel">Annulla</button></div>`
          : `<div class="msg-actions">
               <button class="btn" data-ch="bible-edit">✏️ Modifica a mano</button>
               <button class="btn" data-ch="bible-revise">🛠️ Modifica con l'AI</button>
               ${s.previousBible ? '<button class="btn" data-ch="bible-undo">↩️ Versione precedente</button>' : ''}
               <button class="btn" data-ch="bible-export">⬇️ Scarica</button>
             </div>
             <div class="bible-body">${renderMd(s.bible, { lists: true })}</div>`
      }
    </details>`;
  }
  const memories = (s.memory || []).map((m, i) => (m ? { m, i } : null)).filter(Boolean);
  if (memories.length) {
    html += `<details class="project">
      <summary>🧠 Memoria dei capitoli <span class="muted">· ${memories.length} ${memories.length === 1 ? 'scheda' : 'schede'} di continuità</span></summary>
      <div class="bible-body">${memories.map(({ m, i }) => `<h3>Capitolo ${i + 1}: ${escapeHtml(s.chapters[i]?.title || '')}</h3>${renderMd(m, { lists: true })}`).join('')}</div>
    </details>`;
  }
  s.chapters.forEach((c, i) => {
    const tools = `<div class="chapter-tools">
        <button class="btn" data-ch="edit" data-i="${i}" title="Modifica a mano">✏️ Modifica</button>
        <button class="btn" data-ch="rewrite" data-i="${i}" title="Fai riscrivere all'AI">🔄 Riscrivi</button>
        ${c.previous ? `<button class="btn" data-ch="undo" data-i="${i}" title="Torna alla versione precedente">↩️</button>` : ''}
        <button class="btn danger" data-ch="delete" data-i="${i}" title="Elimina capitolo">🗑️</button>
      </div>`;
    if (state.editing === i) {
      html += `<div class="chapter" id="ch-${i}">
        <input class="edit-title" value="${escapeHtml(c.title)}" style="margin-bottom:8px" />
        <textarea class="chapter-edit">${escapeHtml(c.content)}</textarea>
        <div class="msg-actions"><button class="btn primary" data-ch="save" data-i="${i}">Salva</button><button class="btn ghost" data-ch="cancel">Annulla</button></div>
      </div>`;
    } else {
      html += `<div class="chapter" id="ch-${i}">
        <div class="chapter-head"><h2>${single ? '' : escapeHtml(c.title)}</h2>${tools}</div>
        <div class="chapter-body">${renderMd(c.content)}</div>
      </div>`;
    }
  });
  if (s.outline.length > s.chapters.length && s.bible) html += `<h2 class="outline-title">Scaletta dei prossimi capitoli</h2>`;
  s.outline.slice(s.chapters.length).forEach((c, k) => {
    html += `<div class="outline-pending"><strong>Da scrivere · ${s.chapters.length + k + 1}. ${escapeHtml(c.title)}</strong><br>${escapeHtml(c.summary)}</div>`;
  });
  html += '</div>';
  reader.innerHTML = html;
}

$('#reader').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ch]');
  if (!btn) return;
  const s = state.story;
  const i = Number(btn.dataset.i);
  const act = btn.dataset.ch;
  if (state.busy && act !== 'cancel') return toast('Attendi la fine della generazione.');
  try {
    if (act === 'bible-edit') {
      state.editing = 'bible';
      renderStory();
    } else if (act === 'bible-save') {
      const bible = $('.bible-edit').value;
      state.story = await api(`/api/stories/${s.id}`, { method: 'PUT', body: { bible } });
      state.editing = null;
      renderAll();
      toast('Story bible salvata');
    } else if (act === 'bible-undo') {
      if (!confirm('Tornare alla versione precedente della story bible? La scaletta resta quella attuale.')) return;
      state.story = await api(`/api/stories/${s.id}`, { method: 'PUT', body: { bible: s.previousBible } });
      renderAll();
    } else if (act === 'bible-export') {
      downloadText(`${safeFileName(s.title)} - story bible.md`, s.bible, 'text/markdown;charset=utf-8');
    } else if (act === 'bible-revise') {
      reviseFlow();
    } else if (act === 'edit') {
      state.editing = i;
      renderStory();
      document.getElementById(`ch-${i}`)?.scrollIntoView({ block: 'start' });
    } else if (act === 'cancel') {
      state.editing = null;
      renderStory();
    } else if (act === 'save') {
      const box = document.getElementById(`ch-${i}`);
      const chapters = s.chapters.map((c) => ({ ...c }));
      chapters[i] = { title: box.querySelector('.edit-title').value.trim() || chapters[i].title, content: box.querySelector('textarea').value };
      const outline = s.outline.map((c) => ({ ...c }));
      if (outline[i]) outline[i].title = chapters[i].title;
      state.story = await api(`/api/stories/${s.id}`, { method: 'PUT', body: { chapters, outline } });
      state.editing = null;
      renderAll();
      toast('Capitolo salvato');
    } else if (act === 'delete') {
      if (!confirm(`Eliminare il capitolo "${s.chapters[i].title}"?`)) return;
      const chapters = s.chapters.filter((_, k) => k !== i);
      const outline = s.outline.filter((_, k) => k !== i);
      const memory = (s.memory || []).filter((_, k) => k !== i);
      state.story = await api(`/api/stories/${s.id}`, { method: 'PUT', body: { chapters, outline, memory } });
      renderAll();
    } else if (act === 'undo') {
      const chapters = s.chapters.map((c, k) => (k === i ? { title: c.title, content: c.previous } : c));
      state.story = await api(`/api/stories/${s.id}`, { method: 'PUT', body: { chapters } });
      renderAll();
      toast('Ripristinata la versione precedente');
    } else if (act === 'rewrite') {
      const instr = await askText(
        `Riscrivi «${s.chapters[i].title}»`,
        'Come vuoi che venga riscritto? (es. "più dark e violento", "rendi la scena di sesso più esplicita e lunga", "aggiungi un dialogo tra i due"). Lascia vuoto per una revisione generale.',
      );
      if (instr === null) return;
      switchTab('chat');
      runGeneration('rewrite', { index: i, instructions: instr.trim() });
    }
  } catch (err) {
    toast(err.message);
  }
});

async function addMessageAsChapter(content) {
  const s = state.story;
  if (!s) return;
  const title = await askText('Aggiungi come capitolo', 'Titolo del nuovo capitolo:', `Capitolo ${s.chapters.length + 1}`);
  if (title === null) return;
  const idx = s.chapters.length;
  const chapters = [...s.chapters, { title: title.trim() || `Capitolo ${idx + 1}`, content: content.trim() }];
  const outline = [...s.outline];
  outline.splice(idx, 0, { title: chapters[idx].title, summary: '(aggiunto dalla chat)' });
  try {
    state.story = await api(`/api/stories/${s.id}`, { method: 'PUT', body: { chapters, outline } });
    renderAll();
    toast('Capitolo aggiunto alla storia');
  } catch (e) {
    toast(e.message);
  }
}

// ---------- generazione e chat ----------

function setBusy(b) {
  state.busy = b;
  renderComposer();
  renderSidebar();
}

async function ensureConfigured() {
  if (state.settings?.configured) return true;
  toast('Prima configura il modello AI nelle Impostazioni.');
  openSettings();
  return false;
}

async function runGeneration(kind, body) {
  const s = state.story;
  if (!s || state.busy) return;
  if (!(await ensureConfigured())) return;
  const ui = liveMessage({ prose: true });
  const controller = new AbortController();
  state.controller = controller;
  setBusy(true);
  let written = 0;
  let total = Math.max(s.outline.length, 1);
  try {
    await streamApi(
      `/api/stories/${s.id}/${kind}`,
      body,
      (ev) => {
        switch (ev.type) {
          case 'status':
            ui.status(ev.message);
            break;
          case 'phase':
            ui.clear();
            ui.status(ev.message);
            break;
          case 'bible':
            if (ev.title) $('#titleInput').value = ev.title;
            state.story = { ...state.story, bible: ev.bible, title: ev.title || state.story.title };
            renderStory();
            break;
          case 'brief':
            if (ev.title) $('#titleInput').value = ev.title;
            break;
          case 'outline':
            total = ev.outline.length;
            if (ev.title) $('#titleInput').value = ev.title;
            state.story = { ...state.story, outline: ev.outline, title: ev.title || state.story.title };
            renderStory();
            ui.status(`Scaletta pronta: ${total} ${total === 1 ? 'parte' : 'capitoli'}.`);
            break;
          case 'chapter_start':
            total = ev.total || total;
            ui.clear();
            ui.status(
              ev.rewrite
                ? `Riscrivo il capitolo ${ev.index + 1}: «${ev.title}»…`
                : total > 1
                  ? `Scrivo il capitolo ${ev.index + 1} di ${total}: «${ev.title}»…`
                  : `Scrivo «${ev.title}»…`,
            );
            ui.progress(ev.index, total);
            break;
          case 'delta':
            ui.delta(ev.text);
            break;
          case 'chapter_end':
            written++;
            ui.progress(ev.index + 1, total);
            refreshStorySilently();
            break;
          case 'done':
            state.story = ev.story;
            break;
          case 'error':
            throw new Error(ev.message);
          case 'aborted':
            break;
        }
      },
      controller.signal,
    );
  } catch (err) {
    if (err.name !== 'AbortError') {
      ui.error(err.message);
      toast(err.message, 6000);
    }
  } finally {
    ui.end();
    state.controller = null;
    setBusy(false);
    await reloadStory();
    if (written > 0 && kind === 'generate') toast('Storia pronta! Aprila nella scheda Storia.');
  }
}

async function refreshStorySilently() {
  try {
    const fresh = await api(`/api/stories/${state.story.id}`);
    state.story = { ...fresh };
    renderStory();
    renderSidebarCounts();
  } catch {}
}

function renderSidebarCounts() {
  loadStories().catch(() => {});
  const words = state.story.chapters.reduce((n, c) => n + countWords(c.content), 0);
  $('#wordBadge').textContent = words ? fmt(words) : '';
}

async function reloadStory() {
  if (!state.story) return;
  try {
    state.story = await api(`/api/stories/${state.story.id}`);
  } catch {}
  await loadStories().catch(() => {});
  renderAll();
}

async function runChat(message) {
  const s = state.story;
  if (!(await ensureConfigured())) return;
  // mostra subito il messaggio utente
  s.messages.push({ role: 'user', content: message });
  $('#messages').appendChild(messageEl(s.messages.at(-1)));
  const ui = liveMessage({ prose: true });
  ui.hideProgress();
  const controller = new AbortController();
  state.controller = controller;
  setBusy(true);
  try {
    await streamApi(
      `/api/stories/${s.id}/chat`,
      { message },
      (ev) => {
        if (ev.type === 'delta') ui.delta(ev.text);
        if (ev.type === 'error') throw new Error(ev.message);
      },
      controller.signal,
    );
  } catch (err) {
    if (err.name !== 'AbortError') {
      ui.error(err.message);
      toast(err.message, 6000);
    }
  } finally {
    ui.end();
    state.controller = null;
    setBusy(false);
    await reloadStory();
  }
}

async function send() {
  const text = $('#chatInput').value.trim();
  if (state.busy) return toast('Sto ancora scrivendo: attendi oppure premi Stop.');
  if (!text) {
    $('#chatInput').focus();
    return toast('Scrivi prima cosa vuoi nella casella in basso.');
  }
  if (!(await ensureConfigured())) return;
  $('#chatInput').value = '';

  try {
    const s = state.story;
    const empty = !s || (!s.chapters.length && !s.outline.length && !s.bible);
    if (empty) {
      const brief = { ...readOptions(), freeText: text, extracted: false };
      const typedTitle = $('#titleInput').value.trim();
      if (!s) {
        state.story = await api('/api/stories', {
          method: 'POST',
          body: { title: typedTitle || 'Nuova storia', brief: typedTitle ? { ...brief, title: typedTitle } : brief },
        });
        local.set('lastStory', state.story.id);
      } else {
        // storia vuota (es. generazione fallita): ricomincia con la nuova richiesta
        state.story = await api(`/api/stories/${s.id}`, {
          method: 'PUT',
          body: { brief: { ...brief, plot: '', characters: '', setting: '', genre: '', fandom: '', notes: '' } },
        });
      }
      state.story.messages.push({ role: 'user', content: text });
      renderMessages();
      $('#optionsPanel').open = false;
      await loadStories();
      await runGeneration('generate', { userMessage: text });
    } else {
      await runChat(text);
    }
  } catch (err) {
    toast(err.message, 6000);
    $('#chatInput').value = text;
  }
}

function stop() {
  state.controller?.abort();
  if (state.story) api(`/api/stories/${state.story.id}/stop`, { method: 'POST' }).catch(() => {});
}

// ---------- tab ----------

function switchTab(tab) {
  state.tab = tab;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#chatView').hidden = tab !== 'chat';
  $('#storyView').hidden = tab !== 'story';
  if (tab === 'chat') {
    const box = $('#messages');
    box.scrollTop = box.scrollHeight;
  }
}

// ---------- impostazioni ----------

async function loadSettings() {
  state.settings = await api('/api/settings');
}

let dialogProvider = 'ollama';
let ollamaInfo = { running: false, models: [], recommended: [] };
let pullController = null;

function setProvider(p) {
  dialogProvider = p;
  $$('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.provider === p));
  $('#ollamaSection').hidden = p !== 'ollama';
  $('#openaiSection').hidden = p !== 'openai';
  if (p === 'ollama') refreshOllama();
}

function setResult(text, kind = '') {
  const r = $('#testResult');
  r.className = 'test-result' + (kind ? ' ' + kind : '');
  r.textContent = text;
}

function openSettings() {
  const s = state.settings || {};
  $('#ollamaUrl').value = s.ollamaUrl || 'http://localhost:11434';
  $('#setNumCtx').value = s.numCtx ?? 12288;
  $('#setBaseUrl').value = s.baseUrl || '';
  $('#setApiKey').value = '';
  $('#keyHint').textContent = s.apiKeySet ? `(salvata ${s.apiKeyHint})` : '(non impostata)';
  $('#setModel').value = s.model || '';
  $('#setTemp').value = s.temperature ?? 0.9;
  $('#setMaxTokens').value = s.maxTokens ?? 6000;
  $('#setWpc').value = s.wordsPerChapter ?? 2000;
  $('#presetSelect').value = '';
  setResult('');
  setProvider(backend ? 'openai' : s.provider || 'ollama');
  if (backend) renderPhonePresets();
  if (!$('#settingsDialog').open) $('#settingsDialog').showModal();
}

const sameModel = (a, b) => {
  const norm = (x) => String(x || '').toLowerCase().replace(/:latest$/, '');
  return norm(a) === norm(b);
};

async function refreshOllama() {
  const st = $('#ollamaStatus');
  st.className = 'ollama-status';
  st.textContent = 'Controllo Ollama…';
  try {
    const url = encodeURIComponent($('#ollamaUrl').value.trim());
    ollamaInfo = await api(`/api/ollama/status?url=${url}`);
  } catch (e) {
    ollamaInfo = { running: false, error: e.message, models: [], recommended: [] };
  }
  const { running, models, version } = ollamaInfo;
  $('#ollamaInstall').hidden = running;
  if (running) {
    st.className = 'ollama-status ok';
    st.textContent = `✓ Ollama attivo${version ? ` (versione ${version})` : ''} · ${models.length} ${models.length === 1 ? 'modello installato' : 'modelli installati'}`;
  } else {
    st.className = 'ollama-status err';
    st.textContent = '✗ Ollama non risponde. Installalo o avvialo, poi premi «Ricontrolla».';
  }

  // elenco modelli installati
  const sel = $('#ollamaModel');
  const wanted = sel.value || state.settings?.ollamaModel || '';
  if (!models.length) {
    sel.innerHTML = '<option value="">— nessun modello installato —</option>';
  } else {
    sel.innerHTML = models
      .map((m) => {
        const meta = [m.params, m.sizeGb ? `${m.sizeGb} GB` : ''].filter(Boolean).join(' · ');
        return `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)}${meta ? ` (${escapeHtml(meta)})` : ''}</option>`;
      })
      .join('');
    const match = models.find((m) => sameModel(m.name, wanted));
    const recommendedInstalled = models.find((m) => (ollamaInfo.recommended || []).some((r) => sameModel(r.name, m.name)));
    sel.value = (match || recommendedInstalled || models[0]).name;
  }

  // modelli consigliati
  $('#recommendedModels').innerHTML = (ollamaInfo.recommended || [])
    .map((r) => {
      const installed = models.some((m) => sameModel(m.name, r.name));
      return `<button type="button" class="rec ${installed ? 'installed' : ''}" data-model="${escapeHtml(r.name)}" ${installed ? 'disabled' : ''}>
        <span><span class="rec-name">${escapeHtml(r.label)}</span><br><span class="rec-note">${escapeHtml(r.note)}</span></span>
        <span class="rec-meta">${escapeHtml(r.size)}<br>GPU ${escapeHtml(r.vram)}</span>
      </button>`;
    })
    .join('');
  if (ollamaInfo.pulling && !pullController) {
    $('#pullProgress').hidden = false;
    $('#pullStatus').textContent = `Download di ${ollamaInfo.pulling} in corso…`;
  }
}

const gb = (n) => (n / 1e9).toFixed(n >= 1e10 ? 0 : 1);

async function pullModel(name) {
  if (!name) return;
  if (pullController) return toast('C\'è già un download in corso.');
  if (!ollamaInfo.running) return toast('Ollama non è attivo: avvialo prima di scaricare un modello.');
  pullController = new AbortController();
  $('#pullProgress').hidden = false;
  $('#pullBtn').disabled = true;
  $('#pullStatus').textContent = `Preparo il download di ${name}…`;
  $('#pullBar').style.width = '0';
  let failed = false;
  try {
    await streamApi(
      '/api/ollama/pull',
      { name, url: $('#ollamaUrl').value.trim() },
      (ev) => {
        if (ev.type === 'progress') {
          if (ev.total) {
            const pct = Math.round((ev.completed / ev.total) * 100);
            $('#pullBar').style.width = pct + '%';
            $('#pullStatus').textContent = `Scarico ${name}: ${gb(ev.completed)} di ${gb(ev.total)} GB (${pct}%)`;
          } else {
            const map = { 'pulling manifest': 'Leggo le informazioni del modello…', 'verifying sha256 digest': 'Verifico i file…', 'writing manifest': 'Completo l\'installazione…', success: 'Installato!' };
            $('#pullStatus').textContent = map[ev.status] || ev.status;
          }
        }
        if (ev.type === 'error') throw new Error(ev.message);
      },
      pullController.signal,
    );
  } catch (e) {
    failed = true;
    if (e.name !== 'AbortError') setResult('✗ ' + e.message, 'err');
  } finally {
    pullController = null;
    $('#pullBtn').disabled = false;
    $('#pullProgress').hidden = true;
  }
  if (!failed) {
    $('#ollamaModel').value = '';
    state.settings = { ...state.settings, ollamaModel: name };
    await refreshOllama();
    setResult(`✓ ${name} installato e selezionato. Premi Salva.`, 'ok');
  }
}

$$('.seg-btn').forEach((b) => b.addEventListener('click', () => setProvider(b.dataset.provider)));
$('#ollamaRecheck').addEventListener('click', refreshOllama);
$('#ollamaUrl').addEventListener('change', refreshOllama);
$('#recommendedModels').addEventListener('click', (e) => {
  const btn = e.target.closest('.rec');
  if (btn && !btn.disabled) pullModel(btn.dataset.model);
});
$('#pullBtn').addEventListener('click', () => pullModel($('#pullName').value.trim()));
$('#pullCancel').addEventListener('click', () => {
  pullController?.abort();
  fetch('/api/ollama/pull', { method: 'DELETE' }).catch(() => {});
});

async function saveSettingsFromForm() {
  const body = {
    provider: dialogProvider,
    ollamaUrl: $('#ollamaUrl').value.trim(),
    numCtx: $('#setNumCtx').value,
    baseUrl: $('#setBaseUrl').value.trim(),
    model: $('#setModel').value.trim(),
    temperature: $('#setTemp').value,
    maxTokens: $('#setMaxTokens').value,
    wordsPerChapter: $('#setWpc').value,
  };
  if (dialogProvider === 'ollama' && $('#ollamaModel').value) body.ollamaModel = $('#ollamaModel').value;
  const key = $('#setApiKey').value.trim();
  if (key) body.apiKey = key;
  const appPassword = $('#setAppPassword').value;
  if (appPassword) body.appPassword = appPassword;
  state.settings = await api('/api/settings', { method: 'POST', body });
  $('#keyHint').textContent = state.settings.apiKeySet ? `(salvata ${state.settings.apiKeyHint})` : '(non impostata)';
  $('#setApiKey').value = '';
  $('#setAppPassword').value = '';
  if (backend) {
    $('#appPasswordHint').textContent = state.settings.appPasswordSet ? '(salvata)' : '(non impostata)';
    $('#accessLinkBox').hidden = !state.settings.appPasswordSet;
  }
}

$('#presetSelect').addEventListener('change', (e) => {
  if (e.target.value) $('#setBaseUrl').value = e.target.value;
});

$('#saveSettings').addEventListener('click', async () => {
  try {
    await saveSettingsFromForm();
    if (!state.settings.configured) {
      return setResult(
        dialogProvider === 'ollama'
          ? 'Scarica e seleziona un modello prima di salvare.'
          : backend && !$('#autoLogin').hidden
            ? 'Inserisci la password dell\'app.'
            : backend
              ? 'Inserisci la chiave API e il nome del modello.'
              : 'Inserisci il nome del modello.',
        'err',
      );
    }
    $('#settingsDialog').close();
    toast(`Impostazioni salvate · modello: ${state.settings.activeModel}`);
  } catch (e) {
    setResult(e.message, 'err');
  }
});

$('#cancelSettings').addEventListener('click', () => $('#settingsDialog').close());

$('#testBtn').addEventListener('click', async () => {
  setResult(
    dialogProvider === 'ollama'
      ? 'Carico il modello in memoria e lo provo. La prima volta può richiedere un minuto…'
      : 'Provo la connessione…',
  );
  try {
    await saveSettingsFromForm();
    if (!state.settings.configured) throw new Error('Nessun modello selezionato.');
    const res = await api('/api/settings/test', { method: 'POST' });
    setResult(`✓ Funziona (${(res.ms / 1000).toFixed(1)} s). Risposta: "${res.reply}"`, 'ok');
  } catch (e) {
    setResult('✗ ' + e.message, 'err');
  }
});

$('#loadModelsBtn').addEventListener('click', async () => {
  setResult('Carico i modelli…');
  try {
    await saveSettingsFromForm();
    const { models } = await api('/api/models');
    $('#modelList').innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
    setResult(`${models.length} modelli disponibili: inizia a scrivere nel campo Modello per filtrarli.`);
    $('#setModel').focus();
  } catch (e) {
    setResult('✗ ' + e.message, 'err');
  }
});

// ---------- eventi ----------

$('#newStoryBtn').addEventListener('click', newStory);
$('#settingsBtn').addEventListener('click', openSettings);
$('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});
let shiftDown = false;
$('#chatInput').addEventListener('keydown', (e) => {
  shiftDown = e.shiftKey;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
// Molte tastiere Android non inviano il tasto Invio come "keydown": lo intercetto quando sta per andare a capo.
$('#chatInput').addEventListener('beforeinput', (e) => {
  if (e.inputType === 'insertLineBreak' && !shiftDown) {
    e.preventDefault();
    send();
  }
});
$('#stopBtn').addEventListener('click', stop);
['#optLength', '#optFlow', '#optWords', '#optPov', '#optTense', '#optLang', '#optExplicit', '#optDark', '#optStyle'].forEach((sel) =>
  $(sel).addEventListener('change', onOptionsChange),
);

$('#titleInput').addEventListener('change', async () => {
  if (!state.story) return;
  try {
    state.story = await api(`/api/stories/${state.story.id}`, { method: 'PUT', body: { title: $('#titleInput').value } });
    renderStory();
    loadStories();
  } catch (e) {
    toast(e.message);
  }
});

async function writeNextFlow() {
  const s = state.story;
  if (!s || state.busy) return;
  const i = s.chapters.length;
  const plan = s.outline[i];
  const dir = await askText(
    `Scrivi il capitolo ${i + 1}${plan ? `: «${plan.title}»` : ''}`,
    'Vuoi aggiungere indicazioni per questo capitolo? (facoltative: lascia vuoto per seguire la scaletta)',
  );
  if (dir === null) return;
  switchTab('chat');
  runGeneration('continue', { direction: dir.trim() });
}

async function reviseFlow() {
  if (!state.story || state.busy) return;
  const instr = await askText(
    'Modifica il progetto',
    'Cosa vuoi cambiare? Lascia vuoto per applicare le modifiche di cui avete parlato in chat. I capitoli già scritti non cambiano.',
  );
  if (instr === null) return;
  switchTab('chat');
  runGeneration('revise', { instructions: instr.trim() });
}

async function continueFlow() {
  if (!state.story || state.busy) return;
  const dir = await askText(
    'Continua la storia',
    'Cosa deve succedere nel prossimo capitolo? Lascia vuoto per lasciar decidere all\'AI.',
  );
  if (dir === null) return;
  switchTab('chat');
  runGeneration('continue', { direction: dir.trim() });
}

$('#quickActions').addEventListener('click', (e) => {
  const q = e.target.closest('[data-quick]')?.dataset.quick;
  if (q === 'continue') continueFlow();
  if (q === 'resume') runGeneration('generate', {});
  if (q === 'next') writeNextFlow();
  if (q === 'revise') reviseFlow();
});
$('#continueBtn').addEventListener('click', continueFlow);

$('#copyAllBtn').addEventListener('click', () => {
  const s = state.story;
  if (!s) return;
  const text = [s.title, '', ...s.chapters.flatMap((c) => (s.chapters.length > 1 ? [c.title, '', c.content, ''] : [c.content]))].join('\n');
  navigator.clipboard.writeText(text).then(() => toast('Storia copiata negli appunti'));
});

$('#deleteStoryBtn').addEventListener('click', async () => {
  const s = state.story;
  if (!s || !confirm(`Eliminare definitivamente «${s.title}»?`)) return;
  try {
    await api(`/api/stories/${s.id}`, { method: 'DELETE' });
    await loadStories();
    newStory();
    toast('Storia eliminata');
  } catch (e) {
    toast(e.message);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.busy) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------- esportazione e backup (funzionano anche sul telefono) ----------

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportCurrent(format) {
  const s = state.story;
  if (!s?.chapters.length) return toast('La storia è ancora vuota.');
  const type = format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
  downloadText(`${safeFileName(s.title)}.${format}`, exportStory(s, format), type);
}

$('#exportMd').addEventListener('click', () => exportCurrent('md'));
$('#exportTxt').addEventListener('click', () => exportCurrent('txt'));

async function renderPhonePresets() {
  const box = $('#phonePresets');
  const proxy = await backend.mistralProxyAvailable();
  const current = state.settings?.preset || '';
  box.innerHTML = backend.presets
    .map((p) => {
      const off = p.needsProxy && !proxy;
      return `<button type="button" class="rec ${current === p.id ? 'selected' : ''}" data-preset="${p.id}" ${off ? 'disabled' : ''}>
        <span><span class="rec-name">${escapeHtml(p.label)}</span><br><span class="rec-note">${escapeHtml(
          off ? 'non disponibile a questo indirizzo: apri l\'app dalla versione pubblicata su Cloudflare' : p.badge,
        )}</span></span>
        <span class="rec-meta">${current === p.id ? '✓ in uso' : 'Scegli'}</span>
      </button>`;
    })
    .join('');
  const sel = backend.presets.find((p) => p.id === current);
  showKeyLink(sel);
  renderAutoLogin(sel || { needsProxy: (state.settings?.baseUrl || '').startsWith('/api/mistral/') });
}

/** Mostra la password dell'app al posto della chiave quando la chiave di Mistral è su Cloudflare. */
async function renderAutoLogin(preset) {
  const info = await backend.proxyInfo();
  const active = Boolean(preset?.needsProxy && info?.serverKey);
  $('#autoLogin').hidden = !active;
  $('#apiKeyLabel').hidden = active;
  if (active) $('#keyLink').hidden = true;
  if (!active) return;
  const st = $('#autoLoginStatus');
  if (!info.passwordSet) {
    st.className = 'warn';
    st.textContent = '⚠️ La chiave di Mistral è su Cloudflare, ma manca il segreto APP_PASSWORD: aggiungilo nelle impostazioni del progetto su Cloudflare e ripubblica.';
  } else {
    st.className = 'ok';
    st.textContent = '✓ Accesso automatico: la chiave di Mistral è salvata su Cloudflare. Su questo telefono basta la password dell\'app, una volta sola.';
  }
  $('#appPasswordHint').textContent = state.settings?.appPasswordSet ? '(salvata)' : '(non impostata)';
  $('#accessLinkBox').hidden = !state.settings?.appPasswordSet;
}

function showKeyLink(p) {
  const link = $('#keyLink');
  link.hidden = !p;
  if (!p) return;
  link.href = p.keyUrl;
  link.textContent = `Crea una chiave su ${new URL(p.keyUrl).host} ↗`;
}

$('#phonePresets').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-preset]');
  if (!btn || btn.disabled) return;
  const p = backend.presets.find((x) => x.id === btn.dataset.preset);
  $('#setBaseUrl').value = p.baseUrl;
  $('#setModel').value = p.model;
  $$('#phonePresets .rec').forEach((b) => b.classList.toggle('selected', b === btn));
  showKeyLink(p);
  renderAutoLogin(p);
  setResult(p.model ? 'Ora incolla la chiave API e premi «Prova connessione».' : 'Incolla la chiave API, poi premi «Carica elenco» e scegli un modello.');
  $('#setApiKey').focus();
});

$('#copyAccessLink').addEventListener('click', async () => {
  const link = backend.accessLink();
  if (!link) return setResult('Salva prima la password dell\'app.', 'err');
  try {
    await navigator.clipboard.writeText(link);
    setResult('✓ Link copiato. Aprilo sull\'altro telefono o browser: l\'app si collegherà da sola.', 'ok');
  } catch {
    await askText('Link di accesso', 'Copia questo link e tienilo al sicuro:', link);
  }
});

$('#backupExport').addEventListener('click', async () => {
  try {
    const data = await api('/api/backup');
    downloadText(`fanfic-studio-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
    setResult(`✓ Backup creato con ${data.stories.length} storie.`, 'ok');
  } catch (e) {
    setResult('✗ ' + e.message, 'err');
  }
});

$('#backupImport').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const { imported } = await api('/api/backup', { method: 'POST', body: data });
    await loadStories();
    setResult(`✓ Importate ${imported} storie.`, 'ok');
  } catch (err) {
    setResult('✗ File di backup non valido: ' + err.message, 'err');
  }
});

// ---------- avvio ----------

(async function init() {
  $('#appVersion').textContent = `versione ${APP_VERSION}`;
  try {
    await detectBackend();
    try {
      await Promise.all([loadSettings(), loadStories()]);
    } catch (e) {
      toast((backend ? 'Errore di avvio: ' : 'Impossibile contattare il server: ') + e.message, 8000);
    }
    const last = local.get('lastStory');
    if (last && state.stories.some((s) => s.id === last)) {
      await openStory(last).catch(() => newStory());
    } else {
      newStory();
    }
    if (!state.settings?.configured) openSettings();
  } catch (e) {
    toast('⚠️ Errore di avvio: ' + e.message, 10000);
  } finally {
    window.__fanficReady = true;
  }
})();
