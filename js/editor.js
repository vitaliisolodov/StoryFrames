// Візуальний редактор рівнів: збирає level.json у форматі гри.
// Перевірки дзеркалять scripts/build-index.mjs, а пробний запуск використовує js/logic.js.

import { matchEndings, captionFor, normalizeLevel, reqSpecificity } from './logic.js';

const DRAFT_KEY = 'kadry-editor-draft';
const SECTIONS = [
  ['main', 'Основне'],
  ['frames', 'Кадри'],
  ['characters', 'Персонажі'],
  ['settings', 'Декорації'],
  ['endings', 'Кінцівки'],
  ['captions', 'Підписи'],
  ['play', 'Пробний запуск'],
];

/* ───────────────────────── утиліти ───────────────────────── */

const $ = (s, r = document) => r.querySelector(s);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  const props = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled'].includes(k)) props[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (k) => {
    if (k == null || k === false) return;
    if (Array.isArray(k)) k.forEach(add);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  Object.assign(el, props); // value після <option>, щоб select вибрав правильний пункт
  return el;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, bad ? 5000 : 2400);
}

const TR = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'io', ъ: '', ь: '', '’': '', "'": '', 'ʼ': '',
};
const slug = (s) =>
  [...String(s).toLowerCase()].map((c) => TR[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function uniqueId(base, taken, fallback) {
  const b = slug(base) || fallback;
  let id = b;
  for (let n = 2; taken.has(id); n++) id = `${b}-${n}`;
  return id;
}

const isRemote = (s) => /^(https?:|data:)/.test(s);
const slots = () => Math.min(3, Math.max(1, Number(L.charSlots) || 2));
const nameOf = (list, id) => { const it = list.find((x) => x.id === id); return it ? it.name || it.id : id; };
const frameLabel = (i) => { const t = (L.frames[i]?.title || '').trim(); return !t || t === `Кадр ${i + 1}` ? `Кадр ${i + 1}` : `Кадр ${i + 1} · ${t}`; };
const emojiOf = (it) => (it?.emoji || (it?.image ? '🖼️' : '❔'));

/* ───────────────────────── стан ───────────────────────── */

let L;                        // поточний рівень (робоча модель)
let section = 'main';
let selEnding = 0;
let play = [];                // стан «пробного запуску»
let folder = '';
let folderAuto = true;
const autoIds = new WeakSet(); // елементи, у яких id ще слідкує за назвою
const assets = new Map();      // шлях у папці рівня → File (картинки, додані в редакторі)
const urlCache = new Map();    // шлях → blob:-посилання для попереднього перегляду
let remoteBase = '';           // 'levels/<id>/', якщо рівень відкрито з сайту (картинки вже лежать там)
let env = { mode: 'download', info: null }; // 'server' | 'fsa' | 'download'
let commitMsg = '';
let commitAuto = true;

const grad = (a, b) => `linear-gradient(160deg,${a},${b})`;

function starter() {
  return {
    title: 'Мій перший рівень',
    description: '',
    howto: '',
    author: '',
    difficulty: 1,
    order: 100,
    icon: '🎞️',
    charSlots: 2,
    hint: '',
    frames: [{ title: 'Кадр 1' }, { title: 'Кадр 2' }, { title: 'Кадр 3' }],
    characters: [
      { id: 'hero', name: 'Герой', emoji: '🦸' },
      { id: 'villain', name: 'Лиходій', emoji: '🦹' },
    ],
    settings: [
      { id: 'city', name: 'Місто', emoji: '🏙️', color: grad('#3b4a7a', '#1f2644') },
      { id: 'roof', name: 'Дах', emoji: '🌃', color: grad('#5a3b7a', '#24143a') },
    ],
    captions: [],
    endings: [{ id: 'good', title: 'Хороша кінцівка', text: '', frames: [null, null, null] }],
  };
}

/** Приймає довільний (завантажений) level.json і доводить до робочої моделі. */
function adopt(raw) {
  const o = structuredClone(raw);
  o.title = o.title ?? '';
  o.frames = (Array.isArray(o.frames) ? o.frames : []).map((f) =>
    typeof f === 'string' ? { title: f } : { ...f, title: f?.title ?? '' });
  o.characters = Array.isArray(o.characters) ? o.characters : [];
  o.settings = Array.isArray(o.settings) ? o.settings : [];
  o.captions = Array.isArray(o.captions) ? o.captions : [];
  o.endings = (Array.isArray(o.endings) ? o.endings : []).map((e) => {
    const fr = Array.isArray(e.frames) ? e.frames.map((r) => (r && (r.setting || r.characters?.length || r.exact) ? r : null)) : [];
    while (fr.length < o.frames.length) fr.push(null);
    return { ...e, frames: fr };
  });
  return o;
}

function setLevel(next, opts = {}) {
  L = next;
  selEnding = 0;
  play = [];
  for (const u of urlCache.values()) URL.revokeObjectURL(u);
  urlCache.clear();
  assets.clear();
  for (const [k, f] of opts.assets || []) assets.set(k, f);
  remoteBase = opts.remoteBase || '';
  folder = opts.folder ?? (slug(L.title) || 'my-level');
  folderAuto = opts.folder == null;
  commitAuto = true;
  render();
}

/* ───────────────────────── експорт у JSON ───────────────────────── */

const isEmpty = (v) => v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);

/** Копія з потрібним порядком ключів; порожні значення відкидаються, невідомі ключі зберігаються. */
function pick(obj, order) {
  const out = {};
  for (const k of order) if (!isEmpty(obj[k])) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!order.includes(k) && !isEmpty(obj[k])) out[k] = obj[k];
  return out;
}

function cleanReq(r) {
  if (!r) return null;
  const o = pick(r, ['setting', 'characters', 'exact']);
  return Object.keys(o).length ? o : null;
}

function serialize() {
  const { frames, characters, settings, captions, endings, ...head } = L;
  const o = { title: L.title || '', ...pick(head, ['title', 'description', 'howto', 'author', 'difficulty', 'order', 'icon', 'cover', 'charSlots', 'hint']) };
  o.frames = frames.map((f, i) => {
    const { title, ...rest } = f;
    return { title: (title || '').trim() || `Кадр ${i + 1}`, ...pick(rest, []) };
  });
  o.characters = characters.map((c) => pick(c, ['id', 'name', 'emoji', 'image']));
  o.settings = settings.map((s) => pick(s, ['id', 'name', 'emoji', 'image', 'color']));
  if (captions.length) o.captions = captions.map((c) => pick(c, ['frame', 'setting', 'characters', 'text']));
  o.endings = endings.map((e) => {
    const { frames: ef, ...rest } = e;
    return { ...pick(rest, ['id', 'title', 'text', 'clue', 'hidden']), frames: ef.map(cleanReq) };
  });
  return o;
}

const json = () => JSON.stringify(serialize(), null, 2) + '\n';

/* ───────────────────────── перевірка (дзеркало build-index.mjs) ───────────────────────── */

