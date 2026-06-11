/**
 * The study UI, in three parts:
 *  - a fixed glass sidebar holding the current selection's references —
 *    collapsible sections that each scroll within the card's fixed height;
 *  - a map card below it (geocoded places for the selection) that can
 *    expand into a full-screen overlay;
 *  - a small popover that appears beside a clicked word with the
 *    original-language translation behind it.
 * All reference rows navigate the book.
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TILE_ATTR = 'Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics';

const EMPTY_HINT =
  'Click a word to study the Greek or Hebrew behind it. ' +
  'Drag across words to select a passage. ' +
  'Click a verse number for its cross-references. ' +
  'Place names are inked in blue — click one to see it on the map.';

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export class Panel {
  /** onNavigate: (osisRef) => void — follow a reference row. */
  constructor(root, { onNavigate }) {
    this.root = root; // #side column
    this.label = root.querySelector('#study-label');
    this.body = root.querySelector('#study-body');
    this.mapCard = root.querySelector('#map-card');
    this.mapBody = root.querySelector('#map-body');
    this.pop = document.getElementById('word-pop');
    this.onNavigate = onNavigate;
    this.map = null;
    this.mapWrap = null;
    this.collapsed = new Set(); // section titles the user has closed

    this.mapOverlay = document.getElementById('map-overlay');
    this.mapFrame = document.getElementById('map-overlay-frame');
    root.querySelector('#map-expand').addEventListener('click', () => this.expandMap());
    document.getElementById('map-overlay-close').addEventListener('click', () => this.collapseMap());
    this.mapOverlay.addEventListener('click', (e) => {
      if (e.target === this.mapOverlay) this.collapseMap();
    });

    this.showEmpty();
  }

  /** Esc steps inward: an expanded map closes before the selection does. */
  handleEscape() {
    return this.collapseMap();
  }

  #reset() {
    this.collapseMap();
    this.map?.remove();
    this.map = null;
    this.mapWrap = null;
    this.mapBody.replaceChildren();
    this.mapCard.hidden = true;
    this.pop.hidden = true;
    this.body.replaceChildren();
  }

  showEmpty() {
    this.#reset();
    this.label.textContent = 'Study';
    this.body.appendChild(el('div', 'panel-empty', EMPTY_HINT));
  }

  /**
   * A collapsible sidebar section; returns the element to fill. Collapse
   * state is remembered by title across selections.
   */
  #section(title) {
    const sec = el('section', 'study-sec');
    if (this.collapsed.has(title)) sec.classList.add('collapsed');

    const head = el('button', 'sec-head');
    head.setAttribute('aria-expanded', String(!this.collapsed.has(title)));
    head.append(el('span', 'sec-title', title), el('span', 'sec-chev', '▾'));
    head.addEventListener('click', () => {
      const closed = sec.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', String(!closed));
      if (closed) this.collapsed.add(title);
      else this.collapsed.delete(title);
    });

    const content = el('div', 'sec-body');
    sec.append(head, content);
    this.body.appendChild(sec);
    return content;
  }

  #refList(parent, refs) {
    if (!refs.length) {
      parent.appendChild(el('div', 'ref-none', 'None recorded.'));
      return;
    }
    for (const r of refs) {
      const b = el('button', 'ref-item');
      b.append(el('span', 'ref-label', r.label), el('span', 'ref-text', r.text));
      b.addEventListener('click', () => this.onNavigate(r.ref));
      parent.appendChild(b);
    }
  }

  /* ---------- the word popover ---------- */

  /**
   * The translation card beside the clicked word. at: { left, x, y } —
   * the word's screen-space edges; the card sits to its right, flipping
   * left when it would run under the sidebar.
   */
  #popover(at, align, lex) {
    const pop = this.pop;
    pop.replaceChildren();

    const top = el('div', 'pop-top');
    const close = el('button', 'pop-close', '✕');
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close translation card');
    close.addEventListener('click', () => { pop.hidden = true; });
    top.append(el('div', 'pop-lang', align.strongs[0] === 'H' ? 'Hebrew' : 'Greek'), close);
    pop.appendChild(top);
    const head = el('div', 'lex-head');
    const orig = el('span', 'lex-orig', align.orig);
    orig.setAttribute('dir', 'auto');
    head.append(
      orig,
      el('span', 'lex-translit', align.translit),
      el('span', 'lex-strongs', `Strong's ${align.strongs}`),
    );
    pop.appendChild(head);
    if (align.parsing) pop.appendChild(el('div', 'lex-parsing', align.parsing));
    if (lex?.d) pop.appendChild(el('div', 'lex-def', lex.d));
    if (lex?.v) pop.appendChild(el('div', 'lex-deriv', lex.v));
    if (lex?.k) {
      const k = el('div', 'lex-kjv');
      k.append(el('span', 'lex-label', 'KJV renderings: '), document.createTextNode(lex.k));
      pop.appendChild(k);
    }
    if (lex?.n) {
      pop.appendChild(el('div', 'lex-count', `Found in ${lex.n} verse${lex.n === 1 ? '' : 's'} of Scripture`));
    }

    pop.hidden = false;
    pop.style.visibility = 'hidden';
    pop.style.left = '0px';
    pop.style.top = '0px';
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const sideLeft = this.root.getBoundingClientRect().left;
    let x = at.x + 16;
    if (x + w > sideLeft - 12) x = at.left - w - 16; // flip to the word's left
    x = Math.max(x, 12);
    const y = Math.min(Math.max(at.y - h / 2, 70), window.innerHeight - h - 16);
    pop.style.left = `${Math.round(x)}px`;
    pop.style.top = `${Math.round(y)}px`;
    pop.style.visibility = '';
  }

  /* ---------- places + map card ---------- */

  /**
   * Fill the map card: a chip per place over a small map. selectedId
   * pre-opens that place's popup (the clicked word). Duplicate ids (a name
   * repeated in the verse) collapse to one marker. No places = card hidden.
   */
  #placesCard(places, selectedId = null) {
    const uniq = [...new Map((places ?? []).map((p) => [p.id, p])).values()];
    if (!uniq.length) return;

    this.mapCard.hidden = false;
    const chips = el('div', 'place-chips');
    this.mapWrap = el('div', 'map-wrap');
    this.mapBody.append(chips, this.mapWrap);

    const map = L.map(this.mapWrap, { scrollWheelZoom: false, zoomSnap: 0.5 });
    this.map = map;
    L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 14 }).addTo(map);

    for (const p of uniq) {
      const sel = p.id === selectedId;
      const marker = L.circleMarker([p.lat, p.lon], {
        radius: sel ? 8 : 6,
        color: '#3b2a12',
        weight: 1.5,
        fillColor: sel ? '#f0cf85' : '#d4af5a',
        fillOpacity: 0.95,
      }).addTo(map);
      const label = p.type ? `${p.name} · ${p.type}` : p.name;
      marker.bindPopup(label);

      const chip = el('button', sel ? 'place-chip selected' : 'place-chip', p.name);
      chip.title = label;
      chip.addEventListener('click', () => {
        map.setView([p.lat, p.lon], Math.max(map.getZoom(), 8));
        marker.openPopup();
      });
      chips.appendChild(chip);

      if (sel) setTimeout(() => marker.openPopup(), 0);
    }

    if (uniq.length === 1) {
      map.setView([uniq[0].lat, uniq[0].lon], 7);
    } else {
      map.fitBounds(L.latLngBounds(uniq.map((p) => [p.lat, p.lon])).pad(0.3), { maxZoom: 8 });
    }
  }

  /** Lift the live map into the full-screen overlay (same Leaflet instance). */
  expandMap() {
    if (!this.map || !this.mapOverlay.hidden) return;
    this.mapFrame.appendChild(this.mapWrap);
    this.mapOverlay.hidden = false;
    this.map.scrollWheelZoom.enable();
    this.map.invalidateSize();
  }

  /** Put an expanded map back in its card. True if it was open. */
  collapseMap() {
    if (this.mapOverlay.hidden) return false;
    this.mapOverlay.hidden = true;
    if (this.map && this.mapWrap) {
      this.mapBody.appendChild(this.mapWrap);
      this.map.scrollWheelZoom.disable();
      this.map.invalidateSize();
    }
    return true;
  }

  /* ---------- selection views ---------- */

  /**
   * A single word: the translation pops up beside the word; the sidebar
   * carries the concordance and cross-references; places fill the map card.
   */
  showWord({ label, align, lex, occurrences, crossRefs, places, selectedPlaceId, at }) {
    this.#reset();
    this.label.textContent = label;
    this.#refList(this.#section('Same word elsewhere'), occurrences);
    this.#refList(this.#section('Cross-references'), crossRefs);
    this.#placesCard(places, selectedPlaceId);
    if (at) this.#popover(at, align, lex);
  }

  /** A verse (verse-number click): text + cross-references + places. */
  showVerse({ label, text, crossRefs, places }) {
    this.#reset();
    this.label.textContent = label;
    if (text) this.#section('Text').appendChild(el('div', 'sel-text', text));
    this.#refList(this.#section('Cross-references'), crossRefs);
    this.#placesCard(places);
  }

  /** A dragged passage: verses + aggregated cross-references + places. */
  showPassage({ label, verses, crossRefs, places }) {
    this.#reset();
    this.label.textContent = label;
    const t = el('div', 'sel-text');
    for (const v of verses) {
      t.appendChild(el('span', 'vn', String(v.verse)));
      t.appendChild(document.createTextNode(`${v.text} `));
    }
    this.#section('Text').appendChild(t);
    this.#refList(this.#section('Cross-references'), crossRefs);
    this.#placesCard(places);
  }
}
