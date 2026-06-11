/**
 * WebGPU scene: deep gradient background, drifting dust motes (TSL flicker),
 * camera with gentle mouse parallax, raycasting helpers, render loop.
 */
import * as THREE from 'three/webgpu';
import {
  color, float, vec3, mix, smoothstep, time, hash, instanceIndex, uv,
  screenUV, length as tslLength, vec2,
} from 'three/tsl';

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.scene = new THREE.Scene();

    // Vignetted nave-at-night gradient, computed in screen space.
    const d = tslLength(screenUV.sub(vec2(0.5, 0.42)));
    this.scene.backgroundNode = mix(
      vec3(0.075, 0.06, 0.12),   // warm indigo heart
      vec3(0.022, 0.016, 0.045), // near-black edges
      smoothstep(0.0, 0.85, d),
    );

    this.camera = new THREE.PerspectiveCamera(
      50, window.innerWidth / window.innerHeight, 0.1, 100,
    );
    this.camera.position.set(0, 0, 14);

    this.pointerNDC = new THREE.Vector2(0, 0);
    this.parallax = new THREE.Vector2(0, 0);
    this.raycaster = new THREE.Raycaster();
    this.tickFns = [];

    this.dust = this.#buildDust();
    this.scene.add(this.dust);

    window.addEventListener('resize', () => this.#resize());
    window.addEventListener('pointermove', (e) => {
      this.pointerNDC.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1,
      );
    });
  }

  async init() {
    await this.renderer.init();
    const timer = new THREE.Timer();
    this.renderer.setAnimationLoop(() => {
      timer.update();
      const dt = Math.min(timer.getDelta(), 0.05);

      // Soft parallax: camera leans toward the pointer.
      this.parallax.lerp(this.pointerNDC, 1 - Math.exp(-dt * 2.5));
      this.camera.position.x = this.parallax.x * 0.55;
      this.camera.position.y = this.parallax.y * 0.35;
      this.camera.lookAt(0, 0, 0);

      this.dust.rotation.y += dt * 0.008;

      for (const fn of this.tickFns) fn(dt);
      this.renderer.render(this.scene, this.camera);
    });
  }

  onTick(fn) { this.tickFns.push(fn); }

  /** Screen pixel coords -> world point on the plane at the given z. */
  screenToWorld(px, py, z = 0) {
    const ndc = new THREE.Vector3(
      (px / window.innerWidth) * 2 - 1,
      -(py / window.innerHeight) * 2 + 1,
      0.5,
    ).unproject(this.camera);
    const dir = ndc.sub(this.camera.position).normalize();
    const t = (z - this.camera.position.z) / dir.z;
    return this.camera.position.clone().add(dir.multiplyScalar(t));
  }

  /** NDC coords (-1..1) -> world point at z. */
  ndcToWorld(nx, ny, z = 0) {
    return this.screenToWorld(
      ((nx + 1) / 2) * window.innerWidth,
      ((1 - ny) / 2) * window.innerHeight,
      z,
    );
  }

  raycast(clientX, clientY, objects) {
    const ndc = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObjects(objects, false);
  }

  #buildDust() {
    const COUNT = 1400;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    // Soft round mote, each with its own flicker phase and warmth.
    const seed = hash(instanceIndex);
    const seed2 = hash(instanceIndex.add(7919));
    const radial = smoothstep(0.5, 0.08, tslLength(uv().sub(0.5)));
    const flicker = time.mul(seed.mul(1.4).add(0.25)).add(seed.mul(40.0)).sin()
      .mul(0.5).add(0.5);
    const warmth = mix(color(0xd4af5a), color(0x8d9bd6), seed2);
    mat.colorNode = warmth;
    mat.opacityNode = radial.mul(flicker.mul(0.5).add(0.08)).mul(float(0.5));

    const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < COUNT; i++) {
      p.set(
        (Math.random() - 0.5) * 36,
        (Math.random() - 0.5) * 20,
        -10 + Math.random() * 13,
      );
      const sc = 0.02 + Math.random() ** 2 * 0.09;
      s.set(sc, sc, sc);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.renderOrder = -1;
    return mesh;
  }

  #resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