function validate() {
  const out = [];
  const err = (sec, msg, where) => out.push({ lvl: 'error', sec, msg, where });
  const warn = (sec, msg, where) => out.push({ lvl: 'warn', sec, msg, where });

  if (!L.title.trim()) err('main', 'Немає назви рівня');
  if (!L.frames.length) err('frames', 'Потрібен хоча б один кадр');
  if (!L.characters.length) err('characters', 'Потрібен хоча б один персонаж');
  if (!L.settings.length) err('settings', 'Потрібна хоча б одна декорація');
  if (!L.endings.length) err('endings', 'Потрібна хоча б одна кінцівка');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(folder)) err('side', 'Назва папки: латиниця, цифри, «-» і «_»; не може починатися з «_» чи «.»');

  const ids = (arr, sec, label) => {
    const seen = new Set();
    arr.forEach((it, i) => {
      if (!it.id) { err(sec, `${label} №${i + 1}: порожній id`); return; }
      if (seen.has(it.id)) err(sec, `${label}: id «${it.id}» повторюється`);
      seen.add(it.id);
    });
    return seen;
  };
  const chars = ids(L.characters, 'characters', 'Персонажі');
  const sets = ids(L.settings, 'settings', 'Декорації');
  ids(L.endings, 'endings', 'Кінцівки');

  for (const [sec, arr] of [['characters', L.characters], ['settings', L.settings]]) {
    arr.forEach((it) => {
      if (!it.name?.trim()) err(sec, `«${it.id || '?'}»: немає назви`);
      if (!it.emoji && !it.image) err(sec, `«${it.name || it.id}»: потрібні емодзі або картинка`);
    });
  }

  const checkReq = (sec, where, r) => {
    if (!r) return;
    if (r.setting && !sets.has(r.setting)) err(sec, `${where}: невідома декорація «${r.setting}»`);
    for (const c of r.characters || []) if (!chars.has(c)) err(sec, `${where}: невідомий персонаж «${c}»`);
    if ((r.characters || []).length > slots()) {
      warn(sec, `${where}: вимагає ${r.characters.length} персонажів, а в кадрі лише ${slots()} місць — недосяжно`);
    }
  };

  const seenSig = new Map();
  L.endings.forEach((e) => {
    const nm = e.title || e.id || '?';
    if (!e.title?.trim()) err('endings', `Кінцівка «${e.id}»: немає назви`);
    if (e.frames.length > L.frames.length) {
      err('endings', `Кінцівка «${nm}»: умов ${e.frames.length}, а кадрів ${L.frames.length}`);
    }
    e.frames.forEach((r, i) => checkReq('endings', `Кінцівка «${nm}», кадр ${i + 1}`, r));
    if (e.frames.every((r) => !cleanReq(r))) warn('endings', `Кінцівка «${nm}» без жодної умови підходить до будь-якої розстановки`);
    const sig = JSON.stringify(e.frames.map((r) => { const c = cleanReq(r); return c && { ...c, characters: c.characters && [...c.characters].sort() }; }));
    if (seenSig.has(sig)) warn('endings', `Кінцівки «${seenSig.get(sig)}» і «${nm}» мають однакові умови`);
    else seenSig.set(sig, nm);
  });

  L.captions.forEach((c, n) => {
    if (!Number.isInteger(c.frame) || c.frame < 0 || c.frame >= L.frames.length) {
      err('captions', `Підпис ${n + 1}: «frame» має бути від 0 до ${L.frames.length - 1}`);
    }
    checkReq('captions', `Підпис ${n + 1}`, cleanReq(c));
    if (!c.text?.trim()) warn('captions', `Підпис ${n + 1}: порожній текст`);
  });

  const used = new Set();
  L.endings.forEach((e) => e.frames.forEach((r) => (r?.characters || []).forEach((c) => used.add(c))));
  L.characters.forEach((c) => {
    if (c.id && !used.has(c.id)) warn('characters', `«${c.name || c.id}» не потрібен жодній кінцівці`);
  });

  const seenImg = new Set();
  for (const [o, k] of allImageSlots()) {
    const f = o[k];
    if (!f || isRemote(f) || seenImg.has(f)) continue;
    seenImg.add(f);
    const a = assets.get(f);
    const sec = o === L ? 'main' : L.characters.includes(o) ? 'characters' : 'settings';
    if (!a && !remoteBase) warn(sec, `Файл «${f}» не додано в редактор: перетягніть його або покладіть у папку рівня вручну`);
    else if (a && a.size > 1.5 * 1048576) warn(sec, `Картинка «${f}» важить ${(a.size / 1048576).toFixed(1)} МБ — рівень вантажитиметься повільно`);
    if (/[^A-Za-z0-9._\/-]/.test(f)) warn(sec, `Назва файлу «${f}» містить пробіли або не-латинські символи — краще без них`);
  }

  return out;
}

/* ───────────────────────── зміни моделі ───────────────────────── */

let saveTimer;
function changed() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ L, folder, folderAuto })); } catch { /* приватний режим тощо */ }
  }, 400);
  refreshSide();
}

function renameRefs(kind, from, to) {
  const key = kind === 'characters' ? 'characters' : 'setting';
  const fix = (r) => {
    if (!r) return;
    if (key === 'characters') { if (r.characters) r.characters = r.characters.map((c) => (c === from ? to : c)); }
    else if (r.setting === from) r.setting = to;
  };
  L.endings.forEach((e) => e.frames.forEach(fix));
  L.captions.forEach(fix);
  play.forEach((p) => {
    if (key === 'characters') p.chars = p.chars.map((c) => (c === from ? to : c));
    else if (p.setting === from) p.setting = to;
  });
}

function countRefs(kind, id) {
  let n = 0;
  const hit = (r) => { if (kind === 'characters' ? r?.characters?.includes(id) : r?.setting === id) n++; };
  L.endings.forEach((e) => e.frames.forEach(hit));
  L.captions.forEach(hit);
  return n;
}

function purgeRefs(kind, id) {
  const fix = (r) => {
    if (!r) return r;
    if (kind === 'characters') r.characters = (r.characters || []).filter((c) => c !== id);
    else if (r.setting === id) delete r.setting;
    return r;
  };
  L.endings.forEach((e) => { e.frames = e.frames.map((r) => cleanReq(fix(r))); });
  L.captions.forEach(fix);
  L.captions = L.captions.filter((c) => cleanReq(c));
}

function move(arr, i, d) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return false;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return true;
}

/* ───────────────────────── поля форми ───────────────────────── */

function field(label, control, hint, cls = '') {
  return h('label', { class: `field ${cls}` }, h('span', { class: 'lbl' }, label), control, hint ? h('small', null, hint) : null);
}

function fieldBox(label, node, hint, cls = '') {
  return h('div', { class: `field ${cls}` }, h('span', { class: 'lbl' }, label), node, hint ? h('small', null, hint) : null);
}

function inp(obj, key, o = {}) {
  const el = h('input', {
    type: o.type || 'text', class: o.cls || '', placeholder: o.ph || '', value: obj[key] ?? '',
    min: o.min, max: o.max, autocomplete: 'off', spellcheck: o.spell === false ? 'false' : null,
    maxlength: o.maxlength,
  });
  el.addEventListener('input', () => {
    obj[key] = o.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
    o.on?.(el.value, el);
    changed();
  });
  return el;
}

function area(obj, key, rows = 2, ph = '') {
  const el = h('textarea', { rows, placeholder: ph, value: obj[key] ?? '' });
  el.addEventListener('input', () => { obj[key] = el.value; changed(); });
  return el;
}

function segmented(values, current, onPick, label) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const paint = (v) => [...wrap.children].forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === v)));
  values.forEach(([v, text]) => wrap.append(h('button', { type: 'button', 'data-v': v, onclick: () => { onPick(v); paint(v); changed(); } }, text)));
  paint(current);
  return wrap;
}

/* ───────────────────────── картинки ───────────────────────── */

const IMG_RE = /\.(png|jpe?g|webp|gif|svg|avif)$/i;
const isImageFile = (f) => /^image\/(png|jpeg|webp|gif|svg\+xml|avif)$/.test(f.type) || IMG_RE.test(f.name);
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);

/** Усі місця, де в рівні може бути посилання на картинку: [обʼєкт, ключ]. */
const allImageSlots = (lvl = L) => [[lvl, 'cover'], ...lvl.characters.map((c) => [c, 'image']), ...lvl.settings.map((s) => [s, 'image'])];
const imageRefs = () => [...new Set(allImageSlots().map(([o, k]) => o[k]).filter((f) => f && !isRemote(f)))];
const nameInUse = (name, exceptObj, exceptKey) =>
  allImageSlots().some(([o, k]) => !(o === exceptObj && k === exceptKey) && o[k] === name);

