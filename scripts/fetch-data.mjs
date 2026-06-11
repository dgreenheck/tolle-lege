/**
 * Data pipeline: downloads the Berean Standard Bible (public domain) text and
 * word-level translation tables, the OpenBible.info cross-reference dataset
 * (CC-BY), and the Open Scriptures Strong's dictionaries (CC-BY-SA), then
 * processes them into compact JSON under public/data/.
 *
 *   node scripts/fetch-data.mjs
 *
 * Outputs:
 *   public/data/books.json        — canon index [{ osis, name, chapters }]
 *   public/data/text/{osis}.json  — [[verse, ...], ...] chapters of verse strings
 *   public/data/refs/{osis}.json  — { "C.V": [[targetOsisRef, votes], ...] }
 *   public/data/align/{osis}.json — { "C.V": [[tokStart, tokLen, strongs,
 *                                     original, translit, parsing], ...] }
 *                                   tok indices = verse.split(' ') positions
 *   public/data/lex/{H|G}{n}.json — Strong's entries nnn00..nnn99 merged with
 *                                   occurrence refs: { "H1254": { l, t, p, d,
 *                                     k, v, n, o: ["Gen.1.1", ...] } }
 *   public/data/places.json       — { placeId: [name, lat, lon, type] }
 *   public/data/geo/{osis}.json   — { "C.V": [[tokStart, tokLen, placeId], ...] }
 *                                   tokStart -1 = place tied to the verse but
 *                                   its name isn't in the BSB wording
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');

const BSB_TEXT_URL = 'https://bereanbible.com/bsb.txt';
const BSB_TABLES_URL = 'https://bereanbible.com/bsb_tables.tsv';
const XREF_URL = 'https://a.openbible.info/data/cross-references.zip';
const STRONGS_HEB_URL = 'https://raw.githubusercontent.com/openscriptures/strongs/master/hebrew/strongs-hebrew-dictionary.js';
const STRONGS_GRK_URL = 'https://raw.githubusercontent.com/openscriptures/strongs/master/greek/strongs-greek-dictionary.js';
const GEO_URL = 'https://raw.githubusercontent.com/openbibleinfo/Bible-Geocoding-Data/main/data/ancient.jsonl';

// BSB book name -> OSIS id (the id scheme used by the cross-reference dataset).
const OSIS = {
  'Genesis': 'Gen', 'Exodus': 'Exod', 'Leviticus': 'Lev', 'Numbers': 'Num',
  'Deuteronomy': 'Deut', 'Joshua': 'Josh', 'Judges': 'Judg', 'Ruth': 'Ruth',
  '1 Samuel': '1Sam', '2 Samuel': '2Sam', '1 Kings': '1Kgs', '2 Kings': '2Kgs',
  '1 Chronicles': '1Chr', '2 Chronicles': '2Chr', 'Ezra': 'Ezra', 'Nehemiah': 'Neh',
  'Esther': 'Esth', 'Job': 'Job', 'Psalm': 'Ps', 'Proverbs': 'Prov',
  'Ecclesiastes': 'Eccl', 'Song of Solomon': 'Song', 'Isaiah': 'Isa', 'Jeremiah': 'Jer',
  'Lamentations': 'Lam', 'Ezekiel': 'Ezek', 'Daniel': 'Dan',
  'Hosea': 'Hos', 'Joel': 'Joel', 'Amos': 'Amos', 'Obadiah': 'Obad',
  'Jonah': 'Jonah', 'Micah': 'Mic', 'Nahum': 'Nah', 'Habakkuk': 'Hab',
  'Zephaniah': 'Zeph', 'Haggai': 'Hag', 'Zechariah': 'Zech', 'Malachi': 'Mal',
  'Matthew': 'Matt', 'Mark': 'Mark', 'Luke': 'Luke', 'John': 'John', 'Acts': 'Acts',
  'Romans': 'Rom', '1 Corinthians': '1Cor', '2 Corinthians': '2Cor',
  'Galatians': 'Gal', 'Ephesians': 'Eph', 'Philippians': 'Phil', 'Colossians': 'Col',
  '1 Thessalonians': '1Thess', '2 Thessalonians': '2Thess',
  '1 Timothy': '1Tim', '2 Timothy': '2Tim', 'Titus': 'Titus', 'Philemon': 'Phlm',
  'Hebrews': 'Heb', 'James': 'Jas', '1 Peter': '1Pet', '2 Peter': '2Pet',
  '1 John': '1John', '2 John': '2John', '3 John': '3John', 'Jude': 'Jude',
  'Revelation': 'Rev',
};
// Nav-friendly display names where BSB's header name reads oddly.
const DISPLAY = { Ps: 'Psalms' };

const MAX_REFS_PER_VERSE = 14;
const MAX_OCCURRENCES = 60;

function download(url, dest) {
  if (existsSync(dest)) { console.log(`cached: ${dest}`); return; }
  console.log(`downloading ${url}`);
  execFileSync('curl', ['-sL', '--fail', '--max-time', '600', url, '-o', dest], { stdio: 'inherit' });
}

mkdirSync(CACHE, { recursive: true });
for (const d of ['text', 'refs', 'align', 'lex', 'geo']) mkdirSync(path.join(OUT, d), { recursive: true });

/* ---------- Bible text ---------- */

