import {
  matchEndings, captionFor, toStates, normalizeLevel, summarize, sortLevels,
} from './logic.js';

const LEVELS_DIR = 'levels';
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const app = $('#app');
const dlg = $('#dlg');

/* ───────────────────────── Дані: каталог і рівні ───────────────────────── */

let indexCache = null;
const levelCache = new Map();

/** Посилання на файл усередині папки рівня (картинка тощо). */
function assetUrl(id, rel) {
  if (!rel) return '';
  if (/^(https?:|data:)/.test(rel)) return rel;
  const path = rel.split('/').map(encodeURIComponent).join('/');
  return new URL(`${LEVELS_DIR}/${encodeURIComponent(id)}/${path}`, document.baseURI).href;
}

async function fetchLevel(id) {
  if (levelCache.has(id)) return levelCache.get(id);
  const r = await fetch(`${LEVELS_DIR}/${encodeURIComponent(id)}/level.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`level.json: ${r.status}`);
  const L = normalizeLevel(await r.json());
  levelCache.set(id, L);
  return L;
}

/** Запасний варіант: якщо levels/index.json немає — питаємо GitHub API (працює на *.github.io). */
async function indexViaGitHubApi() {
  const host = location.hostname;
  if (!host.endsWith('.github.io')) throw new Error('NO_INDEX');
  const owner = host.slice(0, -'.github.io'.length);
  const first = location.pathname.split('/').filter(Boolean)[0];
  const repo = first && !first.includes('.') ? first : `${owner}.github.io`;
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${LEVELS_DIR}`);
  if (!r.ok) throw new Error(`API_${r.status}`);
  const dirs = (await r.json()).filter((x) => x.type === 'dir' && !/^[_.]/.test(x.name));
  const list = await Promise.all(
    dirs.map(async (d) => {
      try { return summarize(d.name, await fetchLevel(d.name)); } catch { return null; }
    })
  );
  return sortLevels(list.filter(Boolean));
}