function assetUrl(name) {
  if (!name) return '';
  if (isRemote(name)) return name;
  if (assets.has(name)) {
    if (!urlCache.has(name)) urlCache.set(name, URL.createObjectURL(assets.get(name)));
    return urlCache.get(name);
  }
  return remoteBase ? remoteBase + name.split('/').map(encodeURIComponent).join('/') : '';
}
const cssUrl = (u) => `url("${u.replace(/"/g, '%22')}")`;

function dropAsset(name) {
  assets.delete(name);
  if (urlCache.has(name)) { URL.revokeObjectURL(urlCache.get(name)); urlCache.delete(name); }
}

/** Додає файл у рівень: безпечне імʼя, без колізій, старий непотрібний файл прибирається. */
function ingestImage(file, obj, key) {
  if (!isImageFile(file)) { toast('Це не картинка. Підходять PNG, JPG, WebP, GIF, SVG', true); return false; }
  const m = file.name.match(/\.([^.]+)$/);
  const ext = (m ? m[1] : file.type.split('/')[1] || 'png').toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const base = slug(file.name.replace(/\.[^.]+$/, '')) || 'image';
  let name = `${base}.${ext}`;
  for (let n = 2; nameInUse(name, obj, key); n++) name = `${base}-${n}.${ext}`;
  const old = obj[key];
  dropAsset(name);
  assets.set(name, file);
  obj[key] = name;
  if (old && old !== name && assets.has(old) && !nameInUse(old)) dropAsset(old);
  return true;
}

/** Робить елемент зоною, куди можна скинути файли. */
function dropTarget(el, onFiles) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; el.classList.add('dragover'); });
  el.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('dragover'); });
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    el.classList.remove('dragover');
    onFiles([...e.dataTransfer.files]);
  });
}

/**
 * Поле картинки: перетягування, кнопка «Обрати файл…», вставка Ctrl+V, ручне імʼя файлу.
 * Повертає елемент із методами .take(files) і .repaint().
 */
