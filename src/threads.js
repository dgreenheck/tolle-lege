/**
 * Glowing threads: animated bezier lines binding the clicked word to each
 * reference card. Endpoints follow the live word position (panel scroll,
 * camera parallax) and the card's animated position every frame.
 */
import * as THREE from 'three/webgpu';
import { color, float, attribute, time, fract, smoothstep } from 'three/tsl';

const SEGMENTS = 64;

export class ThreadField {
  /** getAnchorWorld: () => THREE.Vector3 | null — live world-space thread origin. */
  constructor(scene3d, cardField, getAnchorWorld) {
    this.s3d = scene3d;
    this.cardField = cardField;
    this.getAnchorWorld = getAnchorWorld;
    this.group = new THREE.Group();
    scene3d.scene.add(this.group);
    this.threads = [];

    // One shared material: a faint golden filament with a bright pulse
    // travelling from the word toward the card.
    const progress = attribute('progress');
    const pulse = smoothstep(0.12, 0.0, fract(progress.negate().add(time.mul(0.35))).abs())
      .add(smoothstep(0.985, 1.0, progress).mul(0.8)); // glow at the card end
    this.material = new THREE.LineBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.material.colorNode = color(0xd4af5a).mul(float(0.55).add(pulse.mul(1.6)));
    this.material.opacityNode = float(0.38).add(pulse.mul(0.62));

    scene3d.onTick(() => this.#tick());
  }

  /** Create one thread per current card. */
  show() {
    this.clear();
    for (const card of this.cardField.cards) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SEGMENTS * 3), 3));
      const prog = new Float32Array(SEGMENTS);
      for (let i = 0; i < SEGMENTS; i++) prog[i] = i / (SEGMENTS - 1);
      geo.setAttribute('progress', new THREE.BufferAttribute(prog, 1));
      const line = new THREE.Line(geo, this.material);
      line.frustumCulled = false;
      line.userData.card = card;
      this.group.add(line);
      this.threads.push(line);
    }
  }

  clear() {
    for (const t of this.threads) {
      t.geometry.dispose();
      this.group.remove(t);
    }
    this.threads = [];
  }

  #tick() {
    if (!this.threads.length) return;
    const a = this.getAnchorWorld();
    if (!a) return;
    const v = new THREE.Vector3();

    for (const thread of this.threads) {
      const card = thread.userData.card;
      const b = card.position;
      // Control point: midpoint pushed outward and toward the camera,
      // so the thread bows gracefully around the panel edge.
      const cp = a.clone().add(b).multiplyScalar(0.5);
      cp.x += Math.sign(b.x - a.x) * 1.4;
      cp.z += 2.2;

      const pos = thread.geometry.getAttribute('position');
      for (let i = 0; i < SEGMENTS; i++) {
        const t = i / (SEGMENTS - 1);
        quadBezier(v, a, cp, b, t);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      pos.needsUpdate = true;

      // Threads fade in with their card's arrival.
      thread.visible = card.userData.delay <= 0;
    }
  }
}

function quadBezier(out, a, cp, b, t) {
  const u = 1 - t;
  out.set(
    u * u * a.x + 2 * u * t * cp.x + t * t * b.x,
    u * u * a.y + 2 * u * t * cp.y + t * t * b.y,
    u * u * a.z + 2 * u * t * cp.z + t * t * b.z,
  );
}
