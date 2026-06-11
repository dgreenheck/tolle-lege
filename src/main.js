/**
 * Verbum — a 3D Bible explorer.
 * Scripture renders as an open book. Click a word; the passages bound to its
 * verse fly in as parchment cards tied back to the word by golden threads.
 * Click a card to follow it — your place is kept in the history.
 */
import { Scene3D } from './scene3d.js';
import { Book3D } from './book.js';
import { CardField } from './cards.js';
import { ThreadField } from './threads.js';
import { crossRefs, parseRef, loadBooks, bookInfo, formatRef } from './data.js';

const hintEl = document.getElementById('hint');
const defaultHint = hintEl.textContent;
let hintTimer = null;

function flashHint(msg) {
  hintEl.textContent = msg;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hintEl.textContent = defaultHint; }, 3200);
}

/* ---------- navigation history ---------- */

class History {
  constructor() { this.back = []; this.fwd = []; }
  push(entry) { this.back.push(entry); this.fwd = []; }
  goBack(current) { if (!this.back.length) return null; this.fwd.push(current); return this.back.pop(); }
  goForward(current) { if (!this.fwd.length) return null; this.back.push(current); return this.fwd.pop(); }
}

async function start() {
  // Make sure the book + cards typeset with the real fonts.
  try {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))]);
  } catch { /* fonts are a nicety, not a requirement */ }

  const scene3d = new Scene3D(document.getElementById('gl'));
  const cards = new CardField(scene3d);
  let selectionToken = 0;

  const book = new Book3D(scene3d, {
    onPageChange: () => syncNavSoon(),
    onSelect: async ({ osis, chapter, verse, word }) => {
      const token = ++selectionToken;
      const refs = await crossRefs(osis, chapter, verse);
      if (token !== selectionToken) return;
      if (!refs.length) {
        cards.clear();
        threads.clear();
        flashHint('No recorded cross-references for this verse — try another.');
        return;
      }
      cards.show(refs, book.anchorWorld());
      threads.show();
      flashHint(`“${word.replace(/[^\p{L}\p{N}'’-]+$/u, '')}” — ${refs.length} connected passages`);
    },
    onClear: () => {
      selectionToken++;
      cards.clear();
      threads.clear();
    },
  });

  const threads = new ThreadField(scene3d, cards, () => book.anchorWorld());
  const history = new History();

  /* ---------- nav bar ---------- */

  const bookSelect = document.getElementById('book-select');
  const chapterSelect = document.getElementById('chapter-select');
  const histBack = document.getElementById('hist-back');
  const histFwd = document.getElementById('hist-fwd');

  let syncQueued = false;
  function syncNavSoon() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => { syncQueued = false; syncNav(); });
  }

  function syncNav() {
    if (!book.osis) return;
    bookSelect.value = book.osis;
    const info = bookInfo(book.osis);
    chapterSelect.innerHTML = Array.from(
      { length: info.chapters },
      (_, i) => `<option value="${i + 1}">${i + 1}</option>`,
    ).join('');
    chapterSelect.value = String(book.currentChapter());
    location.hash = `${book.osis}.${book.currentChapter()}`;

    histBack.disabled = !history.back.length;
    histFwd.disabled = !history.fwd.length;
    const last = history.back.at(-1);
    const next = history.fwd.at(-1);
    histBack.title = last ? `Back to ${bookInfo(last.osis).name} ${last.chapter}` : 'Back';
    histFwd.title = next ? `Forward to ${bookInfo(next.osis).name} ${next.chapter}` : 'Forward';
  }

  /** Navigate, recording the departed spot (incl. page + selection). */
  async function navTo(osis, chapter, opts = {}, { record = true } = {}) {
    opts.animate ??= true;
    if (record) history.push(book.current());
    await book.go(osis, chapter, opts);
    syncNav();
  }

  async function restore(entry) {
    if (!entry) return;
    await book.go(entry.osis, entry.chapter, { spread: entry.spread, animate: true });
    if (entry.sel) book.selectVerseWord(entry.sel.chapter, entry.sel.verse, entry.sel.word);
    syncNav();
  }

  bookSelect.addEventListener('change', () => navTo(bookSelect.value, 1));
  chapterSelect.addEventListener('change', () =>
    navTo(book.osis, parseInt(chapterSelect.value, 10)));
  document.getElementById('prev-ch').addEventListener('click', () => {
    const c = book.currentChapter();
    if (c > 1) navTo(book.osis, c - 1);
  });
  document.getElementById('next-ch').addEventListener('click', () => {
    const c = book.currentChapter();
    if (c < bookInfo(book.osis).chapters) navTo(book.osis, c + 1);
  });
  histBack.addEventListener('click', () => restore(history.goBack(book.current())));
  histFwd.addEventListener('click', () => restore(history.goForward(book.current())));

  /* ---------- pointer + keyboard routing ---------- */

  const canvas = scene3d.canvas;

  window.addEventListener('pointermove', (e) => {
    const overCard = cards.hoverAt(e.clientX, e.clientY);
    const overWord = !overCard && book.hover(e.clientX, e.clientY);
    document.body.style.cursor = overCard || overWord ? 'pointer' : '';
  });

  window.addEventListener('click', (e) => {
    if (e.target !== canvas) return;
    const verse = cards.pick(e.clientX, e.clientY);
    if (verse) {
      const { osis, chapter, verse: v } = parseRef(verse.ref);
      flashHint(`Following the thread to ${formatRef(verse.ref)}`);
      navTo(osis, chapter, { verse: v, flash: true });
      return;
    }
    book.handleClick(e.clientX, e.clientY);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') book.clearSelection();
    if (e.altKey && e.key === 'ArrowLeft') { histBack.click(); e.preventDefault(); return; }
    if (e.altKey && e.key === 'ArrowRight') { histFwd.click(); e.preventDefault(); return; }
    if (e.key === 'ArrowRight') book.flipPage(1);
    if (e.key === 'ArrowLeft') book.flipPage(-1);
  });

  /* ---------- boot ---------- */

  const books = await loadBooks();
  bookSelect.innerHTML = books
    .map((b) => `<option value="${b.osis}">${b.name}</option>`)
    .join('');

  let osis = 'John';
  let chapter = 1;
  const hash = location.hash.slice(1);
  if (hash) {
    const [b, c] = hash.split('.');
    if (bookInfo(b)) { osis = b; chapter = Math.max(1, parseInt(c, 10) || 1); }
  }

  await book.init();
  await Promise.all([scene3d.init(), book.go(osis, chapter)]);
  syncNav();

  // Deep-link a selection: ?sel=<verse>[.<wordIndex>]
  const sel = new URLSearchParams(location.search).get('sel');
  if (sel) {
    const [verse, wordIdx = 0] = sel.split('.').map(Number);
    setTimeout(() => book.selectVerseWord(chapter, verse, wordIdx), 400);
  }
}

start().catch((err) => {
  console.error(err);
  const div = document.createElement('div');
  div.id = 'fallback-msg';
  div.innerHTML =
    'This experience needs a browser with WebGPU or WebGL2.<br/>' +
    'Try the latest Chrome, Edge, or Safari.';
  document.body.appendChild(div);
});