function imageField(obj, key, onChange) {
  const thumb = h('div', { class: 'drop-thumb', 'aria-hidden': 'true' });
  const info = h('span', { class: 'drop-info' });
  const nameEl = h('input', { type: 'text', class: 'mono', value: obj[key] ?? '', placeholder: 'файл.png', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Шлях до картинки' });
  const picker = h('input', { type: 'file', accept: 'image/*', hidden: true, onclick: (e) => e.stopPropagation() });
  const clear = h('button', { class: 'iconbtn danger', type: 'button', title: 'Прибрати картинку', onclick: () => setName('') }, '✕');
  let committed = obj[key] || '';

  const box = h('div', { class: 'drop', tabindex: '0' }, thumb,
    h('div', { class: 'drop-body' },
      h('div', { class: 'drop-hint' }, 'Перетягніть картинку сюди або вставте через Ctrl+V'),
      h('div', { class: 'row-gap' }, nameEl, clear),
      h('div', { class: 'row-gap' }, h('button', { class: 'btn small', type: 'button', onclick: () => picker.click() }, 'Обрати файл…'), info)),
    picker);

  function paint() {
    const v = obj[key] || '';
    const u = assetUrl(v);
    thumb.style.backgroundImage = u ? cssUrl(u) : '';
    thumb.textContent = u ? '' : '🖼️';
    clear.hidden = !v;
    let warn = false;
    if (!v) info.textContent = 'файл не вибрано';
    else if (assets.has(v)) info.textContent = `${kb(assets.get(v).size)} · буде скопійовано в папку рівня`;
    else if (isRemote(v)) info.textContent = 'зовнішнє посилання';
    else if (remoteBase) info.textContent = 'файл уже лежить у папці рівня';
    else { info.textContent = '⚠ файл не додано — перетягніть його сюди'; warn = true; }
    info.classList.toggle('bad', warn);
  }
  function setName(v) {
    const old = obj[key] || '';
    obj[key] = v;
    if (old && old !== v && assets.has(old) && !nameInUse(old)) dropAsset(old);
    committed = v;
    nameEl.value = v;
    paint();
    onChange?.();
    changed();
  }
  function take(files) {
    const imgs = files.filter(isImageFile);
    if (!imgs.length) { toast('Це не картинка. Підходять PNG, JPG, WebP, GIF, SVG', true); return; }
    if (imgs.length > 1) toast('Взято лише перший файл — для кількох скористайтеся зоною внизу списку');
    if (ingestImage(imgs[0], obj, key)) { committed = obj[key]; nameEl.value = obj[key]; paint(); onChange?.(); changed(); }
  }

  nameEl.addEventListener('input', () => { obj[key] = nameEl.value; paint(); onChange?.(); changed(); });
  nameEl.addEventListener('change', () => { // перейменування файлу, доданого в редакторі
    const v = obj[key] || '';
    if (v && committed !== v && assets.has(committed) && !assets.has(v) && !nameInUse(committed, obj, key)) {
      assets.set(v, assets.get(committed));
      dropAsset(committed);
    }
    committed = v;
    paint();
    onChange?.();
    changed();
  });
  picker.addEventListener('change', () => { take([...picker.files]); picker.value = ''; });
  box.addEventListener('paste', (e) => {
    const fs = [...(e.clipboardData?.files || [])];
    if (fs.length) { e.preventDefault(); take(fs); }
  });
  dropTarget(box, take);
  paint();
  box.take = take;
  box.repaint = () => { committed = obj[key] || ''; nameEl.value = committed; paint(); };
  return box;
}

const humanize = (fn) => {
  const s = fn.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Без назви';
};

/** Кілька картинок одразу → по персонажу (або декорації) на кожну. */
function bulkAdd(kind, files) {
  const imgs = files.filter(isImageFile);
  if (!imgs.length) { toast('Перетягніть файли PNG, JPG, WebP, GIF або SVG', true); return; }
  const isSet = kind === 'settings';
  for (const f of imgs) {
    const name = humanize(f.name);
    const it = { id: uniqueId(name, new Set(L[kind].map((x) => x.id)), isSet ? 'setting' : 'character'), name };
    L[kind].push(it);
    ingestImage(f, it, 'image');
  }
  toast(`Додано: ${imgs.length}`);
  rerender();
}

/* ───────────────────────── вкладки ───────────────────────── */

function renderTabs() {
  const issues = validate();
  const counts = { frames: L.frames.length, characters: L.characters.length, settings: L.settings.length, endings: L.endings.length, captions: L.captions.length };
  const tabs = $('#tabs');
  tabs.replaceChildren(...SECTIONS.map(([id, label]) => {
    const here = issues.filter((i) => i.sec === id);
    const hasErr = here.some((i) => i.lvl === 'error');
    return h('button', {
      type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(section === id),
      onclick: () => go(id),
    },
    label,
    counts[id] != null ? h('span', { class: 'n' }, counts[id]) : null,
    here.length ? h('span', { class: 'dot' + (hasErr ? '' : ' warn'), title: here.length + ' зауваж.' }) : null);
  }));
}

function go(id) {
  section = id;
  renderTabs();
  renderPane();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ───────────────────────── панелі розділів ───────────────────────── */

function renderPane() {
  const pane = $('#pane');
  const map = { main: paneMain, frames: paneFrames, characters: () => paneItems('characters'), settings: () => paneItems('settings'), endings: paneEndings, captions: paneCaptions, play: panePlay };
  pane.replaceChildren(map[section]());
}

function head(title, lead) {
  return [h('h2', null, title), h('p', { class: 'lead' }, lead)];
}

/* ── Основне ── */
function paneMain() {
  return h('div', { class: 'form' },
    ...head('Основне', 'Те, що бачить гравець у каталозі та на початку рівня.'),
    field('Назва рівня *', inp(L, 'title', {
      ph: 'Наприклад: Зрада в замку',
      on: (v) => { if (folderAuto) { folder = slug(v) || 'my-level'; syncFolderInput(); } },
    })),
    field('Опис для каталогу', area(L, 'description', 2, 'Одне-два речення про сюжет')),
    field('Підказка по керуванню (необов’язково)', area(L, 'howto', 2, 'Показується гравцеві на цьому рівні')),
    h('div', { class: 'cols' },
      field('Автор', inp(L, 'author')),
      field('Іконка картки (емодзі)', inp(L, 'icon', { cls: 'emoji-in', maxlength: 8 }), 'Win + . відкриває вибір емодзі.')),
    fieldBox('Обкладинка картки (необов’язково)', imageField(L, 'cover'), 'Показується на картці рівня в каталозі. Якщо порожньо — береться іконка.'),
    h('div', { class: 'cols' },
      field('Складність', segmented([[1, '★'], [2, '★★'], [3, '★★★']], Number(L.difficulty) || 1, (v) => { L.difficulty = v; }, 'Складність')),
      field('Персонажів у кадрі', segmented([[1, '1'], [2, '2'], [3, '3']], slots(), (v) => { L.charSlots = v; }, 'Місць для персонажів'), 'Скільки персонажів гравець може поставити в один кадр.'),
      field('Порядок у каталозі', inp(L, 'order', { type: 'number' }), 'Менше число — раніше.')),
    field('Підказка, коли нічого не збіглося', area(L, 'hint', 2, 'Показується, якщо розстановка не підходить жодній кінцівці')));
}

/* ── Кадри ── */
function paneFrames() {
  const box = h('div', { class: 'stack' });
  L.frames.forEach((f, i) => {
    box.append(h('div', { class: 'ed-item', style: 'grid-template-columns: 44px minmax(0,1fr) auto' },
      h('div', { class: 'ed-tile', style: 'width:44px;height:44px;font-size:1.1rem;font-weight:700' }, i + 1),
      field('Заголовок кадру', inp(f, 'title', { ph: `Кадр ${i + 1}` })),
      h('div', { class: 'item-actions', style: 'flex-direction:row' },
        h('button', { class: 'iconbtn', type: 'button', title: 'Вгору', disabled: i === 0, onclick: () => moveFrame(i, -1) }, '↑'),
        h('button', { class: 'iconbtn', type: 'button', title: 'Вниз', disabled: i === L.frames.length - 1, onclick: () => moveFrame(i, 1) }, '↓'),
        h('button', { class: 'iconbtn danger', type: 'button', title: 'Видалити', disabled: L.frames.length <= 1, onclick: () => removeFrame(i) }, '✕'))));
  });
  return h('div', null,
    ...head('Кадри', 'Стрічка історії: у кожному кадрі гравець ставить декорацію та персонажів. Кінцівки й підписи прив’язані до номера кадру.'),
    box,
    h('div', { class: 'add-row' }, h('button', { class: 'btn', type: 'button', disabled: L.frames.length >= 8, onclick: addFrame }, '＋ Додати кадр')));
}

function addFrame() {
  L.frames.push({ title: `Кадр ${L.frames.length + 1}` });
  L.endings.forEach((e) => e.frames.push(null));
  rerender();
}
function removeFrame(i) {
  const bound = L.captions.filter((c) => c.frame === i).length;
  const reqs = L.endings.filter((e) => cleanReq(e.frames[i])).length;
  if ((bound || reqs) && !confirm(`Кадр ${i + 1} використовується: умов у кінцівках — ${reqs}, підписів — ${bound}. Видалити разом із ними?`)) return;
  L.frames.splice(i, 1);
  L.endings.forEach((e) => e.frames.splice(i, 1));
  L.captions = L.captions.filter((c) => c.frame !== i).map((c) => (c.frame > i ? { ...c, frame: c.frame - 1 } : c));
  rerender();
}
function moveFrame(i, d) {
  if (!move(L.frames, i, d)) return;
  L.endings.forEach((e) => move(e.frames, i, d));
  L.captions.forEach((c) => { if (c.frame === i) c.frame = i + d; else if (c.frame === i + d) c.frame = i; });
  rerender();
}

/* ── Персонажі й декорації ── */
function paneItems(kind) {
  const isSet = kind === 'settings';
  const list = L[kind];
  const box = h('div', { class: 'stack' });
  list.forEach((it, i) => box.append(itemCard(kind, it, i)));
  if (!list.length) box.append(h('p', { class: 'empty' }, isSet ? 'Декорацій ще немає.' : 'Персонажів ще немає.'));

  const bulkInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onclick: (e) => e.stopPropagation() });
  bulkInput.addEventListener('change', () => { bulkAdd(kind, [...bulkInput.files]); bulkInput.value = ''; });
  const bulk = h('div', { class: 'bulk-drop', tabindex: '0', role: 'button', onclick: () => bulkInput.click() },
    `📥 Перетягніть сюди одну чи кілька картинок: кожна стане ${isSet ? 'новою декорацією' : 'новим персонажем'}. Або натисніть, щоб обрати файли.`, bulkInput);
  bulk.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bulkInput.click(); } });
  dropTarget(bulk, (files) => bulkAdd(kind, files));

  return h('div', null,
    ...head(isSet ? 'Декорації' : 'Персонажі', isSet
      ? 'Місця дії. У кожному кадрі може бути одна декорація. Без картинки показується емодзі на кольоровому тлі. Картинку можна скинути просто на картку.'
      : 'Те, що гравець розставляє по кадрах. Без картинки показується емодзі. Картинку можна скинути просто на картку.'),
    box,
    h('div', { class: 'add-row' }, h('button', { class: 'btn', type: 'button', onclick: () => addItem(kind) }, isSet ? '＋ Додати декорацію' : '＋ Додати персонажа')),
    h('div', { style: 'margin-top:14px' }, bulk));
}

function addItem(kind) {
  const isSet = kind === 'settings';
  const name = isSet ? 'Нова декорація' : 'Новий персонаж';
  const it = { id: uniqueId(name, new Set(L[kind].map((x) => x.id)), isSet ? 'setting' : 'character'), name, emoji: isSet ? '🖼️' : '🙂' };
  if (isSet) it.color = grad('#3b4a7a', '#1f2644');
  autoIds.add(it);
  L[kind].push(it);
  rerender();
  const names = document.querySelectorAll('#pane .ed-item input[data-role="name"]');
  const last = names[names.length - 1];
  last?.focus();
  last?.select();
}