const textPath = path.join(CACHE, 'bsb.txt');
download(BSB_TEXT_URL, textPath);

const VERSE_RE = /^(.+?) (\d+):(\d+)\t(.*)$/;
const texts = new Map();       // osis -> chapters[][]
const bookOrder = [];          // osis ids in canon order
let verseCount = 0;
for (const line of readFileSync(textPath, 'utf8').replace(/^﻿/, '').split('\n')) {
  const m = VERSE_RE.exec(line.trim());
  if (!m) continue;
  const osis = OSIS[m[1]];
  if (!osis) continue; // preamble / unexpected book
  let chapters = texts.get(osis);
  if (!chapters) { texts.set(osis, (chapters = [])); bookOrder.push(osis); }
  const c = parseInt(m[2], 10);
  const v = parseInt(m[3], 10);
  (chapters[c - 1] ??= [])[v - 1] = m[4].trim().replace(/\s+/g, ' ');
  verseCount++;
}
if (bookOrder.length !== 66) throw new Error(`expected 66 books, parsed ${bookOrder.length}`);

const books = [];
const validVerse = new Map(); // osis -> [versesPerChapter]
for (const osis of bookOrder) {
  // Array.from (not .map) so holes — verses the BSB omits on textual
  // grounds, e.g. John 5:4 — become empty strings, not nulls.
  const chapters = Array.from(texts.get(osis), (c) => Array.from(c ?? [], (v) => v ?? ''));
  const name = DISPLAY[osis] ?? Object.keys(OSIS).find((k) => OSIS[k] === osis);
  books.push({ osis, name, chapters: chapters.length });
  validVerse.set(osis, chapters.map((c) => c.length));
  writeFileSync(path.join(OUT, 'text', `${osis}.json`), JSON.stringify(chapters));
}
writeFileSync(path.join(OUT, 'books.json'), JSON.stringify(books));
console.log(`wrote ${books.length} books, ${verseCount} verses`);

/* ---------- word-level alignment (BSB translation tables) ---------- */

const tablesPath = path.join(CACHE, 'bsb_tables.tsv');
download(BSB_TABLES_URL, tablesPath);

