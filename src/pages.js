/**
 * Page layout + typesetting: flows an ENTIRE BOOK's chapters into a
 * continuous sequence of pages (chapter headings inline, like a real bible)
 * and draws each page onto a canvas. Page numbers run through the book.
 * Every word token records its rect for raycast hit-testing.
 */

export const PAGE = {
  W: 1024,
  H: 1408,
  marginX: 96,
  top: 158,
  bottom: 120,
  lineH: 58,
  ascent: 42,
  descent: 14,
  cornerZone: 150,
  bookTitleH: 190,
  headingH: 152,
  font: '40px "EB Garamond", Georgia, serif',
  vnumFont: '26px "EB Garamond", Georgia, serif',
  bookTitleFont: '600 64px "Cormorant SC", "EB Garamond", Georgia, serif',
  headingFont: '600 40px "Cormorant SC", "EB Garamond", Georgia, serif',
  runningFont: '500 27px "Cormorant SC", "EB Garamond", Georgia, serif',
  folioFont: 'italic 26px "EB Garamond", Georgia, serif',
};

const INK = '#2e2316';
const RUBRIC = '#9b3a20';
const GOLD_BROWN = '#7c5a1e';

let mctx = null;
function measurer() {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  return mctx;
}

/**
 * chapters: array of chapters, each an array of verse strings.
 * Returns pages: [{ number, items, tokens, firstChapter }]
 *   item:  { type: 'bookTitle'|'heading', chapter?, y }
 *   token: { type: 'word'|'vnum', str, chapter, verse, word?, x, y, w, rx, ry, rw, rh }
 *
 * With collect:false, runs the identical flow but retains nothing — used to
 * count a book's pages cheaply for absolute folio numbering.
 */
export function layoutBook(chapters, collect = true) {
  const ctx = measurer();
  const pages = [];
  const maxX = PAGE.W - PAGE.marginX;
  const maxY = PAGE.H - PAGE.bottom;
  let pageCount = 0;

  let page = newPage(1);
  let y = PAGE.top;
  let x = PAGE.marginX;

  ctx.font = PAGE.font;
  const spaceW = ctx.measureText(' ').width;

  function newPage(number) {
    return { number, items: [], tokens: [], tokenCount: 0, firstChapter: null };
  }

  function breakPage() {
    if (collect) pages.push(page);
    pageCount++;
    page = newPage(page.number + 1);
    y = PAGE.top;
    x = PAGE.marginX;
  }

  function newline() {
    x = PAGE.marginX;
    y += PAGE.lineH;
    if (y > maxY) breakPage();
  }

  function place(token, w) {
    if (x + w > maxX && x > PAGE.marginX) newline();
    page.tokenCount++;
    if (collect) {
      token.x = x;
      token.y = y;
      token.w = w;
      token.rx = x - 2;
      token.ry = y - PAGE.ascent;
      token.rw = w + 4;
      token.rh = PAGE.ascent + PAGE.descent;
      if (page.firstChapter == null) page.firstChapter = token.chapter;
      page.tokens.push(token);
    }
    x += w;
  }

  chapters.forEach((verses, ci) => {
    const chapter = ci + 1;
    const headBlock = (chapter === 1 ? PAGE.bookTitleH : 0) + PAGE.headingH;

    // Don't strand a heading at the bottom of a page.
    if (y + headBlock + 2 * PAGE.lineH > maxY && page.tokenCount) breakPage();

    if (chapter === 1) {
      if (collect) page.items.push({ type: 'bookTitle', y: y + 70 });
      y += PAGE.bookTitleH;
    }
    if (collect) {
      page.items.push({ type: 'heading', chapter, y: y + 56 });
      if (page.firstChapter == null) page.firstChapter = chapter;
    }
    y += PAGE.headingH;
    x = PAGE.marginX;

    verses.forEach((text, vi) => {
      const verse = vi + 1;

      ctx.font = PAGE.vnumFont;
      const numStr = String(verse);
      place({ type: 'vnum', str: numStr, chapter, verse }, ctx.measureText(numStr).width + 10);

      ctx.font = PAGE.font;
      text.split(' ').forEach((str, wi) => {
        place({ type: 'word', str, chapter, verse, word: wi }, ctx.measureText(str).width);
        x += spaceW;
      });
      x += spaceW * 0.6;
    });

    // End the chapter's last line; leave a little air before the next heading.
    x = PAGE.marginX;
    y += PAGE.lineH + 6;
  });

  if (page.tokenCount || page.items.length) { if (collect) pages.push(page); pageCount++; }
  return collect ? pages : pageCount;
}

/** Page count for a book without retaining the layout. */
export function countBookPages(chapters) {
  return layoutBook(chapters, false);
}

/**
 * Draw one page to a fresh canvas. page may be null (blank filler).
 * folio: absolute page number through the whole volume; null = omit
 * (offsets not yet computed).
 */