function itemCard(kind, it, i) {
  const isSet = kind === 'settings';
  const list = L[kind];
  const tile = h('div', { class: 'ed-tile' });
  const paintTile = () => {
    const u = it.image ? assetUrl(it.image) : '';
    tile.textContent = u ? '' : it.image ? '🖼️' : it.emoji || '';
    tile.style.background = u ? `${cssUrl(u)} center / cover no-repeat` : isSet && it.color ? it.color : '';
  };

  const idEl = h('input', { type: 'text', class: 'mono', value: it.id, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'id' });
  const commitId = (next) => {
    if (next === it.id) return;
    renameRefs(kind, it.id, next);
    it.id = next;
  };
  idEl.addEventListener('input', () => {
    const v = idEl.value.replace(/[^A-Za-z0-9_-]/g, '');
    if (v !== idEl.value) idEl.value = v;
    const clash = !v || list.some((x) => x !== it && x.id === v);
    idEl.classList.toggle('bad', clash);
    if (clash) return;
    autoIds.delete(it);
    commitId(v);
    changed();
  });
  idEl.addEventListener('blur', () => { idEl.value = it.id; idEl.classList.remove('bad'); });

  const nameEl = inp(it, 'name', {
    ph: isSet ? 'Замок' : 'Король',
    on: (v) => {
      if (!autoIds.has(it)) return;
      const next = uniqueId(v, new Set(list.filter((x) => x !== it).map((x) => x.id)), isSet ? 'setting' : 'character');
      commitId(next);
      idEl.value = it.id;
    },
  });
  nameEl.dataset.role = 'name';

  let colorText;
  const gradInputs = (() => {
    if (!isSet) return null;
    const hex = (it.color || '').match(/#[0-9a-f]{6}/gi) || [];
    const a = h('input', { type: 'color', value: hex[0] || '#3b4a7a', 'aria-label': 'Колір зверху' });
    const b = h('input', { type: 'color', value: hex[1] || hex[0] || '#1f2644', 'aria-label': 'Колір знизу' });
    const apply = () => { it.color = grad(a.value, b.value); colorText.value = it.color; paintTile(); changed(); };
    a.addEventListener('input', apply);
    b.addEventListener('input', apply);
    colorText = inp(it, 'color', { cls: 'mono', ph: 'linear-gradient(...) або #колір', spell: false, on: paintTile });
    return h('div', { class: 'row-gap' }, a, b, colorText);
  })();

  const imgField = imageField(it, 'image', paintTile);
  paintTile();

  const card = h('div', { class: 'ed-item' },
    tile,
    h('div', { class: 'item-fields' },
      field('Назва', nameEl),
      field('Емодзі', inp(it, 'emoji', { cls: 'emoji-in', maxlength: 12, on: paintTile })),
      field('id', idEl),
      isSet ? field('Тло для емодзі', gradInputs, null, 'wide') : null,
      fieldBox('Картинка (необов’язково)', imgField, 'Якщо задана — показується замість емодзі.', 'wide')),
    h('div', { class: 'item-actions' },
      h('button', { class: 'iconbtn', type: 'button', title: 'Вгору', disabled: i === 0, onclick: () => { move(list, i, -1); rerender(); } }, '↑'),
      h('button', { class: 'iconbtn', type: 'button', title: 'Вниз', disabled: i === list.length - 1, onclick: () => { move(list, i, 1); rerender(); } }, '↓'),
      h('button', { class: 'iconbtn danger', type: 'button', title: 'Видалити', onclick: () => removeItem(kind, it) }, '✕')));
  dropTarget(card, (files) => imgField.take(files));
  return card;
}

function removeItem(kind, it) {
  const n = countRefs(kind, it.id);
  if (n && !confirm(`«${it.name || it.id}» згадується в умовах (${n}). Видалити разом із цими умовами?`)) return;
  purgeRefs(kind, it.id);
  L[kind].splice(L[kind].indexOf(it), 1);
  rerender();
}

/* ── Редактор умов кадру (спільний для кінцівок і підписів) ── */
function reqEditor(req, set) {
  const cur = { setting: req?.setting || '', characters: [...(req?.characters || [])], exact: !!req?.exact };
  const status = h('span', { class: 'req-status' });
  const chips = h('div', { class: 'chips' });
  const exactBox = h('input', { type: 'checkbox', checked: cur.exact });

  const sel = h('select', { value: cur.setting, 'aria-label': 'Декорація', onchange: () => { cur.setting = sel.value; commit(); } },
    h('option', { value: '' }, 'Будь-яка декорація'),
    L.settings.map((s) => h('option', { value: s.id }, `${emojiOf(s)} ${s.name || s.id}`)),
    cur.setting && !L.settings.some((s) => s.id === cur.setting) ? h('option', { value: cur.setting }, `⚠ невідома: ${cur.setting}`) : null);
  sel.value = cur.setting;

  const known = new Set(L.characters.map((c) => c.id));
  const all = [...L.characters, ...cur.characters.filter((c) => !known.has(c)).map((id) => ({ id, name: id, emoji: '⚠', unknown: true }))];
  all.forEach((c) => {
    chips.append(h('button', {
      type: 'button', class: 'chip' + (c.unknown ? ' unknown' : ''), 'data-id': c.id,
      onclick: () => {
        cur.characters = cur.characters.includes(c.id) ? cur.characters.filter((x) => x !== c.id) : [...cur.characters, c.id];
        commit();
      },
    }, h('span', null, emojiOf(c)), c.name || c.id));
  });
  if (!all.length) chips.append(h('span', { class: 'muted' }, 'Спершу додайте персонажів'));

  exactBox.addEventListener('change', () => { cur.exact = exactBox.checked; commit(); });

  function paint() {
    [...chips.querySelectorAll('.chip')].forEach((b) => b.setAttribute('aria-pressed', String(cur.characters.includes(b.dataset.id))));
    const parts = [];
    if (cur.setting) parts.push(nameOf(L.settings, cur.setting));
    if (cur.characters.length) parts.push(cur.characters.map((c) => nameOf(L.characters, c)).join(' + '));
    if (cur.exact) parts.push(cur.characters.length ? 'лише вони' : 'без персонажів');
    status.textContent = parts.length ? parts.join(' · ') : 'не перевіряється (підійде будь-що)';
    status.classList.toggle('none', !parts.length);
  }
  function commit() {
    const r = {};
    if (cur.setting) r.setting = cur.setting;
    if (cur.characters.length) r.characters = [...cur.characters];
    if (cur.exact) r.exact = true;
    set(Object.keys(r).length ? r : null);
    paint();
    changed();
  }
  paint();

  return h('div', { class: 'req' },
    h('div', { class: 'req-head' }, status),
    sel,
    chips,
    h('label', { class: 'check' }, exactBox, 'Лише вибрані персонажі (нікого зайвого)'));
}

/* ── Кінцівки ── */
function paneEndings() {
  selEnding = Math.min(selEnding, L.endings.length - 1);
  const e = L.endings[selEnding];

  const list = h('div', { class: 'endlist' },
    L.endings.map((x, i) => h('button', { type: 'button', class: 'endbtn', 'aria-current': String(i === selEnding), onclick: () => { selEnding = i; renderPane(); } },
      h('span', { class: 't' }, (x.hidden ? '🔒 ' : '') + (x.title || x.id || 'Без назви')),
      h('span', { class: 's' }, x.frames.reduce((n, r) => n + reqSpecificity(cleanReq(r)), 0)))),
    h('button', { class: 'btn small', type: 'button', onclick: addEnding }, '＋ Нова кінцівка'));

  return h('div', null,
    ...head('Кінцівки', 'Для кожної кінцівки задайте, що має бути в кожному кадрі. Якщо підходить кілька — показується та, в якої більше умов (число праворуч у списку).'),
    h('div', { class: 'split' }, list, e ? endingEditor(e) : h('p', { class: 'empty' }, 'Додайте першу кінцівку.')));
}

function addEnding() {
  const title = 'Нова кінцівка';
  const e = { id: uniqueId(title, new Set(L.endings.map((x) => x.id)), 'ending'), title, text: '', frames: L.frames.map(() => null) };
  autoIds.add(e);
  L.endings.push(e);
  selEnding = L.endings.length - 1;
  rerender();
}

function endingEditor(e) {
  const idEl = h('input', { type: 'text', class: 'mono', value: e.id, autocomplete: 'off', spellcheck: 'false' });
  idEl.addEventListener('input', () => {
    const v = idEl.value.replace(/[^A-Za-z0-9_-]/g, '');
    if (v !== idEl.value) idEl.value = v;
    const clash = !v || L.endings.some((x) => x !== e && x.id === v);
    idEl.classList.toggle('bad', clash);
    if (clash) return;
    autoIds.delete(e);
    e.id = v;
    changed();
  });
  idEl.addEventListener('blur', () => { idEl.value = e.id; idEl.classList.remove('bad'); });

  const titleEl = inp(e, 'title', {
    ph: 'Справедливість',
    on: (v) => {
      const btn = document.querySelectorAll('.endbtn .t')[selEnding];
      if (btn) btn.textContent = (e.hidden ? '🔒 ' : '') + (v || e.id || 'Без назви');
      if (autoIds.has(e)) {
        e.id = uniqueId(v, new Set(L.endings.filter((x) => x !== e).map((x) => x.id)), 'ending');
        idEl.value = e.id;
      }
    },
  });

  const hidden = h('input', { type: 'checkbox', checked: !!e.hidden });
  hidden.addEventListener('change', () => { e.hidden = hidden.checked; renderPane(); changed(); });

  const i = selEnding;
  return h('div', { class: 'form' },
    h('div', { class: 'ed-bar' },
      h('button', { class: 'iconbtn', type: 'button', title: 'Вгору', disabled: i === 0, onclick: () => { move(L.endings, i, -1); selEnding = i - 1; rerender(); } }, '↑'),
      h('button', { class: 'iconbtn', type: 'button', title: 'Вниз', disabled: i === L.endings.length - 1, onclick: () => { move(L.endings, i, 1); selEnding = i + 1; rerender(); } }, '↓'),
      h('button', { class: 'btn small', type: 'button', onclick: () => duplicateEnding(e) }, 'Дублювати'),
      h('button', { class: 'btn small', type: 'button', onclick: () => { if (confirm(`Видалити кінцівку «${e.title || e.id}»?`)) { L.endings.splice(i, 1); selEnding = Math.max(0, i - 1); rerender(); } } }, 'Видалити')),
    h('div', { class: 'cols' }, field('Назва кінцівки', titleEl), field('id', idEl)),
    field('Що сталося', area(e, 'text', 3, 'Текст, який побачить гравець, коли відкриє цю кінцівку')),
    field('Натяк (необов’язково)', area(e, 'clue', 2, 'Показується, поки кінцівку не знайдено')),
    h('label', { class: 'check' }, hidden, 'Секретна: у списку показується як «???»'),
    h('h3', { style: 'margin-top:6px' }, 'Умови по кадрах'),
    ...L.frames.map((f, k) => h('div', { class: 'frame-req' },
      h('div', { class: 'req-head', style: 'margin-bottom:8px' }, h('strong', null, frameLabel(k))),
      reqEditor(e.frames[k], (r) => {
        e.frames[k] = r;
        const s = document.querySelectorAll('.endbtn .s')[selEnding];
        if (s) s.textContent = e.frames.reduce((n, q) => n + reqSpecificity(cleanReq(q)), 0);
      }))));
}

function duplicateEnding(e) {
  const copy = structuredClone(e);
  copy.title = (e.title || e.id) + ' (копія)';
  copy.id = uniqueId(e.id + '-copy', new Set(L.endings.map((x) => x.id)), 'ending');
  L.endings.splice(selEnding + 1, 0, copy);
  selEnding += 1;
  rerender();
}

/* ── Підписи ── */
function paneCaptions() {
  const box = h('div', { class: 'stack' });
  L.captions.forEach((c, n) => {
    const frameSel = h('select', { value: String(c.frame ?? 0), 'aria-label': 'Кадр', onchange: () => { c.frame = Number(frameSel.value); changed(); } },
      L.frames.map((f, i) => h('option', { value: i }, frameLabel(i))),
      Number.isInteger(c.frame) && c.frame >= L.frames.length ? h('option', { value: c.frame }, `⚠ кадру ${c.frame + 1} немає`) : null);
    frameSel.value = String(c.frame ?? 0);
    box.append(h('div', { class: 'frame-req' },
      h('div', { class: 'req-head', style: 'margin-bottom:8px' },
        h('strong', null, `Підпис ${n + 1}`),
        h('div', { class: 'row-gap' },
          h('button', { class: 'iconbtn', type: 'button', title: 'Вгору', disabled: n === 0, onclick: () => { move(L.captions, n, -1); rerender(); } }, '↑'),
          h('button', { class: 'iconbtn', type: 'button', title: 'Вниз', disabled: n === L.captions.length - 1, onclick: () => { move(L.captions, n, 1); rerender(); } }, '↓'),
          h('button', { class: 'iconbtn danger', type: 'button', title: 'Видалити', onclick: () => { L.captions.splice(n, 1); rerender(); } }, '✕'))),
      h('div', { class: 'form' },
        field('У кадрі', frameSel),
        reqEditor(c, (r) => { delete c.setting; delete c.characters; delete c.exact; if (r) Object.assign(c, r); }),
        field('Текст підпису', area(c, 'text', 2, 'Що відбувається в цьому кадрі')))));
  });
  if (!L.captions.length) box.append(h('p', { class: 'empty' }, 'Підписів ще немає — гра покаже кадри без тексту.'));
  return h('div', null,
    ...head('Підписи', 'Короткий текст під кадром, коли розстановка збігається з умовою. Якщо збігається кілька — береться найконкретніший.'),
    box,
    h('div', { class: 'add-row' }, h('button', { class: 'btn', type: 'button', onclick: () => { L.captions.push({ frame: 0, text: '' }); rerender(); } }, '＋ Додати підпис')));
}

/* ── Пробний запуск ── */
function syncPlay() {
  while (play.length < L.frames.length) play.push({ setting: '', chars: [] });
  play.length = L.frames.length;
  play.forEach((p) => {
    if (p.setting && !L.settings.some((s) => s.id === p.setting)) p.setting = '';
    p.chars = p.chars.filter((c) => L.characters.some((x) => x.id === c)).slice(0, slots());
  });
}

function panePlay() {
  syncPlay();
  const lvl = normalizeLevel(serialize());
  const states = play.map((p) => ({ setting: p.setting || null, characters: p.chars }));

  const frames = play.map((p, i) => {
    const sel = h('select', { value: p.setting, 'aria-label': 'Декорація', onchange: () => { p.setting = sel.value; renderPane(); } },
      h('option', { value: '' }, 'Без декорації'),
      L.settings.map((s) => h('option', { value: s.id }, `${emojiOf(s)} ${s.name || s.id}`)));
    sel.value = p.setting;
    const full = p.chars.length >= slots();
    const cap = captionFor(lvl, i, states[i]);
    return h('div', { class: 'play-frame' },
      h('strong', null, frameLabel(i)),
      sel,
      h('div', { class: 'chips' }, L.characters.map((c) => h('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(p.chars.includes(c.id)), disabled: full && !p.chars.includes(c.id),
        onclick: () => { p.chars = p.chars.includes(c.id) ? p.chars.filter((x) => x !== c.id) : [...p.chars, c.id]; renderPane(); },
      }, h('span', null, emojiOf(c)), c.name || c.id))),
      h('div', { class: 'play-cap' }, cap ? `«${cap}»` : ''));
  });

  const hits = matchEndings(lvl, play);
  const best = hits[0];
  const touched = play.some((p) => p.setting || p.chars.length);
  let result;
  if (!touched) result = h('div', { class: 'result' }, 'Розставте персонажів і декорації — і побачите, яка кінцівка спрацює.');
  else if (best) {
    result = h('div', { class: 'result ok' },
      h('h4', null, best.title, best.hidden ? h('span', { class: 'tag' }, 'секретна') : null),
      h('div', null, best.text || h('span', { class: 'muted' }, 'Текст кінцівки не заповнено')),
      hits.length > 1 ? h('p', { class: 'muted', style: 'margin:10px 0 0;font-size:.85rem' }, `Також підходять, але мають менше умов: ${hits.slice(1).map((x) => x.title).join(', ')}`) : null);
  } else {
    result = h('div', { class: 'result' }, h('strong', null, 'Жодна кінцівка не підійшла.'), h('p', { class: 'muted', style: 'margin:6px 0 0' }, L.hint ? `Гравець побачить підказку: «${L.hint}»` : 'Підказку (на вкладці «Основне») не заповнено.'));
  }

  return h('div', null,
    ...head('Пробний запуск', 'Зіграйте у власний рівень: розставте кадри так, як це зробив би гравець, і подивіться, яка кінцівка спрацює. Це ті самі правила, що й у грі.'),
    h('div', { class: 'stack' }, ...frames, result));
}

