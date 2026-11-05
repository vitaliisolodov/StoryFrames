#!/usr/bin/env node
// Локальний сервер для сайту й редактора рівнів:   npm run editor
//
//  • віддає сайт (як `npx serve .`), тож рівні та редактор працюють на http://localhost:3000
//  • дозволяє редактору записувати файли рівня прямо в levels/<папка>/
//  • вміє виконати `git add`, `git commit` і `git push` для цієї папки
//
// Слухає лише 127.0.0.1. Запити на запис приймаються тільки зі сторінок цього ж сервера.

import http from 'node:http';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const levelsDir = path.join(root, 'levels');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const WRITABLE = new Set(['.json', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
const FOLDER_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const MAX_BODY = 80 * 1024 * 1024;

/* ───────── допоміжне ───────── */

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => { p.kill(); out += '\n(перевищено час очікування, 60 с)'; }, 60_000);
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `${out}${e.message}`.trim() }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim() }); });
  });
}

const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Забагато даних (понад 80 МБ)'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Некоректний JSON у запиті'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/** Захист: тільки localhost, тільки з нашого ж origin і лише з власним заголовком. */
function guard(req) {
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false;
  if (req.headers['x-editor'] !== '1') return false;
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== host) return false; } catch { return false; } }
  return true;
}

function safeRel(p) {
  const rel = String(p || '').replace(/\\/g, '/');
  const parts = rel.split('/');
  if (!rel || rel.startsWith('/') || parts.some((s) => !s || s === '.' || s === '..' || s.includes(':'))) throw bad(`Недопустимий шлях: ${p}`);
  if (!WRITABLE.has(path.extname(rel).toLowerCase())) throw bad(`Недозволений тип файлу: ${p}`);
  return parts;
}
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/* ───────── API ───────── */

async function api(req, res, name) {
  if (name === 'ping') {
    const top = await run('git', ['rev-parse', '--show-toplevel']);
    const br = top.code === 0 ? await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
    return send(res, 200, { ok: true, root: path.basename(root), git: top.code === 0, branch: br?.code === 0 ? br.out : '' });
  }
  if (req.method !== 'POST') throw bad('Потрібен POST', 405);
  const body = await readBody(req);
  const folder = String(body.folder || '');
  if (!FOLDER_RE.test(folder)) throw bad('Некоректна назва папки (латиниця, цифри, «-», «_»)');

  if (name === 'save') {
    const files = Array.isArray(body.files) ? body.files : [];
    const base = path.join(levelsDir, folder);
    const lv = files.find((f) => f.path === 'level.json');
    if (!lv) throw bad('У запиті немає level.json');
    try { JSON.parse(Buffer.from(String(lv.data || ''), 'base64').toString('utf8')); } catch { throw bad('level.json не є коректним JSON'); }
    const written = [];
    for (const f of files) {
      const parts = safeRel(f.path);
      const dest = path.join(base, ...parts);
      if (!dest.startsWith(base + path.sep)) throw bad(`Недопустимий шлях: ${f.path}`);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(String(f.data || ''), 'base64'));
      written.push(`levels/${folder}/${parts.join('/')}`);
    }
    const idx = await run(process.execPath, [path.join(root, 'scripts', 'build-index.mjs')]);
    return send(res, 200, { ok: true, written, index: idx.out });
  }

  if (name === 'git') {
    try { await stat(path.join(root, '.git')); } catch { throw bad('Ця папка не є git-репозиторієм (немає .git)'); }
    const target = `levels/${folder}`;
    const action = body.action;
    let cmd; let r;
    if (action === 'add') {
      cmd = `git add -- ${target}`;
      r = await run('git', ['add', '--', target]);
      if (r.code === 0) { const s = await run('git', ['status', '--short', '--', target]); r.out = s.out || '(змін немає)'; }
    } else if (action === 'commit') {
      const msg = String(body.message || '').trim().slice(0, 200);
      if (!msg) throw bad('Порожнє повідомлення коміту');
      cmd = `git commit -m "${msg}" -- ${target}`;
      r = await run('git', ['commit', '-m', msg, '--', target]);
    } else if (action === 'push') {
      cmd = 'git push';
      r = await run('git', ['push']);
      if (r.code !== 0 && /no upstream|has no upstream/i.test(r.out)) {
        cmd = 'git push -u origin HEAD';
        r = await run('git', ['push', '-u', 'origin', 'HEAD']);
      }
    } else throw bad('Невідома дія');
    return send(res, 200, { ok: r.code === 0, cmd, out: r.out });
  }
  throw bad('Невідомий запит', 404);
}

/* ───────── статика ───────── */

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400).end('Bad request'); return; }
  let file = path.join(root, rel);
  if (!file.startsWith(root) || rel.split('/').some((s) => s === '.git' || s === 'node_modules')) { res.writeHead(403).end('Forbidden'); return; }
  try {
    let st = await stat(file);
    if (st.isDirectory()) { file = path.join(file, 'index.html'); st = await stat(file); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
    if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Не знайдено');
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/__api/')) {
    try {
      if (!guard(req)) return send(res, 403, { ok: false, error: 'Запит відхилено' });
      await api(req, res, pathname.slice('/__api/'.length));
    } catch (e) {
      send(res, e.status || 500, { ok: false, error: e.message });
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  await serveStatic(req, res, pathname);
});

/* ───────── запуск ───────── */

const idx = await run(process.execPath, [path.join(root, 'scripts', 'build-index.mjs')]);
if (idx.out) console.log(idx.out);

let port = Number(process.env.PORT) || 3000;
const first = port;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < first + 10) { port += 1; server.listen(port, '127.0.0.1'); }
  else { console.error(e.message); process.exit(1); }
});
server.on('listening', () => {
  console.log(`\n🎞️  Сайт:     http://localhost:${port}/`);
  console.log(`✏️  Редактор: http://localhost:${port}/editor.html`);
  console.log('\nCtrl+C — зупинити.');
});
server.listen(port, '127.0.0.1');