/** Lowercase, strip diacritics + everything but letters/digits. */
function norm(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Match table entries (BSB word order) against the verse's display tokens.
 * The concatenated entry words reproduce the verse text, so a sequential
 * scan over the normalized character stream recovers each entry's token
 * span — including entries that share a token across an em-dash.
 */
function alignVerse(tokens, entries) {
  let stream = '';
  const tokOf = [];
  for (let i = 0; i < tokens.length; i++) {
    const n = norm(tokens[i]);
    stream += n;
    for (let j = 0; j < n.length; j++) tokOf.push(i);
  }
  const out = [];
  let misses = 0;
  let p = 0;
  for (const e of entries) {
    const en = norm(e.word);
    if (!en) continue; // untranslated ("-") or pure punctuation
    let at = stream.startsWith(en, p) ? p : stream.indexOf(en, p);
    if (at === -1 || at > p + 40) { misses++; continue; }
    p = at + en.length;
    if (e.strongs) {
      const t0 = tokOf[at];
      const t1 = tokOf[p - 1];
      out.push([t0, t1 - t0 + 1, e.strongs, e.orig, e.translit, e.parsing]);
    }
  }
  return { out, misses };
}

console.log('parsing translation tables…');
const tsv = readFileSync(tablesPath, 'utf8');
const alignByBook = new Map();  // osis -> { "C.V": [...] }
const occurrences = new Map();  // "H1254" -> [refStr, ...] (deduped per verse)
let curVerse = null;            // { osis, c, v, entries }
let aligned = 0;
let missed = 0;
let unknownRefs = 0;

function flushVerse() {
  if (!curVerse) return;
  const { osis, c, v, entries } = curVerse;
  const text = texts.get(osis)?.[c - 1]?.[v - 1];
  curVerse = null;
  if (!text) { unknownRefs++; return; }
  entries.sort((a, b) => a.sort - b.sort);
  const { out, misses } = alignVerse(text.split(' '), entries);
  aligned += out.length;
  missed += misses;
  if (!out.length) return;
  let bookAlign = alignByBook.get(osis);
  if (!bookAlign) alignByBook.set(osis, (bookAlign = {}));
  bookAlign[`${c}.${v}`] = out;
  const ref = `${osis}.${c}.${v}`;
  const seen = new Set();
  for (const [, , strongs] of out) {
    if (seen.has(strongs)) continue;
    seen.add(strongs);
    (occurrences.get(strongs) ?? occurrences.set(strongs, []).get(strongs)).push(ref);
  }
}

let lineStart = tsv.indexOf('\n') + 1; // skip header
while (lineStart < tsv.length) {
  let lineEnd = tsv.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = tsv.length;
  const f = tsv.slice(lineStart, lineEnd).split('\t');
  lineStart = lineEnd + 1;
  if (f.length < 19) continue;

  // A populated VerseId column marks the first row of a new verse.
  const verseId = f[12];
  if (verseId) {
    flushVerse();
    const m = /^(.+?) (\d+):(\d+)$/.exec(verseId.trim());
    const osis = m && OSIS[m[1]];
    curVerse = osis
      ? { osis, c: parseInt(m[2], 10), v: parseInt(m[3], 10), entries: [] }
      : null;
    if (!osis) unknownRefs++;
  }
  if (!curVerse) continue;

  const word = f[18].trim();
  const orig = f[5].trim();
  if (!word && !orig) continue; // padding rows
  const strongs = f[10] ? `H${f[10].trim()}` : f[11] ? `G${f[11].trim()}` : null;
  curVerse.entries.push({
    sort: parseFloat(f[2]) || 0,
    word,
    orig,
    translit: f[7].trim(),
    parsing: f[9].trim(),
    strongs,
  });
}
flushVerse();

for (const { osis } of books) {
  writeFileSync(path.join(OUT, 'align', `${osis}.json`), JSON.stringify(alignByBook.get(osis) ?? {}));
}
const missRate = ((missed / Math.max(aligned + missed, 1)) * 100).toFixed(2);
console.log(`aligned ${aligned} words (${missed} unmatched, ${missRate}%; ${unknownRefs} refs outside canon)`);

/* ---------- cross references ---------- */

const zipPath = path.join(CACHE, 'cross-references.zip');
download(XREF_URL, zipPath);
execFileSync('unzip', ['-o', '-q', '-d', CACHE, zipPath]);
const lines = readFileSync(path.join(CACHE, 'cross_references.txt'), 'utf8').split('\n');

function parseXref(raw) {
  // "Gen.1.1" or range "Gen.1.1-Gen.1.5" (use the range start)
  const first = raw.split('-')[0];
  const [bk, c, v] = first.split('.');
  if (!bk || !c || !v) return null;
  const chapter = parseInt(c, 10);
  const verse = parseInt(v, 10);
  const counts = validVerse.get(bk);
  if (!counts || !counts[chapter - 1] || verse < 1 || verse > counts[chapter - 1]) return null;
  return `${bk}.${chapter}.${verse}`;
}

const refsByBook = new Map(); // osis -> { "C.V": [[to, votes], ...] }
let kept = 0;
for (const line of lines.slice(1)) {
  if (!line.trim()) continue;
  const [fromRaw, toRaw, votesRaw] = line.split('\t');
  const votes = parseInt(votesRaw, 10);
  if (!Number.isFinite(votes) || votes < 0) continue;
  const from = parseXref(fromRaw);
  const to = parseXref(toRaw);
  if (!from || !to || from === to) continue;
  const [bk, c, v] = from.split('.');
  let bookRefs = refsByBook.get(bk);
  if (!bookRefs) refsByBook.set(bk, (bookRefs = {}));
  (bookRefs[`${c}.${v}`] ??= []).push([to, votes]);
  kept++;
}

for (const { osis } of books) {
  const bookRefs = refsByBook.get(osis) ?? {};
  for (const key of Object.keys(bookRefs)) {
    bookRefs[key].sort((a, b) => b[1] - a[1]);
    bookRefs[key] = bookRefs[key].slice(0, MAX_REFS_PER_VERSE);
  }
  writeFileSync(path.join(OUT, 'refs', `${osis}.json`), JSON.stringify(bookRefs));
}
console.log(`processed ${kept} cross-references into ${books.length} ref files`);

/* ---------- Strong's lexicon, sharded and merged with occurrences ---------- */

const hebPath = path.join(CACHE, 'strongs-hebrew.js');
const grkPath = path.join(CACHE, 'strongs-greek.js');
download(STRONGS_HEB_URL, hebPath);
download(STRONGS_GRK_URL, grkPath);

function parseDictionary(file) {
  const src = readFileSync(file, 'utf8');
  const m = src.match(/=\s*(\{[\s\S]*\});?\s*(?:module\.exports[\s\S]*)?$/);
  if (!m) throw new Error(`could not extract dictionary JSON from ${file}`);
  return JSON.parse(m[1]);
}

const dict = { ...parseDictionary(hebPath), ...parseDictionary(grkPath) };

/** Cap a lemma's refs at MAX_OCCURRENCES, sampled evenly across the canon. */
function sampleRefs(refs) {
  if (refs.length <= MAX_OCCURRENCES) return refs;
  const out = [];
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    out.push(refs[Math.floor((i * (refs.length - 1)) / (MAX_OCCURRENCES - 1))]);
  }
  return out;
}