/* ───────────────────────── права панель ───────────────────────── */

function syncFolderInput() {
  const el = $('#folder');
  if (el && el !== document.activeElement) el.value = folder;
  const p = $('#path');
  if (p) p.textContent = `levels/${folder || '…'}/`;
}

const defaultMsg = () => `Новий рівень: ${L.title.trim() || folder}`;
const commitText = () => (commitAuto ? defaultMsg() : commitMsg);

function refreshSide() {
  renderTabs();
  const issues = validate();
  const errs = issues.filter((i) => i.lvl === 'error');
  const box = $('#issues');
  const label = Object.fromEntries(SECTIONS);
  box.replaceChildren(...(issues.length
    ? issues.map((i) => h('li', null, h('button', { type: 'button', class: 'issue ' + (i.lvl === 'warn' ? 'warn' : ''), onclick: () => i.sec !== 'side' && go(i.sec) },
      i.msg, i.sec !== 'side' ? h('small', null, label[i.sec]) : null)))
    : [h('li', { class: 'okline' }, '✔ Все гаразд — рівень пройде перевірку')]));
  $('#issues-title').textContent = errs.length ? `Помилки: ${errs.length}` : issues.length ? `Зауваження: ${issues.length}` : 'Перевірка';
  const hid = L.endings.filter((e) => e.hidden).length;
  $('#stats').textContent = `${L.frames.length} кадр. · ${L.characters.length} персонаж. · ${L.settings.length} декор. · ${L.endings.length} кінцівок${hid ? ` (${hid} секретні)` : ''}`;
  $('#json').textContent = json();
  syncFolderInput();
  refreshPublish();
}

