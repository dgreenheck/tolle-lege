/**
 * Tolle Lege — a 3D Bible study tool.
 * Scripture renders as an open book filling the left of the view; the
 * study panel on the right holds the metadata for whatever is selected.
 * Click a word to study the Greek or Hebrew behind it; drag across words
 * to select a passage; click a rubric verse number for cross-references.
 * Panel rows navigate the book — your place is kept in the history.
 */
import { Scene3D } from './scene3d.js';
import { Book3D, PAGE_H, BOOK_HALF_W } from './book.js';
import { Panel } from './panel.js';
import {
  crossRefs, parseRef, loadBooks, loadBookText, bookInfo, formatRef, verseText,
  wordAlignment, lexEntry, lemmaOccurrences, versePlaces,
} from './data.js';

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
  // Make sure the book + panel typeset with the real fonts.
  try {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))]);
  } catch { /* fonts are a nicety, not a requirement */ }

  const scene3d = new Scene3D(document.getElementById('gl'));
  scene3d.fit = { w: BOOK_HALF_W * 2 + 1.0, h: PAGE_H + 1.1 };
  scene3d.refit();

  const panel = new Panel(document.getElementById('side'), { onNavigate: followRef });
  let selectionToken = 0;

  const book = new Book3D(scene3d, {
    onPageChange: () => syncNavSoon(),

    // Single word: the original language behind it + its concordance.
    onSelect: async ({ osis, chapter, verse, word, wordIdx, at }) => {
      const token = ++selectionToken;
      const refLabel = `${bookInfo(osis).name} ${chapter}:${verse}`;
      const ref = `${osis}.${chapter}.${verse}`;

      if (wordIdx != null) {
        const align = await wordAlignment(osis, chapter, verse, wordIdx);
        if (token !== selectionToken) return;
        if (align) {
          const lex = await lexEntry(align.strongs);
          const [occurrences, xrefs, places] = await Promise.all([
            lemmaOccurrences(lex, ref, 8),
            crossRefs(osis, chapter, verse, 8),
            versePlaces(osis, chapter, verse),
          ]);
          if (token !== selectionToken) return;
          const clean = word.replace(/[^\p{L}\p{N}'’-]+$/u, '');
          panel.showWord({
            label: `${refLabel} — “${clean}”`,
            align, lex, occurrences, crossRefs: xrefs,
            places, at,
            selectedPlaceId: places.find(
              (p) => wordIdx >= p.start && wordIdx < p.start + p.len,
            )?.id ?? null,
          });
          return;
        }
      }

      // Verse number (or a word with no original-language tag).
      const [xrefs, text, places] = await Promise.all([
        crossRefs(osis, chapter, verse, 12),
        verseText(ref),
        versePlaces(osis, chapter, verse),
      ]);
      if (token !== selectionToken) return;
      panel.showVerse({ label: refLabel, text, crossRefs: xrefs, places });
    },

    // Dragged passage: its verses + aggregated cross-references.
    onSelectRange: async ({ osis, c0, v0, c1, v1 }) => {
      const token = ++selectionToken;
      const text = await loadBookText(osis);
      const verses = [];
      for (let c = c0; c <= c1 && verses.length < 60; c++) {
        const chapterVerses = text[c - 1] ?? [];
        const from = c === c0 ? v0 : 1;
        const to = c === c1 ? v1 : chapterVerses.length;
        for (let v = from; v <= to && verses.length < 60; v++) {
          verses.push({ chapter: c, verse: v, text: chapterVerses[v - 1] ?? '' });
        }
      }

      const inRange = (ref) => {
        const r = parseRef(ref);
        return r.osis === osis &&
          (r.chapter > c0 || (r.chapter === c0 && r.verse >= v0)) &&
          (r.chapter < c1 || (r.chapter === c1 && r.verse <= v1));
      };
      const best = new Map();
      const placeMap = new Map();
      for (const v of verses) {
        for (const r of await crossRefs(osis, v.chapter, v.verse, 6)) {
          if (inRange(r.ref)) continue;
          if ((best.get(r.ref)?.votes ?? -1) < r.votes) best.set(r.ref, r);
        }
        for (const p of await versePlaces(osis, v.chapter, v.verse)) {
          if (!placeMap.has(p.id)) placeMap.set(p.id, p);
        }
      }
      if (token !== selectionToken) return;

      const name = bookInfo(osis).name;
      const label = c0 === c1
        ? v0 === v1 ? `${name} ${c0}:${v0}` : `${name} ${c0}:${v0}–${v1}`
        : `${name} ${c0}:${v0}–${c1}:${v1}`;
      panel.showPassage({
        label,
        verses,
        crossRefs: [...best.values()].sort((a, b) => b.votes - a.votes).slice(0, 12),
        places: [...placeMap.values()].slice(0, 40),
      });
    },

    onClear: () => {
      selectionToken++;
      panel.showEmpty();
    },
  });

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
    if (entry.sel?.range) {
      const { c0, v0, c1, v1 } = entry.sel.range;
      book.selectRange(c0, v0, c1, v1);
    } else if (entry.sel) {
      book.selectVerseWord(entry.sel.chapter, entry.sel.verse, entry.sel.word);
    }
    syncNav();
  }

  /** Follow a reference row in the panel. */
  function followRef(ref) {
    const { osis, chapter, verse } = parseRef(ref);
    flashHint(`Following the thread to ${formatRef(ref)}`);
    navTo(osis, chapter, { verse, flash: true });
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

  /* ---------- about / attributions dialog ---------- */

  const about = document.getElementById('about');
  document.getElementById('about-btn').addEventListener('click', () => about.showModal());
  document.getElementById('about-close').addEventListener('click', () => about.close());
  about.addEventListener('click', (e) => { if (e.target === about) about.close(); });

  /* ---------- pointer + keyboard routing ---------- */

  const canvas = scene3d.canvas;
  let drag = null; // { start: token|null, last: token, x, y, started }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = book.pick(e.clientX, e.clientY);
    drag = {
      start: p?.type === 'word' ? p.token : null,
      last: p?.type === 'word' ? p.token : null,
      x: e.clientX, y: e.clientY, started: false,
    };
  });

  window.addEventListener('pointermove', (e) => {
    if (drag?.start) {
      if (!drag.started && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) {
        drag.started = true;
      }
      if (drag.started) {
        const p = book.pick(e.clientX, e.clientY);
        if (p?.type === 'word') drag.last = p.token;
        book.selectRange(drag.start.chapter, drag.start.verse,
          drag.last.chapter, drag.last.verse, false);
        return;
      }
    }
    const overWord = book.hover(e.clientX, e.clientY);
    document.body.style.cursor = overWord ? 'pointer' : '';
  });

  window.addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.started && d.start) {
      book.selectRange(d.start.chapter, d.start.verse, d.last.chapter, d.last.verse);
      return;
    }
    if (e.target === canvas) book.handleClick(e.clientX, e.clientY);
  });

  window.addEventListener('keydown', (e) => {
    if (about.open) return; // the dialog owns the keyboard while open
    if (e.key === 'Escape') {
      if (panel.handleEscape()) return; // an expanded map closes first
      book.clearSelection();
    }
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
