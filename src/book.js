/**
 * The 3D book: an open codex with curved pages whose surfaces are
 * canvas-typeset textures. One continuous volume — page flips run through
 * chapter and book boundaries, navigation turns a few quick pages to its
 * target, and folio numbers are absolute through the whole Bible.
 */
import * as THREE from 'three/webgpu';
import { vec3, float, positionLocal, uniform, mix } from 'three/tsl';
import { layoutBook, countBookPages, drawPage, PAGE } from './pages.js';
import { loadBooks, loadBookText, bookInfo } from './data.js';

export const PAGE_W = 5.25;
export const PAGE_H = PAGE_W * (PAGE.H / PAGE.W); // ≈ 6.32
export const BOOK_HALF_W = PAGE_W + 0.18;

const FLIP_TIME = 0.7;
const RIFFLE_TIME = 0.3;
const CURVE_SEGS = 64;
const TEX_CACHE_MAX = 16;
const LAYOUT_CACHE_MAX = 8;
// Bump the suffix whenever typesetting metrics change — cached counts go stale.
const PAGECOUNT_STORE = 'verbum-pagecounts-v2';

/**
 * Open-book cross-section. u: 0 at the spine -> 1 at the outer edge.
 * A valley dips into the binding, the paper arcs up over the page block,
 * then eases down with a slight droop at the fore-edge.
 */
export function pageProfile(u) {
  return (
    -0.30 * Math.exp(-u * 9) +
    0.105 * Math.sin(Math.PI * u ** 0.85) * (1 - 0.25 * u) -
    0.035 * u ** 3
  );
}

function profileSlope(u) {
  const e = 0.004;
  return (pageProfile(Math.min(u + e, 1)) - pageProfile(Math.max(u - e, 0))) / (2 * e);
}

/** Curved page plane. sign:+1 = spine at the left edge (a right-hand page). */
function curvedPageGeometry(sign = 1) {
  const geo = new THREE.PlaneGeometry(PAGE_W, PAGE_H, CURVE_SEGS, 1);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const u = sign > 0 ? (x + PAGE_W / 2) / PAGE_W : (PAGE_W / 2 - x) / PAGE_W;
    pos.setZ(i, pageProfile(u));
  }
  pos.needsUpdate = true;
  return geo;
}

/** Hinge-origin plane for turning pages: x runs 0..PAGE_W from the spine. */
function hingedPlaneGeometry(bow = 0) {
  const geo = new THREE.PlaneGeometry(PAGE_W, PAGE_H, CURVE_SEGS, 1);
  geo.translate(PAGE_W / 2 + 0.02, 0, 0);
  if (bow > 0) {
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) / PAGE_W;
      pos.setZ(i, bow * Math.sin(Math.PI * Math.min(Math.max(u, 0), 1)));
    }
    pos.needsUpdate = true;
  }
  return geo;
}

/** The page block under the leaves: profile on top, flat bottom, extruded. */
function pageStackGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0, pageProfile(0) - 0.02);
  for (let i = 1; i <= 40; i++) {
    const u = i / 40;
    shape.lineTo(u * PAGE_W, pageProfile(u) - 0.02);
  }
  shape.lineTo(PAGE_W, -0.5);
  shape.lineTo(0, -0.5);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: PAGE_H, bevelEnabled: false });
}