function refreshPublish() {
  const list = $('#files');
  if (!list) return;
  const rows = [h('li', null, h('span', null, 'level.json'), h('span', { class: 'sz' }, kb(new Blob([json()]).size)))];
  for (const f of imageRefs()) {
    const a = assets.get(f);
    const ok = a || remoteBase;
    rows.push(h('li', { class: ok ? '' : 'miss' }, h('span', { title: f }, f), h('span', { class: 'sz' }, a ? kb(a.size) : remoteBase ? 'уже в проєкті' : '⚠ не додано')));
  }
  list.replaceChildren(...rows);
  const msgEl = $('#msg');
  if (msgEl && commitAuto && msgEl !== document.activeElement) msgEl.value = defaultMsg();
  $('#cmds').textContent = `git add levels/${folder}\ngit commit -m "${commitText().replace(/"/g, "'")}"\ngit push`;
}

/* ───────── дії публікації ───────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toBase64 = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1] || '');
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});

function log(...lines) {
  const el = $('#pub-log');
  el.textContent += (el.textContent ? '\n' : '') + lines.join('\n');
  el.scrollTop = el.scrollHeight;
}

async function act(btn, fn) {
  btn.disabled = true;
  try { await fn(); }
  catch (e) { if (e?.name !== 'AbortError') { log('✖ ' + e.message); toast(e.message, true); } }
  finally { btn.disabled = false; }
}

function warnIfErrors() {
  const n = validate().filter((i) => i.lvl === 'error').length;
  if (n) toast(`У рівні ${n} помилок — на сайті його буде пропущено, поки їх не виправлено`, true);
}

/** Файли рівня для запису: level.json і всі картинки, на які є посилання. */
async function gatherFiles() {
  const files = [{ path: 'level.json', blob: new Blob([json()], { type: 'application/json' }) }];
  const missing = [];
  for (const f of imageRefs()) {
    if (assets.has(f)) { files.push({ path: f, blob: assets.get(f) }); continue; }
    let ok = false;
    if (remoteBase) {
      try { const r = await fetch(assetUrl(f), { cache: 'no-store' }); if (r.ok) { files.push({ path: f, blob: await r.blob() }); ok = true; } } catch { /* немає */ }
    }
    if (!ok) missing.push(f);
  }
  return { files, missing };
}

function reportMissing(missing) {
  if (!missing.length) return;
  log(`⚠ Немає файлів (їх треба покласти в папку рівня вручну): ${missing.join(', ')}`);
  toast(`Немає файлів картинок: ${missing.join(', ')}`, true);
}

async function postApi(name, payload) {
  const r = await fetch(`__api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-editor': '1' }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Помилка сервера ${r.status}`);
  return j;
}

async function saveViaServer() {
  const { files, missing } = await gatherFiles();
  const j = await postApi('save', { folder, files: await Promise.all(files.map(async (f) => ({ path: f.path, data: await toBase64(f.blob) }))) });
  log(`✔ Записано файлів: ${j.written.length}`, ...j.written.map((p) => '   ' + p));
  if (j.index) log(j.index);
  reportMissing(missing);
  warnIfErrors();
}

async function gitStep(action) {
  if (action === 'commit' && validate().some((i) => i.lvl === 'error')
    && !confirm('У рівні є помилки — на сайті його буде пропущено. Закомітити все одно?')) return false;
  const j = await postApi('git', { folder, action, message: commitText() });
  log(`$ ${j.cmd}`, j.out || '(без виводу)', j.ok ? '✔ Готово' : '✖ Команда завершилась із помилкою');
  return j.ok;
}

async function saveViaBrowser() {
  const picked = await window.showDirectoryPicker({ mode: 'readwrite', id: 'storyframes' });
  let levels = picked;
  if (picked.name !== 'levels') {
    try { levels = await picked.getDirectoryHandle('levels'); }
    catch { throw new Error('Оберіть кореневу папку проєкту (де лежить папка levels) або саму папку levels'); }
  }
  const dir = await levels.getDirectoryHandle(folder, { create: true });
  const { files, missing } = await gatherFiles();
  for (const f of files) {
    const parts = f.path.split('/');
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(f.blob);
    await w.close();
  }
  log(`✔ Записано файлів: ${files.length} → levels/${folder}/`, ...files.map((f) => '   ' + f.path), 'Далі виконайте команди з блоку «Команди git».');
  reportMissing(missing);
  warnIfErrors();
}

async function downloadFiles() {
  const { files, missing } = await gatherFiles();
  for (const f of files) {
    const url = URL.createObjectURL(f.blob);
    const a = h('a', { href: url, download: f.path.split('/').pop() });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    await sleep(350);
  }
  log(`✔ Завантажено файлів: ${files.length}. Покладіть їх у levels/${folder}/ і виконайте команди з блоку «Команди git».`);
  reportMissing(missing);
  warnIfErrors();
}

async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch { toast('Не вдалося скопіювати — виділіть текст вручну', true); }
}

/* ───────── середовище (як саме можна записати файли) ───────── */

async function detectEnv() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch('__api/ping', { cache: 'no-store', headers: { 'x-editor': '1' }, signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) { const j = await r.json(); if (j?.ok) { env = { mode: 'server', info: j }; return; } }
  } catch { /* сервера немає */ }
  env = { mode: typeof window.showDirectoryPicker === 'function' && window.isSecureContext ? 'fsa' : 'download', info: null };
}