const shards = new Map(); // "H12" -> { "H1254": {...} }
for (const [key, refs] of occurrences) {
  const entry = dict[key] ?? {};
  const shardKey = key[0] + Math.floor(parseInt(key.slice(1), 10) / 100);
  let shard = shards.get(shardKey);
  if (!shard) shards.set(shardKey, (shard = {}));
  shard[key] = {
    l: entry.lemma ?? '',
    t: entry.xlit ?? entry.translit ?? '',
    p: entry.pron ?? '',
    d: entry.strongs_def?.trim() ?? '',
    k: entry.kjv_def?.trim() ?? '',
    v: entry.derivation?.trim() ?? '',
    n: refs.length,
    o: sampleRefs(refs),
  };
}
for (const [shardKey, shard] of shards) {
  writeFileSync(path.join(OUT, 'lex', `${shardKey}.json`), JSON.stringify(shard));
}
console.log(`wrote ${shards.size} lexicon shards covering ${occurrences.size} Strong's entries`);

/* ---------- place geocoding (OpenBible.info Bible Geocoding) ---------- */

const geoPath = path.join(CACHE, 'ancient.jsonl');
download(GEO_URL, geoPath);

/**
 * Token spans in a verse whose normalized text spells out the place name
 * (multi-word names span tokens). The first raw token of a span must be
 * capitalized — place names are proper nouns, and candidates like "On" or
 * "No" would otherwise match prepositions anywhere in the verse.
 */
