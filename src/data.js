/**
 * Static data access: canon index, per-book text, per-book cross-references.
 * Everything is fetched lazily from /data/ and cached.
 */

const textCache = new Map();
const refCache = new Map();

let books = null;
let byOsis = null;

export async function loadBooks() {
  if (!books) {
    books = await (await fetch('/data/books.json')).json();
    byOsis = new Map(books.map((b) => [b.osis, b]));
  }
  return books;
}

export function bookInfo(osis) {
  return byOsis?.get(osis) ?? null;
}

export async function loadBookText(osis) {
  if (!textCache.has(osis)) {
    textCache.set(osis, (await fetch(`/data/text/${osis}.json`)).json().then((t) => {
      textCache.set(osis, t);
      return t;
    }));
  }
  return textCache.get(osis);
}

export async function loadBookRefs(osis) {
  if (!refCache.has(osis)) {
    refCache.set(osis, (await fetch(`/data/refs/${osis}.json`)).json().then((r) => {
      refCache.set(osis, r);
      return r;
    }));
  }
  return refCache.get(osis);
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
