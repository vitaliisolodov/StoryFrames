// Швидка перевірка логіки збігу кінцівок:  node scripts/test-logic.mjs
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { matchEndings, captionFor, normalizeLevel } from '../js/logic.js';

const load = async (id) =>
  normalizeLevel(JSON.parse(await readFile(new URL(`../levels/${id}/level.json`, import.meta.url), 'utf8')));
const fr = (setting, ...chars) => ({ setting, chars: [...chars, null].slice(0, 2) });
const ids = (L, frames) => matchEndings(L, frames).map((e) => e.id);

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓', name); };

const castle = await load('castle-betrayal');
ok('castle: справедливість', () =>
  assert.deepEqual(ids(castle, [fr('castle', 'king'), fr('forest', 'knight', 'thief'), fr('castle', 'knight', 'king')]), ['justice']));
ok('castle: корона зникла', () =>
  assert.deepEqual(ids(castle, [fr('castle', 'king'), fr('castle', 'thief'), fr('forest', 'thief')]), ['theft']));
ok('castle: секретна «злодій на троні» (exact)', () =>
  assert.deepEqual(ids(castle, [fr('forest', 'king'), fr('tavern', 'king', 'thief'), fr('castle', 'thief')]), ['thief-throne']));
ok('castle: exact не пускає зайвого персонажа', () =>
  assert.deepEqual(ids(castle, [fr('forest', 'king'), fr('tavern', 'king', 'thief'), fr('castle', 'thief', 'knight')]), []));
ok('castle: чарівник у замку в кінці (кадри null = будь-що)', () =>
  assert.deepEqual(ids(castle, [fr(null), fr(null), fr('castle', 'wizard')]), ['wizard-rule']));
ok('castle: порожня розстановка — без кінцівок', () =>
  assert.deepEqual(ids(castle, [fr(null), fr(null), fr(null)]), []));
ok('castle: підпис під кадром', () =>
  assert.equal(captionFor(castle, 1, { setting: 'forest', characters: ['thief', 'knight'] }), 'Лицар наздоганяє злодія серед дерев.'));
ok('castle: без вмісту підпису немає', () =>
  assert.equal(captionFor(castle, 1, { setting: null, characters: [] }), ''));

const film = await load('film-set');
ok('film: Оскар', () =>
  assert.deepEqual(ids(film, [fr('studio', 'director'), fr('desert', 'actor', 'stunt'), fr('studio', 'director', 'actor')]), ['oscar']));
ok('film: дракон у студії у 2-му кадрі', () =>
  assert.deepEqual(ids(film, [fr(null), fr('studio', 'dragon'), fr(null)]), ['dragon-chaos']));
ok('film: при перетині виграє конкретніша кінцівка', () => {
  const r = ids(film, [fr(null), fr('studio', 'robot', 'dragon'), fr('studio', 'robot')]);
  assert.deepEqual(r.sort(), ['dragon-chaos', 'robot-director']);
  assert.equal(matchEndings(film, [fr(null), fr('studio', 'robot', 'dragon'), fr('studio', 'robot')])[0].id, 'robot-director');
});
ok('film: космос', () =>
  assert.deepEqual(ids(film, [fr(null), fr(null), fr('space', 'robot', 'actor')]), ['space-opera']));
ok('film: самотній режисер', () =>
  assert.deepEqual(ids(film, [fr('desert', 'director'), fr('desert', 'director'), fr(null)]), ['lost-director']));

console.log(`\nПройдено перевірок: ${n}`);
