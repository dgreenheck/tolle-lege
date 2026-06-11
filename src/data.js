/**
 * Static data access: canon index, per-book text, per-book cross-references,
 * word-level Greek/Hebrew alignment, and the Strong's lexicon.
 * Everything is fetched lazily from /data/ and cached.
 */

// Resolve under Vite's base so the app works from a subpath (GitHub Pages).
const DATA = `${import.meta.env.BASE_URL}data`;

const textCache = new Map();
const refCache = new Map();
const alignCache = new Map();
const lexCache = new Map();
const geoCache = new Map();
let placesPromise = null;

let books = null;
let byOsis = null;

export async function loadBooks() {
  if (!books) {
    books = await (await fetch(`${DATA}/books.json`)).json();
    byOsis = new Map(books.map((b) => [b.osis, b]));
  }
  return books;
}

export function bookInfo(osis) {
  return byOsis?.get(osis) ?? null;
}

export async function loadBookText(osis) {
  if (!textCache.has(osis)) {
    textCache.set(osis, (await fetch(`${DATA}/text/${osis}.json`)).json().then((t) => {
      textCache.set(osis, t);
      return t;
    }));
  }
  return textCache.get(osis);
}

export async function loadBookRefs(osis) {
  if (!refCache.has(osis)) {
    refCache.set(osis, (await fetch(`${DATA}/refs/${osis}.json`)).json().then((r) => {
      refCache.set(osis, r);
      return r;
    }));
  }
  return refCache.get(osis);
}

export async function loadBookAlign(osis) {
  if (!alignCache.has(osis)) {
    alignCache.set(osis, (await fetch(`${DATA}/align/${osis}.json`)).json().then((a) => {
      alignCache.set(osis, a);
      return a;
    }));
  }
  return alignCache.get(osis);
}

export async function loadBookGeo(osis) {
  if (!geoCache.has(osis)) {
    geoCache.set(osis, (await fetch(`${DATA}/geo/${osis}.json`)).json().then((g) => {
      geoCache.set(osis, g);
      return g;
    }).catch(() => ({})));
  }
  return geoCache.get(osis);
}

/** The place gazetteer: { placeId: [name, lat, lon, type] }. */
function loadPlaces() {
  placesPromise ??= fetch(`${DATA}/places.json`).then((r) => r.json()).catch(() => ({}));
  return placesPromise;
}

/**
 * Geocoded places tied to one verse: [{ id, name, lat, lon, type, start,
 * len }]. start -1 = the place isn't named in the BSB wording (no word to
 * highlight, but it still belongs on the verse's map).
 */
export async function versePlaces(osis, chapter, verse) {
  const [geo, places] = await Promise.all([loadBookGeo(osis), loadPlaces()]);
  return (geo[`${chapter}.${verse}`] ?? [])
    .map(([start, len, id]) => {
      const p = places[id];
      return p && { id, start, len, name: p[0], lat: p[1], lon: p[2], type: p[3] };
    })
    .filter(Boolean);
}

/**
 * The original-language word behind a display word, or null when untagged.
 * wordIdx indexes the verse's text.split(' ') tokens (pages.js tokenization).
 * Returns { start, len, strongs, orig, translit, parsing }.
 */
export async function wordAlignment(osis, chapter, verse, wordIdx) {
  const align = await loadBookAlign(osis);
  const entries = align[`${chapter}.${verse}`] ?? [];
  const hit = entries.find(([s, n]) => wordIdx >= s && wordIdx < s + n);
  if (!hit) return null;
  const [start, len, strongs, orig, translit, parsing] = hit;
  return { start, len, strongs, orig, translit, parsing };
}

/**
 * Strong's lexicon entry: { l: lemma, t: translit, p: pronunciation,
 * d: definition, k: KJV renderings, v: derivation, n: occurrence count,
 * o: [refs] } — or null for an unknown number.
 */
export async function lexEntry(strongs) {
  const shardKey = strongs[0] + Math.floor(parseInt(strongs.slice(1), 10) / 100);
  if (!lexCache.has(shardKey)) {
    lexCache.set(shardKey, (await fetch(`${DATA}/lex/${shardKey}.json`)).json().then((s) => {
      lexCache.set(shardKey, s);
      return s;
    }));
  }
  return (await lexCache.get(shardKey))?.[strongs] ?? null;
}

/**
 * Other passages using the same original-language word, as card data:
 * [{ ref, votes, label, text }]. excludeRef is the verse being read.
 */
export async function lemmaOccurrences(lex, excludeRef, limit = 7) {
  const refs = (lex?.o ?? []).filter((r) => r !== excludeRef).slice(0, limit);
  return Promise.all(
    refs.map(async (ref) => ({
      ref,
      votes: lex.n,
      label: formatRef(ref),
      text: await verseText(ref),
    })),
  );
}

/** "John.3.16" -> { osis, chapter, verse } */
export function parseRef(ref) {
  const [osis, c, v] = ref.split('.');
  return { osis, chapter: parseInt(c, 10), verse: parseInt(v, 10) };
}

/** "John.3.16" -> "John 3:16" */
export function formatRef(ref) {
  const { osis, chapter, verse } = parseRef(ref);
  const name = bookInfo(osis)?.name ?? osis;
  return `${name} ${chapter}:${verse}`;
}

/** Fetch the text of a single verse, e.g. for reference cards. */
export async function verseText(ref) {
  const { osis, chapter, verse } = parseRef(ref);
  const text = await loadBookText(osis);
  return text?.[chapter - 1]?.[verse - 1] ?? '';
}

/**
 * Cross-references for one verse: [{ ref, votes, label, text }], best first.
 */
export async function crossRefs(osis, chapter, verse, limit = 7) {
  const refs = await loadBookRefs(osis);
  const entries = (refs[`${chapter}.${verse}`] ?? []).slice(0, limit);
  return Promise.all(
    entries.map(async ([ref, votes]) => ({
      ref,
      votes,
      label: formatRef(ref),
      text: await verseText(ref),
    })),
  );
}