function placeSpans(tokens, normToks, name) {
  const target = norm(name);
  if (!target) return [];
  const spans = [];
  for (let i = 0; i < normToks.length; i++) {
    if (!normToks[i] || !target.startsWith(normToks[i])) continue;
    if (!/^[^\p{L}]*\p{Lu}/u.test(tokens[i])) continue;
    let acc = normToks[i];
    let j = i;
    while (acc.length < target.length && normToks[j + 1]) acc += normToks[++j];
    if (acc === target) spans.push([i, j - i + 1]);
  }
  return spans;
}

const geoByBook = new Map(); // osis -> { "C.V": [[start, len, placeId], ...] }
const placeIndex = {};       // id -> [name, lat, lon, type]
let placeMatches = 0;
let placeMisses = 0;

for (const line of readFileSync(geoPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  if (!r.id || !r.friendly_id || !r.verses?.length) continue;

  // Best identification's representative point ("lon,lat").
  let lonlat = null;
  outer: for (const ident of r.identifications ?? []) {
    for (const res of ident.resolutions ?? []) {
      if (res.lonlat) { lonlat = res.lonlat; break outer; }
    }
  }
  if (!lonlat) continue;
  const [lon, lat] = lonlat.split(',').map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

  // "Aphek 2" -> "Aphek"; the digit only disambiguates same-named places.
  const display = r.friendly_id.replace(/\s+\d+$/, '');
  // Try the spellings translations actually use, commonest first.
  const names = Object.entries(r.translation_name_counts ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([n]) => n);
  if (!names.includes(display)) names.push(display);

  let used = false;
  for (const v of r.verses) {
    const [bk, c, vv] = (v.osis ?? '').split('-')[0].split('.');
    const chapter = parseInt(c, 10);
    const verse = parseInt(vv, 10);
    const counts = validVerse.get(bk);
    if (!counts || !counts[chapter - 1] || verse < 1 || verse > counts[chapter - 1]) continue;
    const text = texts.get(bk)[chapter - 1]?.[verse - 1];
    if (!text) continue;

    const tokens = text.split(' ');
    const normToks = tokens.map((t) => norm(t.replace(/[’']s$/, '')));
    let spans = [];
    for (const name of names) {
      spans = placeSpans(tokens, normToks, name);
      if (spans.length) break;
    }

    let bookGeo = geoByBook.get(bk);
    if (!bookGeo) geoByBook.set(bk, (bookGeo = {}));
    const list = (bookGeo[`${chapter}.${verse}`] ??= []);
    if (spans.length) {
      placeMatches += spans.length;
      for (const [s, n] of spans) list.push([s, n, r.id]);
    } else {
      placeMisses++;
      list.push([-1, 0, r.id]);
    }
    used = true;
  }
  if (used) placeIndex[r.id] = [display, +lat.toFixed(4), +lon.toFixed(4), r.types?.[0] ?? ''];
}

for (const { osis } of books) {
  const bookGeo = geoByBook.get(osis) ?? {};
  for (const key of Object.keys(bookGeo)) {
    bookGeo[key].sort((a, b) => (a[0] < 0) - (b[0] < 0) || a[0] - b[0]);
  }
  writeFileSync(path.join(OUT, 'geo', `${osis}.json`), JSON.stringify(bookGeo));
}
writeFileSync(path.join(OUT, 'places.json'), JSON.stringify(placeIndex));
console.log(`geocoded ${Object.keys(placeIndex).length} places; ` +
  `${placeMatches} word-level matches, ${placeMisses} verse-only mentions`);