function modeText() {
  if (env.mode === 'server') {
    const i = env.info;
    return `Підключено до проєкту «${i.root}»${i.branch ? `, гілка ${i.branch}` : ''}${i.git ? '' : ' — це не git-репозиторій'}. Файли записуються прямо в levels/.`;
  }
  if (env.mode === 'fsa') return 'Браузер може записати файли в папку проєкту, яку ви оберете. З `npm run editor` буде ще зручніше: там є й кнопки git.';
  return 'Цей браузер не вміє записувати в папки, тому файли завантажаться окремо. Запустіть `npm run editor` — і запис та git будуть однією кнопкою.';
}

function pubButtons() {
  const mk = (text, cls, fn, title) => {
    const b = h('button', { class: `btn small ${cls}`, type: 'button', title });
    b.textContent = text;
    b.addEventListener('click', () => act(b, fn));
    return b;
  };
  if (env.mode === 'server') {
    const git = env.info.git;
    const noGit = git ? undefined : 'Ця папка не є git-репозиторієм';
    const steps = [
      mk('① Записати файли в проєкт', 'primary', saveViaServer),
      mk('② Додати в git (git add)', '', () => gitStep('add'), noGit),
      mk('③ Закомітити й відправити (commit + push)', '', async () => { if (await gitStep('commit')) await gitStep('push'); }, noGit),
    ];
    if (!git) steps.slice(1).forEach((b) => { b.disabled = true; });
    return h('div', { class: 'pub-steps' }, ...steps);
  }
  if (env.mode === 'fsa') return h('div', { class: 'pub-steps' }, mk('Записати файли в проєкт…', 'primary', saveViaBrowser));
  return h('div', { class: 'pub-steps' }, mk('⬇ Завантажити файли рівня', 'primary', downloadFiles));
}

/* ───────────────────────── завантаження ───────────────────────── */

function loadText(text, name) {
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('очікувався об’єкт');
    setLevel(adopt(raw));
    toast(`Відкрито ${name || 'level.json'}`);
  } catch (e) {
    toast('Це не схоже на level.json: ' + e.message, true);
  }
}

async function loadFromCatalog(id) {
  try {
    const r = await fetch(`levels/${encodeURIComponent(id)}/level.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    setLevel(adopt(await r.json()), { folder: id, remoteBase: `levels/${encodeURIComponent(id)}/` });
    toast(`Відкрито levels/${id}`);
  } catch (e) {
    toast('Не вдалося відкрити рівень: ' + e.message, true);
  }
}

async function fillCatalog(select) {
  try {
    const r = await fetch('levels/index.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const { levels } = await r.json();
    if (!levels?.length) return;
    select.append(...levels.map((l) => h('option', { value: l.id }, `${l.icon || '🎞️'} ${l.title}`)));
    select.hidden = false;
  } catch { /* каталогу немає — просто без списку */ }
}

/* ───────────────────────── каркас ───────────────────────── */

function rerender() {
  renderPane();
  refreshSide();
}

function render() {
  renderTabs();
  renderPane();
  refreshSide();
}

function build() {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (f) loadText(await f.text(), f.name);
    fileInput.value = '';
  });

  const catalog = h('select', { hidden: true, 'aria-label': 'Відкрити рівень із сайту', onchange: () => { if (catalog.value) loadFromCatalog(catalog.value); catalog.value = ''; } },
    h('option', { value: '' }, 'Відкрити рівень із сайту…'));
  fillCatalog(catalog);

  const folderEl = h('input', { id: 'folder', type: 'text', class: 'mono', value: folder, autocomplete: 'off', spellcheck: 'false' });
  folderEl.addEventListener('input', () => { folder = folderEl.value.trim(); folderAuto = false; changed(); });

  const msgEl = h('input', { id: 'msg', type: 'text', value: commitText(), autocomplete: 'off' });
  msgEl.addEventListener('input', () => { commitMsg = msgEl.value; commitAuto = !msgEl.value.trim(); changed(); });

  $('#editor').replaceChildren(
    h('div', { class: 'ed-toolbar' },
      h('button', { class: 'btn small', type: 'button', onclick: () => { if (confirm('Почати новий рівень? Поточні зміни буде втрачено.')) setLevel(starter()); } }, '＋ Новий'),
      h('button', { class: 'btn small', type: 'button', onclick: () => fileInput.click() }, 'Відкрити level.json'),
      typeof window.showDirectoryPicker === 'function' ? h('button', { class: 'btn small', type: 'button', onclick: openFolder, title: 'Завантажить level.json разом із картинками' }, 'Відкрити папку рівня…') : null,
      catalog, fileInput),
    h('div', { class: 'ed' },
      h('div', null, h('div', { id: 'tabs', class: 'tabs', role: 'tablist' }), h('section', { id: 'pane', class: 'panel' })),
      h('aside', { class: 'ed-side' },
        h('div', { class: 'side-box' }, h('h3', { id: 'issues-title' }, 'Перевірка'), h('p', { id: 'stats', class: 'stats' }), h('ul', { id: 'issues', class: 'issues' })),
        h('div', { class: 'side-box' },
          h('h3', null, 'Публікація рівня'),
          h('p', { class: 'pub-note' }, modeText()),
          field('Папка рівня', folderEl),
          h('p', { id: 'path', class: 'path mono' }),
          h('ul', { id: 'files', class: 'files' }),
          pubButtons(),
          field('Повідомлення коміту', msgEl),
          h('details', { open: true, style: 'margin-top:12px' },
            h('summary', null, 'Команди git'),
            h('pre', { id: 'cmds', class: 'json cmds' }),
            h('button', { class: 'btn small', type: 'button', onclick: () => copyText($('#cmds').textContent, 'Команди скопійовано') }, 'Копіювати команди')),
          h('pre', { id: 'pub-log', class: 'log', 'aria-live': 'polite' }),
          h('details', { id: 'json-d', style: 'margin-top:12px' },
            h('summary', null, 'level.json'),
            h('pre', { id: 'json', class: 'json' }),
            h('div', { class: 'btnrow', style: 'margin-top:8px' }, h('button', { class: 'btn small', type: 'button', onclick: () => copyText(json(), 'level.json скопійовано') }, 'Копіювати JSON')))))));
}

async function openFolder() {
  try {
    const dir = await window.showDirectoryPicker({ id: 'storyframes-open' });
    let file;
    try { file = await (await dir.getFileHandle('level.json')).getFile(); }
    catch { toast('У цій папці немає level.json — оберіть папку конкретного рівня', true); return; }
    const lvl = adopt(JSON.parse(await file.text()));
    const found = new Map();
    const paths = [...new Set(allImageSlots(lvl).map(([o, k]) => o[k]).filter((f) => f && !isRemote(f)))];
    for (const p of paths) {
      try {
        const parts = p.split('/');
        let d = dir;
        for (const s of parts.slice(0, -1)) d = await d.getDirectoryHandle(s);
        found.set(p, await (await d.getFileHandle(parts.at(-1))).getFile());
      } catch { /* цього файлу в папці немає */ }
    }
    setLevel(lvl, { folder: /^[a-z0-9][a-z0-9_-]*$/i.test(dir.name) ? dir.name : undefined, assets: found });
    toast(`Відкрито «${dir.name}»: картинок ${found.size} з ${paths.length}`);
  } catch (e) {
    if (e.name !== 'AbortError') toast('Не вдалося відкрити папку: ' + e.message, true);
  }
}

async function init() {
  await detectEnv();
  // Щоб випадковий дроп повз зону не відкривав картинку замість редактора
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

  let restored = false;
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (d?.L?.frames && d.L.endings) {
      L = adopt(d.L);
      folder = d.folder || slug(L.title) || 'my-level';
      folderAuto = d.folderAuto !== false;
      restored = true;
    }
  } catch { /* зіпсована чернетка */ }
  if (!restored) { L = starter(); folder = slug(L.title); folderAuto = true; }
  build();
  render();
  if (restored) toast('Відновлено чернетку (картинки з чернетки не зберігаються — додайте їх знову)');
}

init();
