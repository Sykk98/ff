// Fanfic Studio — interfaccia client (vanilla JS, nessuna dipendenza).

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

async function api(path, opts = {}) {
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

function renderMd(text) {
  return String(text || '')
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const h = block.match(/^(#{1,4})\s+(.*)$/);
      if (h && !block.includes('\n')) return `<h${h[1].length + 1}>${inlineMd(h[2])}</h${h[1].length + 1}>`;
      if (/^(\*\s*){3,}$|^-{3,}$/.test(block.trim())) return '<p style="text-align:center">⁂</p>';
      return `<p>${block.split('\n').map(inlineMd).join('<br>')}</p>`;
    })
    .join('');
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
    lengthPreset: '',
    targetWords: 0,
    lengthLocked: true,
  };
  if (len === 'custom') o.targetWords = Number($('#optWords').value) || 3000;
  else if (len === 'auto') o.lengthLocked = false;
  else o.lengthPreset = len;
  return o;
}

function applyOptions(b = {}) {
  let len = 'breve';
  if (b.lengthPreset) len = b.lengthPreset;
  else if (Number(b.targetWords) > 0) len = b.lengthLocked === false ? 'auto' : 'custom';
  else if (b.lengthLocked === false) len = 'auto';
  $('#optLength').value = len;
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
  const bits = [lenText];
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
  localStorage.setItem('lastStory', id);
  renderAll();
}