async function getIndex() {
  if (indexCache) return indexCache;
  try {
    const r = await fetch(`${LEVELS_DIR}/index.json`, { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      indexCache = sortLevels(j.levels || []);
      return indexCache;
    }
  } catch { /* йдемо до запасного варіанта */ }
  indexCache = await indexViaGitHubApi();
  return indexCache;
}

/* ───────────────────────── Прогрес гравця ───────────────────────── */

const progressKey = (id) => `kadry:${id}`;
function getProgress(id) {
  try { return JSON.parse(localStorage.getItem(progressKey(id))) || { found: [] }; } catch { return { found: [] }; }
}
function saveProgress(id, p) {
  try { localStorage.setItem(progressKey(id), JSON.stringify(p)); } catch { /* приватний режим */ }
}

/* ───────────────────────── Допоміжне ───────────────────────── */

function toast(msg) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

const stars = (n) => '★'.repeat(n) + '☆'.repeat(3 - n);

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* ───────────────────────── Каталог ───────────────────────── */

async function showCatalog() {
  S = null;
  document.title = 'Кадри історій';
  app.innerHTML = '<p class="muted center">Завантаження рівнів…</p>';

  let levels;
  try {
    levels = await getIndex();
  } catch (e) {
    app.innerHTML = `
      <div class="notice">
        <h2>Не вдалося отримати список рівнів</h2>
        <p>Файл <code>levels/index.json</code> не знайдено. Згенеруй його командою
        <code>node scripts/build-index.mjs</code> і відкрий сайт через локальний сервер
        (наприклад, <code>npx serve</code>). На GitHub Pages цей файл створюється автоматично.</p>
        <p class="muted">Деталі: ${esc(e.message)}</p>
      </div>`;
    return;
  }

  if (!levels.length) {
    app.innerHTML = `
      <div class="notice">
        <h2>Рівнів поки немає</h2>
        <p>Додай папку з файлом <code>level.json</code> у <code>levels/</code> — і вона зʼявиться тут.</p>
      </div>`;
    return;
  }

  const cards = levels.map((lv) => {
    const found = getProgress(lv.id).found.length;
    const cover = lv.cover
      ? `<img src="${esc(assetUrl(lv.id, lv.cover))}" alt="" loading="lazy">`
      : `<span class="card-icon" aria-hidden="true">${esc(lv.icon || '🎞️')}</span>`;
    const done = found >= lv.endings && lv.endings > 0;
    return `
      <a class="card" href="#/level/${encodeURIComponent(lv.id)}">
        <div class="card-cover">${cover}${done ? '<span class="stamp">✔ пройдено</span>' : ''}</div>
        <div class="card-body">
          <h2>${esc(lv.title)}</h2>
          ${lv.description ? `<p>${esc(lv.description)}</p>` : ''}
          <div class="meta">
            <span>🎞️ ${lv.frames} ${plural(lv.frames, 'кадр', 'кадри', 'кадрів')}</span>
            ${lv.difficulty ? `<span title="Складність">${stars(lv.difficulty)}</span>` : ''}
            <span class="prog">🎬 ${found}/${lv.endings}</span>
          </div>
          ${lv.author ? `<div class="author">автор: ${esc(lv.author)}</div>` : ''}
        </div>
      </a>`;
  });

  app.innerHTML = `
    <section class="hero">
      <h1>Обери історію</h1>
      <p>Розстав персонажів і декорації по кадрах — і подивись, який сюжет вийде. Деякі кінцівки сховані.</p>
    </section>
    <div class="grid">${cards.join('')}</div>`;
}

/* ───────────────────────── Рівень ───────────────────────── */

/** Стан поточного рівня (null, коли відкрито каталог). */
let S = null;

async function showLevel(id) {
  app.innerHTML = '<p class="muted center">Завантаження рівня…</p>';
  let L;
  try {
    L = await fetchLevel(id);
  } catch (e) {
    app.innerHTML = `
      <div class="notice">
        <h2>Рівень не знайдено</h2>
        <p>Не вдалося завантажити <code>levels/${esc(id)}/level.json</code>.</p>
        <p><a class="btn" href="#/">← До каталогу</a></p>
      </div>`;
    return;
  }

  S = {
    id,
    level: L,
    charMap: Object.fromEntries(L.characters.map((c) => [c.id, c])),
    setMap: Object.fromEntries(L.settings.map((s) => [s.id, s])),
    frames: L.frames.map(() => ({ setting: null, chars: Array(L.charSlots).fill(null) })),
    selected: null,
  };
  document.title = `${L.title} — Кадри історій`;

  app.innerHTML = `
    <div class="level-head">
      <a class="back" href="#/">← Усі рівні</a>
      <h1>${esc(L.title)}</h1>
      ${L.description ? `<p class="desc">${esc(L.description)}</p>` : ''}
      ${L.howto ? `<p class="howto">${esc(L.howto)}</p>` : ''}
    </div>
    <div class="layout">
      <section class="board">
        <div id="strip" class="strip"></div>
        <div class="dock">
          <div class="actions">
            <button id="play" class="btn primary" type="button">▶ Зняти фільм</button>
            <button id="clear" class="btn" type="button">Очистити кадри</button>
            <span class="dock-hint">Обери предмет нижче, потім торкнись кадру</span>
          </div>
          <div id="tray" class="tray"></div>
        </div>
      </section>
      <aside id="endings" class="endings"></aside>
    </div>`;

  renderStrip();
  renderTray();
  renderEndings();
}

function tokenHtml(item, id) {
  const visual = item.image
    ? `<img src="${esc(assetUrl(id, item.image))}" alt="">`
    : `<span class="emoji">${esc(item.emoji)}</span>`;
  return `${visual}<span class="nm">${esc(item.name)}</span>`;
}

function sceneStyle(setting) {
  if (!setting) return '';
  if (setting.image) return `background-image:url("${assetUrl(S.id, setting.image)}")`;
  return `background:${setting.color || 'linear-gradient(160deg,#3b3358,#26213b)'}`;
}

function frameHtml(f, i) {
  const st = S.frames[i];
  const setting = st.setting ? S.setMap[st.setting] : null;
  const caption = captionFor(S.level, i, toStates([st])[0]);
  const slots = st.chars.map((cid, k) => {
    const c = cid ? S.charMap[cid] : null;
    return `<button type="button" class="cslot ${c ? 'filled' : ''}" data-slot="char" data-k="${k}"
      aria-label="${c ? `Прибрати: ${esc(c.name)}` : 'Порожня комірка персонажа'}">${c ? tokenHtml(c, S.id) : '<span class="plus">＋</span>'}</button>`;
  }).join('');

  return `
    <article class="frame" data-frame="${i}">
      <header><span class="num">${i + 1}</span><span class="ft">${esc(f.title)}</span></header>
      <button type="button" class="setting-bar ${setting ? 'filled' : ''}" data-slot="setting">
        ${setting ? `<span>${esc(setting.name)}</span><span class="x" aria-hidden="true">✕</span>` : '<span>Декорація…</span>'}
      </button>
      <div class="scene" data-slot="scene" style="${esc(sceneStyle(setting))}">
        ${setting && !setting.image && setting.emoji ? `<span class="scene-emoji" aria-hidden="true">${esc(setting.emoji)}</span>` : ''}
        <div class="cslots" style="--n:${st.chars.length}">${slots}</div>
      </div>
      <p class="caption ${caption ? 'on' : ''}">${esc(caption)}</p>
    </article>`;
}

function renderStrip() {
  const strip = $('#strip');
  if (!strip) return;
  strip.innerHTML = S.level.frames.map(frameHtml).join('');
  strip.classList.toggle('armed-char', S.selected?.type === 'char');
  strip.classList.toggle('armed-setting', S.selected?.type === 'setting');
}

function renderTray() {
  const tray = $('#tray');
  if (!tray) return;
  const isSel = (type, id) => S.selected && S.selected.type === type && S.selected.id === id;
  const group = (title, type, items) => `
    <div class="tray-group">
      <h3>${title}</h3>
      <div class="items">
        ${items.map((it) => `
          <button type="button" class="item ${isSel(type, it.id) ? 'sel' : ''}" draggable="true"
            data-type="${type}" data-id="${esc(it.id)}">${tokenHtml(it, S.id)}</button>`).join('')}
      </div>
    </div>`;
  tray.innerHTML =
    group('Персонажі', 'char', S.level.characters) + group('Декорації', 'setting', S.level.settings);
}

function renderEndings() {
  const box = $('#endings');
  if (!box) return;
  const found = new Set(getProgress(S.id).found);
  const total = S.level.endings.length;
  const pct = total ? Math.round((found.size / total) * 100) : 0;

  const items = S.level.endings.map((e) => {
    if (found.has(e.id)) {
      return `<li class="found"><strong>🎬 ${esc(e.title)}</strong>${e.text ? `<span>${esc(e.text)}</span>` : ''}</li>`;
    }
    return `<li class="locked"><strong>${e.hidden ? '??? секретна кінцівка' : esc(e.title)}</strong>${
      e.clue ? `<em>${esc(e.clue)}</em>` : ''}</li>`;
  });

  box.innerHTML = `
    <h2>Кінцівки <span class="count">${found.size}/${total}</span></h2>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${found.size}"><i style="width:${pct}%"></i></div>
    <ul>${items.join('')}</ul>
    <button id="reset" class="btn small ghost" type="button">Скинути прогрес</button>`;
}

/* ── Розстановка ── */

function place(fi, item, k) {
  const st = S.frames[fi];
  if (item.type === 'setting') {
    st.setting = item.id;
    return true;
  }
  if (k == null) {
    k = st.chars.indexOf(null);
    if (k < 0) k = st.chars.length - 1;
  }
  if (st.chars.some((c, i) => c === item.id && i !== k)) {
    toast('Цей персонаж уже є в кадрі');
    return false;
  }
  st.chars[k] = item.id;
  return true;
}

function onSlotClick(fi, slot, k) {
  const st = S.frames[fi];
  const sel = S.selected;
  if (sel) {
    place(fi, sel, slot === 'char' && sel.type === 'char' ? k : null);
    S.selected = null;
    renderTray();
  } else if (slot === 'setting') {
    st.setting = null;
  } else if (slot === 'char') {
    st.chars[k] = null;
  }
  renderStrip();
}

function playMovie() {
  const empty = S.frames.every((f) => !f.setting && f.chars.every((c) => !c));
  if (empty) { toast('Спершу розстав щось у кадрах'); return; }

  const hits = matchEndings(S.level, S.frames);
  const progress = getProgress(S.id);
  const total = S.level.endings.length;

  if (!hits.length) {
    dlg.innerHTML = `
      <div class="dlg-card">
        <p class="badge miss">Сюжет не склався</p>
        <h2>Це ще не історія</h2>
        <p>${esc(S.level.hint || 'Спробуй змінити персонажів або місця дії в кадрах.')}</p>
        <form method="dialog"><button class="btn primary">Спробувати ще</button></form>
      </div>`;
    dlg.showModal();
    return;
  }

  const e = hits[0];
  const isNew = !progress.found.includes(e.id);
  if (isNew) {
    progress.found.push(e.id);
    saveProgress(S.id, progress);
  }
  dlg.innerHTML = `
    <div class="dlg-card">
      <p class="badge ${isNew ? 'new' : ''}">${isNew ? 'Нова кінцівка!' : 'Ця кінцівка вже відкрита'}${e.hidden ? ' · секретна' : ''}</p>
      <h2>🎬 ${esc(e.title)}</h2>
      ${e.text ? `<p>${esc(e.text)}</p>` : ''}
      <p class="count-line">Відкрито кінцівок: ${progress.found.length} з ${total}</p>
      <form method="dialog"><button class="btn primary">Гаразд</button></form>
    </div>`;
  dlg.showModal();
  renderEndings();
}

/* ───────────────────────── Події ───────────────────────── */

app.addEventListener('click', (ev) => {
  if (!S) return;
  const t = ev.target;

  const item = t.closest('.item');
  if (item) {
    const sel = { type: item.dataset.type, id: item.dataset.id };
    const same = S.selected && S.selected.type === sel.type && S.selected.id === sel.id;
    S.selected = same ? null : sel;
    renderTray();
    renderStrip();
    return;
  }

  const slotEl = t.closest('[data-slot]');
  const frameEl = t.closest('.frame');
  if (slotEl && frameEl) {
    onSlotClick(Number(frameEl.dataset.frame), slotEl.dataset.slot, Number(slotEl.dataset.k));
    return;
  }

  if (t.closest('#play')) return playMovie();

  if (t.closest('#clear')) {
    S.frames.forEach((f) => { f.setting = null; f.chars.fill(null); });
    S.selected = null;
    renderStrip();
    renderTray();
    return;
  }

  if (t.closest('#reset')) {
    if (confirm('Скинути відкриті кінцівки цього рівня?')) {
      saveProgress(S.id, { found: [] });
      renderEndings();
    }
  }
});

/* Перетягування мишею (на дотикових екранах працює вибір дотиком). */
let dragged = null;

app.addEventListener('dragstart', (ev) => {
  const item = ev.target.closest?.('.item');
  if (!item || !S) return;
  dragged = { type: item.dataset.type, id: item.dataset.id };
  ev.dataTransfer.setData('text/plain', `${dragged.type}:${dragged.id}`);
  ev.dataTransfer.effectAllowed = 'copy';
});

app.addEventListener('dragover', (ev) => {
  const frame = ev.target.closest?.('.frame');
  if (!frame || !dragged) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'copy';
  frame.classList.add('drag-over');
});

app.addEventListener('dragleave', (ev) => {
  const frame = ev.target.closest?.('.frame');
  if (frame && !frame.contains(ev.relatedTarget)) frame.classList.remove('drag-over');
});

app.addEventListener('drop', (ev) => {
  const frame = ev.target.closest?.('.frame');
  if (!frame || !dragged || !S) return;
  ev.preventDefault();
  frame.classList.remove('drag-over');
  const slotEl = ev.target.closest('.cslot');
  place(Number(frame.dataset.frame), dragged, slotEl && dragged.type === 'char' ? Number(slotEl.dataset.k) : null);
  dragged = null;
  S.selected = null;
  renderStrip();
  renderTray();
});

app.addEventListener('dragend', () => {
  dragged = null;
  document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && S?.selected) {
    S.selected = null;
    renderTray();
    renderStrip();
  }
});

dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });

/* ───────────────────────── Маршрутизація ───────────────────────── */

async function route() {
  const m = location.hash.match(/^#\/level\/([^/?#]+)/);
  if (m) await showLevel(decodeURIComponent(m[1]));
  else await showCatalog();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
