/**
 * WebGPU scene: neutral vignetted background, a fixed camera fitted so the
 * book fills the stage, raycasting helpers, render loop. The canvas sizes
 * itself to its container (the left-hand stage), not the window.
 */
import * as THREE from 'three/webgpu';
import { vec3, mix, smoothstep, screenUV, length as tslLength, vec2 } from 'three/tsl';

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();

    // Quiet warm-gray vignette; the book carries the color.
    const d = tslLength(screenUV.sub(vec2(0.5, 0.45)));
    this.scene.backgroundNode = mix(
      vec3(0.034, 0.031, 0.027),
      vec3(0.016, 0.015, 0.013),
      smoothstep(0.0, 0.9, d),
    );

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(0, 0, 14);

    // World-space rect the camera must keep in view (set before init).
    this.fit = null;

    this.raycaster = new THREE.Raycaster();
    this.tickFns = [];

    new ResizeObserver(() => this.#resize()).observe(canvas);
    this.#resize();
  }

  async init() {
    await this.renderer.init();
    const timer = new THREE.Timer();
    this.renderer.setAnimationLoop(() => {
      timer.update();
      const dt = Math.min(timer.getDelta(), 0.05);
      for (const fn of this.tickFns) fn(dt);
      this.renderer.render(this.scene, this.camera);
    });
  }

  onTick(fn) { this.tickFns.push(fn); }

  /** Canvas-relative NDC for client (page) coordinates. */
  #ndc(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
  }

  raycast(clientX, clientY, objects) {
    this.raycaster.setFromCamera(this.#ndc(clientX, clientY), this.camera);
    return this.raycaster.intersectObjects(objects, false);
  }

  #resize() {
    // The canvas is inset from the stage (the side column floats to its
    // right), so measure the canvas itself, not its container.
    const w = Math.max(this.canvas.clientWidth, 1);
    const h = Math.max(this.canvas.clientHeight, 1);
    this.camera.aspect = w / h;
    if (this.fit) {
      const halfTan = Math.tan((this.camera.fov * Math.PI) / 360);
      const need = Math.max(this.fit.h / 2, this.fit.w / 2 / this.camera.aspect);
      this.camera.position.z = (need / halfTan) * 1.09;
    }
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  /** Re-run the camera fit (e.g. after setting `fit`). */
  refit() { this.#resize(); }
}