function newStory() {
  if (state.busy) return toast('Attendi la fine della generazione o premi Stop.');
  state.story = null;
  state.editing = null;
  localStorage.removeItem('lastStory');
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
  $('#quickActions').hidden = !hasText && !incomplete;
  $('#resumeBtn').hidden = !incomplete;
  $('[data-quick="continue"]').hidden = !hasText;
  $('#sendBtn').hidden = state.busy;
  $('#stopBtn').hidden = !state.busy;
  $('#chatInput').disabled = state.busy;
  $('#chatInput').placeholder = !hasText
    ? 'Descrivi trama, personaggi e lunghezza… (Invio per inviare, Maiusc+Invio per andare a capo)'
    : 'Chiedi una scena, una variante, un consiglio… (Invio per inviare)';
  $('#modeHint').textContent = !hasText
    ? 'Il messaggio verrà usato come richiesta: l\'AI preparerà la scaletta e scriverà la storia completa in automatico.'
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
    bubble.innerHTML = renderMd(m.content);
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
  if (!s || (!s.chapters.length && !s.outline.length)) {
    $('#storyStats').textContent = '';
    reader.innerHTML = '<div class="empty">La storia apparirà qui quando l\'AI avrà iniziato a scrivere.<br>Vai nella scheda Chat e descrivi cosa vuoi.</div>';
    return;
  }
  const words = s.chapters.reduce((n, c) => n + countWords(c.content), 0);
  $('#storyStats').textContent = `${s.chapters.length}/${Math.max(s.outline.length, s.chapters.length)} capitoli · ${fmt(words)} parole · ~${Math.max(1, Math.round(words / 230))} min di lettura`;
  $('#exportMd').href = `/api/stories/${s.id}/export?format=md`;
  $('#exportTxt').href = `/api/stories/${s.id}/export?format=txt`;

  const single = s.outline.length <= 1 && s.chapters.length <= 1;
  let html = `<div class="reader-inner"><h1 class="story-title">${escapeHtml(s.title)}</h1>`;
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
    if (act === 'edit') {
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
      state.story = await api(`/api/stories/${s.id}`, { method: 'PUT', body: { chapters, outline } });
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
  if (state.settings?.model && state.settings?.baseUrl) return true;
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
  if (!text || state.busy) return;
  if (!(await ensureConfigured())) return;
  $('#chatInput').value = '';

  try {
    const s = state.story;
    const empty = !s || (!s.chapters.length && !s.outline.length);
    if (empty) {
      const brief = { ...readOptions(), freeText: text, extracted: false };
      const typedTitle = $('#titleInput').value.trim();
      if (!s) {
        state.story = await api('/api/stories', {
          method: 'POST',
          body: { title: typedTitle || 'Nuova storia', brief: typedTitle ? { ...brief, title: typedTitle } : brief },
        });
        localStorage.setItem('lastStory', state.story.id);
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

function openSettings() {
  const s = state.settings || {};
  $('#setBaseUrl').value = s.baseUrl || '';
  $('#setApiKey').value = '';
  $('#keyHint').textContent = s.apiKeySet ? `(salvata ${s.apiKeyHint})` : '(non impostata)';
  $('#setModel').value = s.model || '';
  $('#setTemp').value = s.temperature ?? 0.9;
  $('#setMaxTokens').value = s.maxTokens ?? 6000;
  $('#setWpc').value = s.wordsPerChapter ?? 2000;
  $('#presetSelect').value = '';
  $('#testResult').textContent = '';
  $('#testResult').className = 'test-result';
  $('#settingsDialog').showModal();
}

async function saveSettingsFromForm() {
  const body = {
    baseUrl: $('#setBaseUrl').value.trim(),
    model: $('#setModel').value.trim(),
    temperature: $('#setTemp').value,
    maxTokens: $('#setMaxTokens').value,
    wordsPerChapter: $('#setWpc').value,
  };
  const key = $('#setApiKey').value.trim();
  if (key) body.apiKey = key;
  state.settings = await api('/api/settings', { method: 'POST', body });
  $('#keyHint').textContent = state.settings.apiKeySet ? `(salvata ${state.settings.apiKeyHint})` : '(non impostata)';
  $('#setApiKey').value = '';
}

$('#presetSelect').addEventListener('change', (e) => {
  if (e.target.value) $('#setBaseUrl').value = e.target.value;
});

$('#saveSettings').addEventListener('click', async () => {
  try {
    await saveSettingsFromForm();
    $('#settingsDialog').close();
    toast('Impostazioni salvate');
  } catch (e) {
    $('#testResult').className = 'test-result err';
    $('#testResult').textContent = e.message;
  }
});

$('#cancelSettings').addEventListener('click', () => $('#settingsDialog').close());

$('#testBtn').addEventListener('click', async () => {
  const r = $('#testResult');
  r.className = 'test-result';
  r.textContent = 'Provo la connessione…';
  try {
    await saveSettingsFromForm();
    const res = await api('/api/settings/test', { method: 'POST' });
    r.className = 'test-result ok';
    r.textContent = `✓ Funziona (${res.ms} ms). Risposta: "${res.reply}"`;
  } catch (e) {
    r.className = 'test-result err';
    r.textContent = '✗ ' + e.message;
  }
});

$('#loadModelsBtn').addEventListener('click', async () => {
  const r = $('#testResult');
  r.className = 'test-result';
  r.textContent = 'Carico i modelli…';
  try {
    await saveSettingsFromForm();
    const { models } = await api('/api/models');
    $('#modelList').innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
    r.textContent = `${models.length} modelli disponibili: inizia a scrivere nel campo Modello per filtrarli.`;
    $('#setModel').focus();
  } catch (e) {
    r.className = 'test-result err';
    r.textContent = '✗ ' + e.message;
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
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
$('#stopBtn').addEventListener('click', stop);
['#optLength', '#optWords', '#optPov', '#optTense', '#optLang', '#optExplicit', '#optDark', '#optStyle'].forEach((sel) =>
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

// ---------- avvio ----------

(async function init() {
  try {
    await Promise.all([loadSettings(), loadStories()]);
  } catch (e) {
    toast('Impossibile contattare il server: ' + e.message, 8000);
  }
  const last = localStorage.getItem('lastStory');
  if (last && state.stories.some((s) => s.id === last)) {
    await openStory(last).catch(() => newStory());
  } else {
    newStory();
  }
  if (!state.settings?.model) openSettings();
})();