export class Book3D {
  constructor(scene3d, { onSelect, onClear, onPageChange } = {}) {
    this.s3d = scene3d;
    this.onSelect = onSelect;
    this.onClear = onClear;
    this.onPageChange = onPageChange;

    this.osis = null;
    this.pages = [];
    this.spread = 0;
    this.selection = null;
    this.flip = null;
    this.navToken = 0;

    this.order = [];               // canon order of osis ids
    this.layoutCache = new Map();  // osis -> pages[] (LRU)
    this.texCache = new Map();     // `${osis}:${idx}` -> CanvasTexture (LRU)
    this.lockedTex = new Set();    // textures in use by the flip rig
    this.pageOffsets = null;       // osis -> absolute page offset (0-based)
    this.pageCounts = null;
    this.flashQuads = [];
    this.flashLife = 0;
    this.warmupFrames = 3;         // precompile flip pipelines at boot

    this.group = new THREE.Group();
    this.group.rotation.x = -0.18;
    this.group.position.y = 0.15;
    scene3d.scene.add(this.group);
    this.#buildBody();
    this.#buildFlipRig();

    scene3d.onTick((dt) => this.#tick(dt));
  }

  /* ---------- construction ---------- */

  #buildBody() {
    const leather = new THREE.MeshBasicNodeMaterial({ color: 0x332012 });
    const leatherDark = new THREE.MeshBasicNodeMaterial({ color: 0x241509 });
    const paperEdge = new THREE.MeshBasicNodeMaterial({ color: 0xcdbb92, side: THREE.DoubleSide });

    const cover = new THREE.Mesh(
      new THREE.BoxGeometry(PAGE_W * 2 + 0.6, PAGE_H + 0.5, 0.16),
      leather,
    );
    cover.position.z = -0.59;
    this.group.add(cover);

    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.55, PAGE_H + 0.5, 0.26), leatherDark);
    spine.position.z = -0.52;
    this.group.add(spine);

    const stackGeo = pageStackGeometry();
    const stackR = new THREE.Mesh(stackGeo, paperEdge);
    stackR.rotation.x = Math.PI / 2;
    stackR.position.set(0.02, PAGE_H / 2, 0);
    const stackL = new THREE.Mesh(stackGeo, paperEdge);
    stackL.rotation.x = Math.PI / 2;
    stackL.scale.x = -1;
    stackL.position.set(-0.02, PAGE_H / 2, 0);
    this.group.add(stackR, stackL);

    this.blankTex = this.#makeTexture(drawPage(null, { bookName: '', side: 'left' }));

    this.leftMesh = new THREE.Mesh(curvedPageGeometry(-1), this.#pageMaterial());
    this.leftMesh.position.set(-PAGE_W / 2 - 0.02, 0, 0.012);
    this.rightMesh = new THREE.Mesh(curvedPageGeometry(1), this.#pageMaterial());
    this.rightMesh.position.set(PAGE_W / 2 + 0.02, 0, 0.012);
    this.group.add(this.leftMesh, this.rightMesh);

    this.hoverQuad = this.#highlightQuad(0.16);
    this.selectQuad = this.#highlightQuad(0.34);
    this.flashMaterial = new THREE.MeshBasicNodeMaterial({
      color: 0xd4af5a, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
  }

  /**
   * One persistent turning page. Its surface morphs in the vertex stage:
   * at progress 0 it matches the right page's curve, at 1 the (mirrored)
   * landing curve, bowing extra in between — paper bending as it turns.
   *
   * Two coplanar single-sided meshes carry the two faces via plain `.map`
   * (the same swap mechanism the page meshes use). The back page is drawn
   * mirrored into a dedicated canvas, so viewed from behind it reads
   * correctly. No per-flip shader work at all.
   */
  #buildFlipRig() {
    this.flipProg = uniform(0);
    const u = positionLocal.x.div(PAGE_W).clamp(0, 1);
    const prof = float(-0.30).mul(u.mul(-9).exp())
      .add(float(0.105).mul(u.pow(0.85).mul(Math.PI).sin()).mul(float(1).sub(u.mul(0.25))))
      .sub(u.pow(3).mul(0.035));
    const p = this.flipProg;
    const bend = u.mul(Math.PI).sin().mul(p.mul(Math.PI).sin()).mul(0.34);
    const morphed = vec3(positionLocal.x, positionLocal.y, mix(prof, prof.negate(), p).add(bend));

    this.flipBackCanvas = document.createElement('canvas');
    this.flipBackCanvas.width = PAGE.W;
    this.flipBackCanvas.height = PAGE.H;
    this.flipBackTex = new THREE.CanvasTexture(this.flipBackCanvas);
    this.flipBackTex.colorSpace = THREE.SRGBColorSpace;
    this.flipBackTex.anisotropy = 8;

    this.flipFrontMat = new THREE.MeshBasicNodeMaterial({ map: this.blankTex, side: THREE.FrontSide });
    this.flipFrontMat.positionNode = morphed;
    const backMat = new THREE.MeshBasicNodeMaterial({ map: this.flipBackTex, side: THREE.BackSide });
    backMat.positionNode = morphed;

    const geo = hingedPlaneGeometry(0);
    this.flipPivot = new THREE.Group();
    this.flipPivot.position.z = 0.03;
    this.flipPivot.visible = false;
    this.flipPivot.add(new THREE.Mesh(geo, this.flipFrontMat), new THREE.Mesh(geo, backMat));
    this.group.add(this.flipPivot);
  }

  #pageMaterial() {
    return new THREE.MeshBasicNodeMaterial({ map: this.blankTex });
  }

  #highlightQuad(opacity) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicNodeMaterial({
        color: 0xd4af5a, transparent: true, opacity,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    m.visible = false;
    m.renderOrder = 2;
    return m;
  }

  #makeTexture(canvas) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    // Pre-upload so flips never hitch on first use; the backend may not be
    // ready during construction, in which case first render uploads instead.
    try { this.s3d.renderer.initTexture?.(tex); } catch { /* not initialized yet */ }
    return tex;
  }

  /* ---------- data: layout, textures, absolute page offsets ---------- */

  async init() {
    const books = await loadBooks();
    this.order = books.map((b) => b.osis);
    this.#computeOffsets(); // background; folios appear when ready
  }

  async ensureLayout(osis) {
    if (!this.layoutCache.has(osis)) {
      const text = await loadBookText(osis);
      const pages = layoutBook(text);
      this.layoutCache.set(osis, pages);
      for (const k of this.layoutCache.keys()) {
        if (this.layoutCache.size <= LAYOUT_CACHE_MAX) break;
        if (k !== this.osis && k !== osis) this.layoutCache.delete(k);
      }
      this.#verifyCount(osis, pages.length);
    }
    return this.layoutCache.get(osis);
  }

  /** Count pages of every book once (cached) -> absolute folio offsets. */
  async #computeOffsets() {
    let counts = null;
    try { counts = JSON.parse(localStorage.getItem(PAGECOUNT_STORE) || 'null'); } catch { /* ignore */ }
    if (!Array.isArray(counts) || counts.length !== this.order.length) {
      counts = [];
      for (const osis of this.order) {
        const text = await loadBookText(osis);
        counts.push(countBookPages(text));
        await new Promise((r) => setTimeout(r)); // stay off the render loop
      }
      try { localStorage.setItem(PAGECOUNT_STORE, JSON.stringify(counts)); } catch { /* ignore */ }
    }
    this.pageCounts = counts;
    this.#rebuildOffsets();
  }

  #rebuildOffsets() {
    this.pageOffsets = new Map();
    let acc = 0;
    this.order.forEach((osis, i) => {
      this.pageOffsets.set(osis, acc);
      acc += this.pageCounts[i];
    });
    this.totalPages = acc;
    // Redraw with folios (or corrected folios).
    for (const t of this.texCache.values()) { if (!this.lockedTex.has(t)) t.dispose(); }
    this.texCache.clear();
    if (this.osis) this.setSpread(this.spread);
  }

  /** Cached counts can go stale if typesetting changes; self-heal. */
  #verifyCount(osis, actual) {
    if (!this.pageCounts) return;
    const i = this.order.indexOf(osis);
    if (this.pageCounts[i] === actual) return;
    this.pageCounts[i] = actual;
    try { localStorage.setItem(PAGECOUNT_STORE, JSON.stringify(this.pageCounts)); } catch { /* ignore */ }
    this.#rebuildOffsets();
  }

  folioOf(osis, idx) {
    const off = this.pageOffsets?.get(osis);
    return off == null ? null : off + idx + 1;
  }

  neighborBook(osis, dir) {
    const i = this.order.indexOf(osis);
    return this.order[i + dir] ?? null;
  }

  pageTexture(osis, idx) {
    const pages = this.layoutCache.get(osis);
    if (!pages || idx < 0 || idx >= pages.length) return this.blankTex;
    const key = `${osis}:${idx}`;
    if (this.texCache.has(key)) {
      const tex = this.texCache.get(key);
      this.texCache.delete(key); // refresh LRU position
      this.texCache.set(key, tex);
      return tex;
    }
    const canvas = drawPage(pages[idx], {
      bookName: bookInfo(osis)?.name ?? osis,
      side: idx % 2 === 0 ? 'left' : 'right',
      hasNext: idx + 1 < pages.length || !!this.neighborBook(osis, 1),
      hasPrev: idx > 0 || !!this.neighborBook(osis, -1),
      folio: this.folioOf(osis, idx),
    });
    const tex = this.#makeTexture(canvas);
    this.texCache.set(key, tex);
    const onDisplay = new Set([
      `${this.osis}:${2 * this.spread}`, `${this.osis}:${2 * this.spread + 1}`, key,
    ]);
    for (const k of this.texCache.keys()) {
      if (this.texCache.size <= TEX_CACHE_MAX) break;
      if (onDisplay.has(k) || this.lockedTex.has(this.texCache.get(k))) continue;
      this.texCache.get(k).dispose();
      this.texCache.delete(k);
    }
    return tex;
  }

  totalSpreads(osis = this.osis) {
    const pages = this.layoutCache.get(osis) ?? [];
    return Math.max(1, Math.ceil(pages.length / 2));
  }

  currentChapter() {
    const page = this.pages[2 * this.spread] ?? this.pages[2 * this.spread + 1];
    return page?.firstChapter ?? 1;
  }

  /* ---------- navigation ---------- */

  spreadOf(osis, chapter, verse = null) {
    const pages = this.layoutCache.get(osis) ?? [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const hit = verse == null
        ? p.items.some((it) => it.type === 'heading' && it.chapter === chapter) ||
          p.tokens.some((t) => t.chapter === chapter)
        : p.tokens.some((t) => t.chapter === chapter && t.verse === verse);
      if (hit) return Math.floor(i / 2);
    }
    return 0;
  }

  async go(osis, chapter = 1, { verse = null, spread = null, animate = false, flash = false } = {}) {
    const token = ++this.navToken;
    this.clearSelection();
    this.#clearFlash();
    this.#cancelFlip();
    await this.ensureLayout(osis);
    if (token !== this.navToken) return;

    const target = spread != null
      ? Math.min(spread, this.totalSpreads(osis) - 1)
      : this.spreadOf(osis, chapter, verse);

    if (!this.osis || !animate) {
      this.#switchBook(osis);
      this.setSpread(target);
    } else {
      await this.#flipToward(osis, target, token);
      if (token !== this.navToken) return;
    }
    if (flash && verse != null) this.#flashVerse(chapter, verse);
  }

  #switchBook(osis) {
    if (this.osis === osis) return;
    this.osis = osis;
    this.pages = this.layoutCache.get(osis) ?? [];
  }

  setSpread(s) {
    this.spread = s;
    this.leftMesh.material.map = this.pageTexture(this.osis, 2 * s);
    this.rightMesh.material.map = this.pageTexture(this.osis, 2 * s + 1);
    this.onPageChange?.();
  }

  /** A few quick page turns toward the target, then land on it. */
  async #flipToward(osis, target, token) {
    let dir;
    if (osis === this.osis) {
      if (target === this.spread) return;
      dir = Math.sign(target - this.spread);
    } else {
      dir = Math.sign(this.order.indexOf(osis) - this.order.indexOf(this.osis)) || 1;
    }

    const hops = [];
    if (osis === this.osis && Math.abs(target - this.spread) <= 4) {
      for (let s = this.spread + dir; s !== target + dir; s += dir) hops.push(s);
    } else {
      const span = this.totalSpreads(osis);
      for (const d of [3, 2, 1, 0]) {
        const s = Math.min(Math.max(target - d * dir, 0), span - 1);
        if (!hops.includes(s)) hops.push(s);
      }
    }

    for (let i = 0; i < hops.length; i++) {
      if (token !== this.navToken) return;
      const last = i === hops.length - 1;
      await this.#animateFlip(dir, osis, hops[i], last ? FLIP_TIME * 0.8 : RIFFLE_TIME);
    }
  }

  async flipPage(dir) {
    if (this.flip || !this.osis) return false;
    const nextSpread = this.spread + dir;
    if ((dir > 0 && 2 * this.spread + 2 < this.pages.length) || (dir < 0 && this.spread > 0)) {
      await this.#animateFlip(dir, this.osis, nextSpread, FLIP_TIME);
      return true;
    }
    const nb = this.neighborBook(this.osis, dir);
    if (!nb) return false;
    await this.ensureLayout(nb);
    if (this.flip) return false;
    const s = dir > 0 ? 0 : this.totalSpreads(nb) - 1;
    await this.#animateFlip(dir, nb, s, FLIP_TIME);
    return true;
  }

  canFlip(dir) {
    if (this.flip) return false;
    if (dir > 0) {
      return 2 * this.spread + 2 < this.pages.length || !!this.neighborBook(this.osis, 1);
    }
    return this.spread > 0 || !!this.neighborBook(this.osis, -1);
  }

  /* ---------- the page turn ---------- */

  #animateFlip(dir, osisIn, spreadIn, duration) {
    return new Promise((resolve) => {
      if (this.flip) { resolve(); return; }
      this.clearSelection();
      this.#clearFlash();

      let frontTex, backTex;
      if (dir > 0) {
        frontTex = this.rightMesh.material.map;                  // lifting away
        backTex = this.pageTexture(osisIn, 2 * spreadIn);        // lands as new left
        this.rightMesh.material.map = this.pageTexture(osisIn, 2 * spreadIn + 1);
      } else {
        backTex = this.leftMesh.material.map;                    // lifting away
        frontTex = this.pageTexture(osisIn, 2 * spreadIn + 1);   // lands as new right
        this.leftMesh.material.map = this.pageTexture(osisIn, 2 * spreadIn);
      }
      this.lockedTex.add(frontTex);
      this.flipFrontMat.map = frontTex;
      // Draw the incoming page mirrored; the BackSide mesh un-mirrors it.
      const ctx = this.flipBackCanvas.getContext('2d');
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(backTex.image, -PAGE.W, 0);
      ctx.restore();
      this.flipBackTex.needsUpdate = true;

      const from = dir > 0 ? 0 : -Math.PI;
      const to = dir > 0 ? -Math.PI : 0;
      this.flipPivot.rotation.y = from;
      this.flipProg.value = -from / Math.PI;
      this.flipPivot.visible = true;

      this.flip = {
        from, to, t: 0, duration,
        finish: (complete) => {
          this.flipPivot.visible = false;
          this.lockedTex.clear();
          this.flip = null;
          if (complete) {
            this.#switchBook(osisIn);
            this.setSpread(spreadIn);
          }
          resolve();
        },
      };
    });
  }

  #cancelFlip() {
    this.flip?.finish(false);
  }



  /* ---------- picking ---------- */

  pick(clientX, clientY) {
    const hit = this.s3d.raycast(clientX, clientY, [this.leftMesh, this.rightMesh])[0];
    if (!hit) return null;
    const mesh = hit.object;
    const pageIdx = mesh === this.leftMesh ? 2 * this.spread : 2 * this.spread + 1;
    const page = this.pages[pageIdx];
    const cx = hit.uv.x * PAGE.W;
    const cy = (1 - hit.uv.y) * PAGE.H;

    const cz = PAGE.cornerZone;
    if (cy > PAGE.H - cz) {
      if (mesh === this.rightMesh && cx > PAGE.W - cz && this.canFlip(1)) return { type: 'flip', dir: 1 };
      if (mesh === this.leftMesh && cx < cz && this.canFlip(-1)) return { type: 'flip', dir: -1 };
    }

    if (!page) return { type: 'page' };
    const token = page.tokens.find(
      (t) => t.type === 'word' && cx >= t.rx && cx <= t.rx + t.rw && cy >= t.ry && cy <= t.ry + t.rh,
    );
    if (token) return { type: 'word', token, page, pageIdx, mesh };
    return { type: 'page' };
  }

  hover(clientX, clientY) {
    if (this.flip) return false;
    const p = this.pick(clientX, clientY);
    if (p?.type === 'word') {
      this.#placeQuad(this.hoverQuad, p.mesh, p.token);
      this.hoverQuad.visible = true;
      return true;
    }
    this.hoverQuad.visible = false;
    return p?.type === 'flip';
  }

  handleClick(clientX, clientY) {
    if (this.flip) return null;
    const p = this.pick(clientX, clientY);
    if (p?.type === 'flip') {
      this.flipPage(p.dir);
      return { type: 'flip' };
    }
    if (p?.type === 'word') {
      this.#select(p);
      return { type: 'word' };
    }
    return p;
  }

  #select({ token, mesh }) {
    this.#clearFlash();
    this.#placeQuad(this.selectQuad, mesh, token);
    this.selectQuad.visible = true;
    this.hoverQuad.visible = false;
    this.selection = { chapter: token.chapter, verse: token.verse, word: token.word };
    this.onSelect?.({
      osis: this.osis,
      chapter: token.chapter,
      verse: token.verse,
      word: token.str,
    });
  }

  selectVerseWord(chapter, verse, wordIdx = 0) {
    const pages = this.pages;
    let pageIdx = -1;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].tokens.some((t) => t.chapter === chapter && t.verse === verse)) { pageIdx = i; break; }
    }
    if (pageIdx < 0) return false;
    const targetSpread = Math.floor(pageIdx / 2);
    if (targetSpread !== this.spread) this.setSpread(targetSpread);
    const page = pages[pageIdx];
    const token =
      page.tokens.find((t) => t.type === 'word' && t.chapter === chapter && t.verse === verse && t.word === wordIdx) ??
      page.tokens.find((t) => t.type === 'word' && t.chapter === chapter && t.verse === verse);
    if (!token) return false;
    const mesh = pageIdx % 2 === 0 ? this.leftMesh : this.rightMesh;
    this.#select({ token, mesh });
    return true;
  }

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.selectQuad.visible = false;
    this.selectQuad.removeFromParent();
    this.onClear?.();
  }

  anchorWorld() {
    if (!this.selection || !this.selectQuad.visible) return null;
    return this.selectQuad.getWorldPosition(new THREE.Vector3());
  }

  current() {
    return {
      osis: this.osis,
      chapter: this.currentChapter(),
      spread: this.spread,
      sel: this.selection ? { ...this.selection } : null,
    };
  }

  /** Place a highlight flush on the curved page surface (matched tilt). */
  #placeQuad(quad, mesh, token) {
    quad.removeFromParent();
    mesh.add(quad);
    const cxn = (token.rx + token.rw / 2) / PAGE.W; // 0..1 across the canvas
    const isLeft = mesh === this.leftMesh;
    const u = isLeft ? 1 - cxn : cxn;
    const m = (profileSlope(u) * (isLeft ? -1 : 1)) / PAGE_W; // dz per local-x
    quad.position.set(
      (cxn - 0.5) * PAGE_W,
      (0.5 - (token.ry + token.rh / 2) / PAGE.H) * PAGE_H,
      pageProfile(u) + 0.015,
    );
    quad.rotation.y = -Math.atan(m);
    quad.scale.set((token.rw / PAGE.W) * PAGE_W, (token.rh / PAGE.H) * PAGE_H, 1);
  }

  /* ---------- verse flash ---------- */

  #flashVerse(chapter, verse) {
    this.#clearFlash();
    for (const pageIdx of [2 * this.spread, 2 * this.spread + 1]) {
      const page = this.pages[pageIdx];
      if (!page) continue;
      const mesh = pageIdx % 2 === 0 ? this.leftMesh : this.rightMesh;
      const isLeft = pageIdx % 2 === 0;
      const lines = new Map();
      for (const t of page.tokens) {
        if (t.chapter !== chapter || t.verse !== verse) continue;
        const line = lines.get(t.y) ?? { x0: t.rx, x1: t.rx + t.rw, y: t.ry, h: t.rh };
        line.x0 = Math.min(line.x0, t.rx);
        line.x1 = Math.max(line.x1, t.rx + t.rw);
        lines.set(t.y, line);
      }
      for (const l of lines.values()) {
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.flashMaterial);
        const cxn = (l.x0 + l.x1) / 2 / PAGE.W;
        const u = isLeft ? 1 - cxn : cxn;
        const m = (profileSlope(u) * (isLeft ? -1 : 1)) / PAGE_W;
        quad.position.set(
          (cxn - 0.5) * PAGE_W,
          (0.5 - (l.y + l.h / 2) / PAGE.H) * PAGE_H,
          pageProfile(u) + 0.015,
        );
        quad.rotation.y = -Math.atan(m);
        quad.scale.set(((l.x1 - l.x0) / PAGE.W) * PAGE_W, (l.h / PAGE.H) * PAGE_H, 1);
        quad.renderOrder = 2;
        mesh.add(quad);
        this.flashQuads.push(quad);
      }
    }
    this.flashLife = 2.4;
  }

  #clearFlash() {
    for (const q of this.flashQuads) { q.removeFromParent(); q.geometry.dispose(); }
    this.flashQuads = [];
    this.flashLife = 0;
  }

  /* ---------- per-frame ---------- */

  #tick(dt) {
    const t = performance.now() / 1000;
    this.group.position.y = 0.15 + Math.sin(t * 0.6) * 0.05;
    this.group.rotation.y = Math.sin(t * 0.23) * 0.012;

    // Warm GPU pipelines for the flip rig at boot (degenerate scale, 3 frames)
    // so the first real page turn doesn't hitch on shader compilation.
    if (this.warmupFrames > 0 && !this.flip) {
      this.flipPivot.visible = true;
      this.flipPivot.scale.setScalar(0.0001);
      if (--this.warmupFrames === 0) {
        this.flipPivot.visible = false;
        this.flipPivot.scale.setScalar(1);
      }
    }

    if (this.flip) {
      const f = this.flip;
      f.t = Math.min(f.t + dt / f.duration, 1);
      const e = f.t < 0.5 ? 2 * f.t * f.t : 1 - (-2 * f.t + 2) ** 2 / 2;
      const rot = f.from + (f.to - f.from) * e;
      this.flipPivot.rotation.y = rot;
      this.flipProg.value = -rot / Math.PI;
      if (f.t >= 1) f.finish(true);
    }

    if (this.flashLife > 0) {
      this.flashLife -= dt;
      this.flashMaterial.opacity = Math.max(this.flashLife / 2.4, 0) * 0.3;
      if (this.flashLife <= 0) this.#clearFlash();
    }
  }
}
