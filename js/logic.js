// Чиста логіка гри (без DOM) — її можна тестувати в Node.

/** Скільки «умов» містить вимога до кадру (чим більше — тим конкретніша). */
export function reqSpecificity(req) {
  if (!req) return 0;
  return (req.setting ? 1 : 0) + (req.characters ? req.characters.length : 0) + (req.exact ? 1 : 0);
}

/**
 * Чи підходить кадр під вимогу.
 * req:  { setting?, characters?, exact? } або null (= будь-що)
 * st:   { setting: id|null, characters: [id, ...] }
 */
export function frameMatches(req, st) {
  if (!req) return true;
  if (req.setting && st.setting !== req.setting) return false;
  const want = req.characters || [];
  for (const c of want) if (!st.characters.includes(c)) return false;
  if (req.exact && st.characters.length !== want.length) return false;
  return true;
}

/** Перетворює стан гри (frames[i] = {setting, chars:[...]}) на «чисті» кадри. */
export function toStates(frames) {
  return frames.map((f) => ({ setting: f.setting || null, characters: f.chars.filter(Boolean) }));
}

/** Усі кінцівки, що підходять під розстановку; найконкретніша — першою. */
export function matchEndings(level, frames) {
  const sts = toStates(frames);
  const hits = level.endings.filter((e) =>
    e.frames.every((req, i) => (sts[i] ? frameMatches(req, sts[i]) : !req))
  );
  const score = (e) => e.frames.reduce((n, r) => n + reqSpecificity(r), 0);
  return hits.sort((a, b) => score(b) - score(a));
}

/** Підпис під кадром (найконкретніший збіг із level.captions). */
export function captionFor(level, index, st) {
  if (!st.setting && st.characters.length === 0) return '';
  const hits = (level.captions || []).filter((c) => c.frame === index && frameMatches(c, st));
  hits.sort((a, b) => reqSpecificity(b) - reqSpecificity(a));
  return hits[0]?.text || '';
}

/** Доводить level.json до єдиного вигляду (значення за замовчуванням). */
export function normalizeLevel(L) {
  const frames = (L.frames || []).map((f, i) =>
    typeof f === 'string' ? { title: f } : { title: f.title || `Кадр ${i + 1}`, ...f }
  );
  const slots = Math.min(3, Math.max(1, Number(L.charSlots) || 2));
  return {
    ...L,
    frames,
    charSlots: slots,
    characters: L.characters || [],
    settings: L.settings || [],
    captions: L.captions || [],
    endings: (L.endings || []).map((e) => ({ ...e, frames: Array.isArray(e.frames) ? e.frames : [] })),
  };
}

/** Короткий опис рівня для каталогу. */
export function summarize(id, L) {
  const endings = L.endings || [];
  return {
    id,
    title: L.title || id,
    description: L.description || '',
    author: L.author || '',
    difficulty: Math.min(3, Math.max(0, Number(L.difficulty) || 0)),
    order: Number.isFinite(Number(L.order)) ? Number(L.order) : 1000,
    icon: L.icon || '',
    cover: L.cover || '',
    frames: (L.frames || []).length,
    endings: endings.length,
    hiddenEndings: endings.filter((e) => e.hidden).length,
  };
}

export function sortLevels(list) {
  return [...list].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, 'uk'));
}