export function drawPage(page, { bookName, side, hasNext, hasPrev, folio = null }) {
  const cv = document.createElement('canvas');
  cv.width = PAGE.W;
  cv.height = PAGE.H;
  const ctx = cv.getContext('2d');

  paintPaper(ctx, side);

  if (page) {
    const showRunning = !page.items.some((it) => it.type === 'bookTitle');
    if (showRunning) {
      ctx.fillStyle = 'rgba(124, 90, 30, 0.85)';
      ctx.font = PAGE.runningFont;
      ctx.textAlign = 'center';
      ctx.fillText(bookName.toUpperCase(), PAGE.W / 2, 72);
    }

    for (const it of page.items) {
      ctx.textAlign = 'center';
      if (it.type === 'bookTitle') {
        ctx.fillStyle = GOLD_BROWN;
        ctx.font = PAGE.bookTitleFont;
        ctx.fillText(bookName.toUpperCase(), PAGE.W / 2, it.y);
        rule(ctx, PAGE.W / 2, it.y + 36, 170);
      } else {
        ctx.fillStyle = GOLD_BROWN;
        ctx.font = PAGE.headingFont;
        ctx.fillText(`CHAPTER ${it.chapter}`, PAGE.W / 2, it.y);
        rule(ctx, PAGE.W / 2, it.y + 26, 110);
      }
    }

    ctx.textAlign = 'left';
    for (const t of page.tokens) {
      if (t.type === 'vnum') {
        ctx.fillStyle = RUBRIC;
        ctx.font = PAGE.vnumFont;
        ctx.fillText(t.str, t.x, t.y - 14);
      } else {
        ctx.fillStyle = INK;
        ctx.font = PAGE.font;
        ctx.fillText(t.str, t.x, t.y);
      }
    }

    // Folio — absolute through the whole volume.
    if (folio != null) {
      ctx.fillStyle = 'rgba(46, 35, 22, 0.55)';
      ctx.font = PAGE.folioFont;
      ctx.textAlign = 'center';
      ctx.fillText(String(folio), PAGE.W / 2, PAGE.H - 56);
    }
  } else {
    ctx.fillStyle = 'rgba(124, 90, 30, 0.4)';
    ctx.font = '64px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText('✠', PAGE.W / 2, PAGE.H / 2);
  }

  const cornerX = side === 'right' ? PAGE.W : 0;
  const dirOk = side === 'right' ? hasNext : hasPrev;
  if (dirOk) drawCornerFold(ctx, cornerX, PAGE.H, side);

  return cv;
}

function paintPaper(ctx, side) {
  const bg = ctx.createLinearGradient(0, 0, 0, PAGE.H);
  bg.addColorStop(0, '#f6eedb');
  bg.addColorStop(0.5, '#f1e6cd');
  bg.addColorStop(1, '#e8d9b8');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, PAGE.W, PAGE.H);

  // Mottling for a slight parchment feel.
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * PAGE.W;
    const y = Math.random() * PAGE.H;
    const r = 20 + Math.random() * 70;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(150, 120, 70, ${Math.random() * 0.025})`);
    g.addColorStop(1, 'rgba(150, 120, 70, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Shading that matches the page curvature: deep crease at the spine,
  // a soft highlight where the paper crests, darkening at the fore-edge.
  const atLeft = side === 'right'; // the right page's spine edge is its left side
  const creaseW = 170;
  const g = ctx.createLinearGradient(atLeft ? 0 : PAGE.W, 0, atLeft ? creaseW : PAGE.W - creaseW, 0);
  g.addColorStop(0, 'rgba(50, 32, 12, 0.42)');
  g.addColorStop(0.55, 'rgba(60, 40, 15, 0.12)');
  g.addColorStop(1, 'rgba(60, 40, 15, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(atLeft ? 0 : PAGE.W - creaseW, 0, creaseW, PAGE.H);

  const crestX = atLeft ? PAGE.W * 0.32 : PAGE.W * 0.68;
  const hg = ctx.createLinearGradient(crestX - 200, 0, crestX + 200, 0);
  hg.addColorStop(0, 'rgba(255, 250, 235, 0)');
  hg.addColorStop(0.5, 'rgba(255, 250, 235, 0.30)');
  hg.addColorStop(1, 'rgba(255, 250, 235, 0)');
  ctx.fillStyle = hg;
  ctx.fillRect(crestX - 200, 0, 400, PAGE.H);

  const og = ctx.createLinearGradient(atLeft ? PAGE.W : 0, 0, atLeft ? PAGE.W - 90 : 90, 0);
  og.addColorStop(0, 'rgba(110, 80, 40, 0.22)');
  og.addColorStop(1, 'rgba(110, 80, 40, 0)');
  ctx.fillStyle = og;
  ctx.fillRect(atLeft ? PAGE.W - 90 : 0, 0, 90, PAGE.H);
}

function rule(ctx, cx, y, half) {
  const g = ctx.createLinearGradient(cx - half, y, cx + half, y);
  g.addColorStop(0, 'rgba(124, 90, 30, 0)');
  g.addColorStop(0.5, 'rgba(124, 90, 30, 0.8)');
  g.addColorStop(1, 'rgba(124, 90, 30, 0)');
  ctx.strokeStyle = g;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - half, y);
  ctx.lineTo(cx + half, y);
  ctx.stroke();
}

function drawCornerFold(ctx, cx, cy, side) {
  const s = side === 'right' ? -1 : 1;
  ctx.strokeStyle = 'rgba(110, 80, 40, 0.5)';
  ctx.lineWidth = 2;
  for (const d of [34, 52]) {
    ctx.beginPath();
    ctx.moveTo(cx + s * d, cy);
    ctx.lineTo(cx, cy - d);
    ctx.stroke();
  }
}
