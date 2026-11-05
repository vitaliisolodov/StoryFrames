#!/usr/bin/env node
// Сканує levels/*/level.json, перевіряє кожен рівень і пише levels/index.json.
// Запуск:  node scripts/build-index.mjs            (звичайний)
//          node scripts/build-index.mjs --strict   (код виходу 1, якщо є помилки)

import { readdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, sortLevels } from '../js/logic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const levelsDir = path.join(root, 'levels');
const strict = process.argv.includes('--strict');
const inCI = Boolean(process.env.GITHUB_ACTIONS);

const exists = (p) => access(p).then(() => true, () => false);
const isRemote = (s) => /^(https?:|data:)/.test(s);
let problems = 0;

function report(id, msg) {
  problems++;
  console.warn(`${inCI ? '::warning::' : '⚠️  '}[${id}] ${msg}`);
}

async function validate(dir, L) {
  const errs = [];

  if (typeof L.title !== 'string' || !L.title.trim()) errs.push('немає поля "title"');
  for (const key of ['frames', 'characters', 'settings', 'endings']) {
    if (!Array.isArray(L[key]) || L[key].length === 0) errs.push(`поле "${key}" має бути непорожнім масивом`);
  }
  if (errs.length) return errs;

  const collectIds = (arr, label) => {
    const seen = new Set();
    for (const it of arr) {
      if (!it || typeof it.id !== 'string' || !it.id) { errs.push(`${label}: елемент без "id"`); continue; }
      if (seen.has(it.id)) errs.push(`${label}: повторюється id "${it.id}"`);
      seen.add(it.id);
    }
    return seen;
  };
  const chars = collectIds(L.characters, 'characters');
  const sets = collectIds(L.settings, 'settings');
  collectIds(L.endings, 'endings');

  const checkFile = async (label, rel) => {
    if (rel && !isRemote(rel) && !(await exists(path.join(dir, rel)))) errs.push(`${label}: файл "${rel}" не знайдено`);
  };

  for (const it of [...L.characters, ...L.settings]) {
    if (!it?.id) continue;
    if (!it.name) errs.push(`"${it.id}": немає "name"`);
    if (!it.emoji && !it.image) errs.push(`"${it.id}": потрібне "emoji" або "image"`);
    await checkFile(`"${it.id}"`, it.image);
  }
  await checkFile('cover', L.cover);

  const checkReq = (label, r) => {
    if (!r) return;
    if (r.setting && !sets.has(r.setting)) errs.push(`${label}: невідома декорація "${r.setting}"`);
    for (const c of r.characters || []) if (!chars.has(c)) errs.push(`${label}: невідомий персонаж "${c}"`);
  };

  for (const e of L.endings) {
    if (!e?.id) continue;
    if (!e.title) errs.push(`кінцівка "${e.id}": немає "title"`);
    if (!Array.isArray(e.frames)) { errs.push(`кінцівка "${e.id}": потрібен масив "frames"`); continue; }
    if (e.frames.length > L.frames.length) {
      errs.push(`кінцівка "${e.id}": у "frames" ${e.frames.length} елементів, а кадрів у рівні ${L.frames.length}`);
    }
    e.frames.forEach((r, i) => checkReq(`кінцівка "${e.id}", кадр ${i + 1}`, r));
  }
  for (const [n, c] of (L.captions || []).entries()) {
    if (!Number.isInteger(c.frame) || c.frame < 0 || c.frame >= L.frames.length) {
      errs.push(`captions[${n}]: "frame" має бути від 0 до ${L.frames.length - 1}`);
    }
    checkReq(`captions[${n}]`, c);
  }
  return errs;
}

const entries = await readdir(levelsDir, { withFileTypes: true });
const dirs = entries.filter((d) => d.isDirectory() && !/^[_.]/.test(d.name));
const list = [];

for (const d of dirs) {
  const dir = path.join(levelsDir, d.name);
  const file = path.join(dir, 'level.json');
  if (!(await exists(file))) { report(d.name, 'немає файлу level.json — папку пропущено'); continue; }

  let L;
  try {
    L = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    report(d.name, `level.json не читається як JSON (${e.message}) — рівень пропущено`);
    continue;
  }

  const errs = await validate(dir, L);
  if (errs.length) {
    errs.forEach((m) => report(d.name, m));
    console.warn(`   → рівень "${d.name}" пропущено`);
    continue;
  }
  list.push(summarize(d.name, L));
}

const sorted = sortLevels(list);
await writeFile(
  path.join(levelsDir, 'index.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), levels: sorted }, null, 2) + '\n'
);

console.log(`✅ Рівнів у каталозі: ${sorted.length}${sorted.length ? ' — ' + sorted.map((l) => l.id).join(', ') : ''}`);
if (problems) console.log(`⚠️  Проблем: ${problems}`);
if (strict && problems) process.exit(1);
