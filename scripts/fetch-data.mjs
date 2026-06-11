/**
 * Data pipeline: downloads the Douay-Rheims text (getbible.net) and the
 * OpenBible.info cross-reference dataset (CC-BY), then processes them into
 * compact per-book JSON files under public/data/.
 *
 *   node scripts/fetch-data.mjs
 *
 * Outputs:
 *   public/data/books.json        — canon index [{ osis, name, chapters }]
 *   public/data/text/{osis}.json  — [[verse, ...], ...] chapters of verse strings
 *   public/data/refs/{osis}.json  — { "C.V": [[targetOsisRef, votes], ...] }
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');

const BIBLE_URL = 'https://api.getbible.net/v2/douayrheims.json';
const XREF_URL = 'https://a.openbible.info/data/cross-references.zip';

// Modern book name (as used by the getbible Douay-Rheims module) -> OSIS id
// (the id scheme used by the OpenBible cross-reference dataset).
const OSIS = {
  'Genesis': 'Gen', 'Exodus': 'Exod', 'Leviticus': 'Lev', 'Numbers': 'Num',
  'Deuteronomy': 'Deut', 'Joshua': 'Josh', 'Judges': 'Judg', 'Ruth': 'Ruth',
  '1 Samuel': '1Sam', '2 Samuel': '2Sam', '1 Kings': '1Kgs', '2 Kings': '2Kgs',
  '1 Chronicles': '1Chr', '2 Chronicles': '2Chr', 'Ezra': 'Ezra', 'Nehemiah': 'Neh',
  'Tobit': 'Tob', 'Judith': 'Jdt', 'Esther': 'Esth', 'Job': 'Job',
  'Psalms': 'Ps', 'Proverbs': 'Prov', 'Ecclesiastes': 'Eccl', 'Song of Songs': 'Song',
  'Wisdom': 'Wis', 'Sirach': 'Sir', 'Isaiah': 'Isa', 'Jeremiah': 'Jer',
  'Lamentations': 'Lam', 'Baruch': 'Bar', 'Ezekiel': 'Ezek', 'Daniel': 'Dan',
  'Hosea': 'Hos', 'Joel': 'Joel', 'Amos': 'Amos', 'Obadiah': 'Obad',
  'Jonah': 'Jonah', 'Micah': 'Mic', 'Nahum': 'Nah', 'Habakkuk': 'Hab',
  'Zephaniah': 'Zeph', 'Haggai': 'Hag', 'Zechariah': 'Zech', 'Malachi': 'Mal',
  '1 Maccabees': '1Macc', '2 Maccabees': '2Macc',
  'Matthew': 'Matt', 'Mark': 'Mark', 'Luke': 'Luke', 'John': 'John', 'Acts': 'Acts',
  'Romans': 'Rom', '1 Corinthians': '1Cor', '2 Corinthians': '2Cor',
  'Galatians': 'Gal', 'Ephesians': 'Eph', 'Philippians': 'Phil', 'Colossians': 'Col',
  '1 Thessalonians': '1Thess', '2 Thessalonians': '2Thess',
  '1 Timothy': '1Tim', '2 Timothy': '2Tim', 'Titus': 'Titus', 'Philemon': 'Phlm',
  'Hebrews': 'Heb', 'James': 'Jas', '1 Peter': '1Pet', '2 Peter': '2Pet',
  '1 John': '1John', '2 John': '2John', '3 John': '3John', 'Jude': 'Jude',
  'Revelation': 'Rev',
};

const MAX_REFS_PER_VERSE = 14;

/**
 * The cross-reference dataset uses Hebrew (KJV) Psalm numbering; this
 * Douay-Rheims text uses Septuagint/Vulgate numbering. Remap Hebrew -> LXX.
 * Within-psalm verse numbers line up because this edition merges titles
 * into verse 1, matching KJV verse counts.
 */
function psalmHebrewToLXX(c, v) {
  if (c <= 8 || c >= 148) return [c, v];
  if (c === 9) return [9, v];
  if (c === 10) return [9, v + 21];
  if (c <= 113) return [c - 1, v];
  if (c === 114) return [113, v];
  if (c === 115) return [113, v + 8];
  if (c === 116) return v <= 9 ? [114, v] : [115, v - 9];
  if (c <= 146) return [c - 1, v];
  /* c === 147 */ return v <= 11 ? [146, v] : [147, v - 11];
}

function download(url, dest) {
  if (existsSync(dest)) { console.log(`cached: ${dest}`); return; }
  console.log(`downloading ${url}`);
  execFileSync('curl', ['-sL', '--fail', '--max-time', '300', url, '-o', dest], { stdio: 'inherit' });
}

mkdirSync(CACHE, { recursive: true });
mkdirSync(path.join(OUT, 'text'), { recursive: true });
mkdirSync(path.join(OUT, 'refs'), { recursive: true });

// ---- Bible text ----
const biblePath = path.join(CACHE, 'douayrheims.json');
download(BIBLE_URL, biblePath);
const bible = JSON.parse(readFileSync(biblePath, 'utf8'));

const books = [];
const validVerse = new Map(); // osis -> [versesPerChapter]
for (const book of bible.books) {
  const osis = OSIS[book.name];
  if (!osis) { console.warn(`no OSIS mapping for "${book.name}" — skipped`); continue; }
  const chapters = [];
  for (const ch of book.chapters) {
    chapters[ch.chapter - 1] = ch.verses
      .sort((a, b) => a.verse - b.verse)
      .map((v) => v.text.trim().replace(/\s+/g, ' '));
  }
  books.push({ osis, name: book.name, chapters: chapters.length });
  validVerse.set(osis, chapters.map((c) => c.length));
  writeFileSync(path.join(OUT, 'text', `${osis}.json`), JSON.stringify(chapters));
}
writeFileSync(path.join(OUT, 'books.json'), JSON.stringify(books));
console.log(`wrote ${books.length} books`);

// ---- Cross references ----
const zipPath = path.join(CACHE, 'cross-references.zip');
download(XREF_URL, zipPath);
execFileSync('unzip', ['-o', '-q', '-d', CACHE, zipPath]);
const lines = readFileSync(path.join(CACHE, 'cross_references.txt'), 'utf8').split('\n');

function parseRef(raw) {
  // "Gen.1.1" or range "Gen.1.1-Gen.1.5" (use the range start)
  const first = raw.split('-')[0];
  const [bk, c, v] = first.split('.');
  if (!bk || !c || !v) return null;
  let chapter = parseInt(c, 10);
  let verse = parseInt(v, 10);
  if (bk === 'Ps') [chapter, verse] = psalmHebrewToLXX(chapter, verse);
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
  const from = parseRef(fromRaw);
  const to = parseRef(toRaw);
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
