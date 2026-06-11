/**
 * Floating reference cards: parchment-styled canvas textures on planes,
 * flying out from the clicked word to slots flanking the book. Hovering a
 * card draws it toward the camera for reading.
 */
import * as THREE from 'three/webgpu';
import { BOOK_HALF_W } from './book.js';

const CARD_W = 3.5;
const CARD_H = 2.1;
const TEX_W = 1024;
const TEX_H = 614;

export class CardField {
  constructor(scene3d) {
    this.s3d = scene3d;
    this.group = new THREE.Group();
    scene3d.scene.add(this.group);
    this.cards = [];
    this.hovered = null;
    scene3d.onTick((dt) => this.#tick(dt));
  }

  /** refs: [{ ref, label, text, votes }], start: THREE.Vector3 (world). */
  show(refs, start) {
    this.clear();
    const n = refs.length;
    const cam = this.s3d.camera;
    const halfTan = Math.tan((cam.fov * Math.PI) / 360);

    refs.forEach((r, i) => {
      const side = i % 2 === 0 ? 1 : -1;
      const row = Math.floor(i / 2);
      const rows = Math.ceil(n / 2);
      const z = 0.9 + (i % 3) * 0.7;

      // Keep cards inside the frustum on narrower windows.
      const maxX = halfTan * (cam.position.z - z) * cam.aspect - CARD_W / 2 - 0.25;
      const x = side * Math.min(BOOK_HALF_W + 2.1 + (i % 3) * 0.45, maxX);
      const y = rows > 1 ? 2.5 - (row / (rows - 1)) * 5.0 : 0;

      const mesh = makeCardMesh(r);
      mesh.position.copy(start);
      mesh.scale.setScalar(0.01);
      mesh.userData = {
        ref: r.ref,
        verse: r,
        slot: new THREE.Vector3(x, y, z),
        start: start.clone(),
        t: 0,
        delay: i * 0.07,
        wobble: Math.random() * Math.PI * 2,
      };
      this.group.add(mesh);
      this.cards.push(mesh);
    });
  }

  clear() {
    for (const c of this.cards) {
      c.material.map?.dispose();
      c.material.dispose();
      c.geometry.dispose();
      this.group.remove(c);
    }
    this.cards = [];
    this.hovered = null;
  }

  /** Update hover state; returns true when a card is under the pointer. */
  hoverAt(clientX, clientY) {
    if (!this.cards.length) { this.hovered = null; return false; }
    const hit = this.s3d.raycast(clientX, clientY, this.cards)[0];
    this.hovered = hit?.object ?? null;
    return !!this.hovered;
  }

  /** Returns the clicked card's verse data, or null. */
  pick(clientX, clientY) {
    if (!this.cards.length) return null;
    const hit = this.s3d.raycast(clientX, clientY, this.cards)[0];
    return hit ? hit.object.userData.verse : null;
  }

  #tick(dt) {
    const tNow = performance.now() / 1000;
    const toCamera = new THREE.Vector3();
    for (const c of this.cards) {
      const u = c.userData;
      if (u.delay > 0) { u.delay -= dt; continue; }

      if (u.t < 1) {
        u.t = Math.min(u.t + dt * 1.7, 1);
        const e = easeOutCubic(u.t);
        c.position.lerpVectors(u.start, u.slot, e);
        c.position.z += Math.sin(e * Math.PI) * 1.1;
        c.scale.setScalar(Math.max(e, 0.01));
      } else {
        // Idle bob; hovered cards lean toward the camera for reading.
        const target = u.slot.clone();
        target.y += Math.sin(tNow * 0.8 + u.wobble) * 0.05;
        if (c === this.hovered) {
          toCamera.copy(this.s3d.camera.position).sub(u.slot).normalize();
          target.addScaledVector(toCamera, 1.6);
        }
        c.position.lerp(target, 1 - Math.exp(-dt * 9));
        const s = c === this.hovered ? 1.12 : 1;
        c.scale.lerp(new THREE.Vector3(s, s, s), 1 - Math.exp(-dt * 9));
      }
      c.lookAt(this.s3d.camera.position);
    }
  }
}

function makeCardMesh(r) {
  const tex = new THREE.CanvasTexture(drawCard(r));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshBasicNodeMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), mat);
}

function drawCard({ label, text, votes }) {
  const cv = document.createElement('canvas');
  cv.width = TEX_W;
  cv.height = TEX_H;
  const ctx = cv.getContext('2d');

  const r = 26;
  ctx.beginPath();
  ctx.roundRect(6, 6, TEX_W - 12, TEX_H - 12, r);
  const bg = ctx.createLinearGradient(0, 0, 0, TEX_H);
  bg.addColorStop(0, '#f6efdf');
  bg.addColorStop(1, '#eadfc4');
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = 'rgba(140, 110, 50, 0.6)';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(18, 18, TEX_W - 36, TEX_H - 36, r - 10);
  ctx.strokeStyle = 'rgba(140, 110, 50, 0.25)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#7c5a1e';
  ctx.font = '600 58px "Cormorant SC", "EB Garamond", Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, TEX_W / 2, 96);

  const w = 90 + Math.min(votes / 3, 260);
  ctx.strokeStyle = 'rgba(138, 100, 32, 0.6)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(TEX_W / 2 - w, 126);
  ctx.lineTo(TEX_W / 2 + w, 126);
  ctx.stroke();

  ctx.fillStyle = '#241a0e';
  ctx.font = 'italic 46px "EB Garamond", Georgia, serif';
  wrapText(ctx, text, TEX_W / 2, 196, TEX_W - 140, 60, 6);

  return cv;
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = text.split(' ');
  let line = '';
  let lines = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(test).width > maxWidth && line) {
      if (lines === maxLines - 1) {
        ctx.fillText(`${line}…`, x, y);
        return;
      }
      ctx.fillText(line, x, y);
      line = words[i];
      lines++;
      y += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y);
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}
