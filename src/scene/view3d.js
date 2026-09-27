/**
 * view3d.js — Three.js viewport: scene assembly, stock mesh, target ghost,
 * toolpath lines and the A-rotor.
 *
 * The workpiece, its target "ghost" and the toolpath traces all live in one
 * rotor group rotated by −A about world X — the tool/carriage stay fixed in
 * world space (only translating in X/Z), exactly like a real 4-axis machine
 * where the cutter never orbits the part.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MachineModel } from './machine.js';
import { tipToRotor, RAD_PER_DEG } from '../core/unroll.js';

const WOOD = 0xb07a44;

function makeRotorPoint(out, x, z, aDeg) {
  return tipToRotor(x, z, aDeg, out);
}

export class View3D {
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1117);

    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 6000);
    this.camera.up.set(0, 0, 1); // Z up

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // ---- lights --------------------------------------------------------
    this.scene.add(new THREE.HemisphereLight(0x93a7c4, 0x1c222c, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(-160, -220, 300);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x7d90ad, 0.55);
    fill.position.set(240, 180, 120);
    this.scene.add(fill);

    // ---- floor grid (XY plane at z = −178) + axis triad -----------------
    const grid = new THREE.GridHelper(900, 90, 0x2c3a4e, 0x171e29);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -178;
    this.scene.add(grid);

    const origin = new THREE.Vector3(-210, -110, -178);
    const arrow = (dir, color, len = 70) =>
      this.scene.add(new THREE.ArrowHelper(new THREE.Vector3(...dir), origin, len, color, 12, 6));
    arrow([1, 0, 0], 0xff5555); // X — rotary axis
    arrow([0, 1, 0], 0x55dd77); // Y
    arrow([0, 0, 1], 0x4d8dff); // Z — tool axis / depth

    // ---- rotor (stock + ghost + path traces) -----------------------------
    this.rotor = new THREE.Group();
    this.scene.add(this.rotor);

    this.machine = new MachineModel(this.scene);

    // stock mesh state
    this.stock = null;
    this.stockMesh = null;
    this._pos = null;
    this._nrm = null;

    // ghost + path groups
    this.ghostMesh = null;
    this.pathMeshes = {
      rapid: this._mkLinePair(0xb4652f, 0xe08a3c, 0.5),
      rough: this._mkLinePair(0x1f6f68, 0x2dd4bf, 0.5),
      finish: this._mkLinePair(0x218a4e, 0x4ade80, 0.5),
    };
    // Rapid moves are dense (every G0 approach/retract); start hidden and
    // let the "rapid moves" checkbox reveal them.
    this.pathMeshes.rapid.all.visible = false;
    this.pathMeshes.rapid.done.visible = false;
    this._groupOfSeg = null;
    this._lastDone = [-1, -1, -1];

    // ---- resize handling ---------------------------------------------------
    this._ro = new ResizeObserver(() => this.resizeNow());
    this._ro.observe(container);
    this.resizeNow();
    this.resetView(200);

    // double-click re-frames the scene
    this.renderer.domElement.addEventListener('dblclick', () => this.resetView(this._frameL || 200));
  }

  _mkLinePair(allColor, doneColor, allOpacity) {
    const mk = (color, opacity) => new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
    );
    const all = mk(allColor, allOpacity);
    const done = mk(doneColor, 0.95);
    all.frustumCulled = false;
    done.frustumCulled = false;
    this.rotor.add(all, done);
    return { all, done };
  }

  resetView(L = 200) {
    this._frameL = L;
    this.camera.position.set(L * 1.05, -L * 1.25, L * 0.95);
    this.controls.target.set(L / 2, 0, 0);
    this.controls.update();
  }

  resizeNow() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------------
  // Stock mesh
  // -------------------------------------------------------------------------
  setStock(stock) {
    if (this.stockMesh) {
      this.rotor.remove(this.stockMesh);
      this.stockMesh.geometry.dispose();
      this.stockMesh.material.dispose();
      this.stockMesh = null;
    }
    this.stock = stock;
    this._meshVer = -1; // force rebuild for this stock instance
    const nv = stock.meshVertexCount();
    this._pos = new Float32Array(nv * 3);
    this._nrm = new Float32Array(nv * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this._nrm, 3));
    geo.setIndex(new THREE.BufferAttribute(stock.buildIndices(), 1));
    const mat = new THREE.MeshStandardMaterial({
      color: WOOD,
      roughness: 0.82,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
    this.stockMesh = new THREE.Mesh(geo, mat);
    this.stockMesh.frustumCulled = false;
    this.rotor.add(this.stockMesh);
    this.updateStock();
  }

  /** Rebuild the stock mesh — cheap no-op unless the cut model changed. */
  updateStock() {
    if (!this.stock || !this.stockMesh) return;
    if (this.stock.version === this._meshVer) return;
    this._meshVer = this.stock.version;
    this.stock.buildMesh(this._pos, this._nrm);
    const geo = this.stockMesh.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.computeBoundingSphere();
  }

  // -------------------------------------------------------------------------
  // Target "ghost" mesh (translucent wireframe of the finished part)
  // -------------------------------------------------------------------------
  setGhost(design, stockLen, R0, visible = true) {
    if (this.ghostMesh) {
      this.rotor.remove(this.ghostMesh);
      this.ghostMesh.geometry.dispose();
      this.ghostMesh.material.dispose();
      this.ghostMesh = null;
    }
    if (!design) return;
    const gnx = 84, gnth = 56;
    const pos = new Float32Array(gnx * gnth * 3);
    let k = 0;
    for (let i = 0; i < gnx; i++) {
      const v = (i / (gnx - 1)) * stockLen;
      for (let j = 0; j < gnth; j++) {
        const phi = (j / gnth) * Math.PI * 2;
        const r = design.targetRadius(phi * R0, v); // pattern is stock-locked
        pos[k++] = v;
        pos[k++] = -r * Math.sin(phi);
        pos[k++] = r * Math.cos(phi);
      }
    }
    const idx = [];
    for (let i = 0; i < gnx - 1; i++) {
      for (let j = 0; j < gnth; j++) {
        const jn = (j + 1) % gnth;
        const a = i * gnth + j, b = i * gnth + jn;
        const c = (i + 1) * gnth + j, d = (i + 1) * gnth + jn;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x5eead4,
      wireframe: true,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
    });
    this.ghostMesh = new THREE.Mesh(geo, mat);
    this.ghostMesh.frustumCulled = false;
    this.ghostMesh.visible = visible;
    this.rotor.add(this.ghostMesh);
  }

  // -------------------------------------------------------------------------
  // Toolpath traces (drawn in rotor space: the path inscribed on the part)
  // -------------------------------------------------------------------------
  setPaths(program) {
    const groups = { rapid: [], rough: [], finish: [] };
    const segGroup = new Uint8Array(program.segments.length);
    const GROUP_ID = { rapid: 0, rough: 1, finish: 2 };
    const p0 = [0, 0, 0], p1 = [0, 0, 0];
    let prev = { X: 0, Z: 0, A: 0 };
    for (let i = 0; i < program.segments.length; i++) {
      const s = program.segments[i];
      const g = s.mode === 'G0' ? 'rapid' : s.group;
      const gk = g === 'rough' ? 'rough' : g === 'finish' ? 'finish' : 'rapid';
      groups[gk].push(...makeRotorPoint(p0, prev.X, prev.Z, prev.A));
      groups[gk].push(...makeRotorPoint(p1, s.X, s.Z, s.A));
      segGroup[i] = GROUP_ID[gk];
      prev = s;
    }
    for (const key of Object.keys(groups)) {
      const arr = new Float32Array(groups[key]);
      const pair = this.pathMeshes[key];
      for (const mesh of [pair.all, pair.done]) {
        mesh.geometry.dispose();
        mesh.geometry = new THREE.BufferGeometry();
        mesh.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        mesh.geometry.setDrawRange(0, arr.length / 3);
      }
      pair.done.geometry.setDrawRange(0, 0);
    }
    this._groupOfSeg = segGroup;
    this._lastDone = [-1, -1, -1];
  }

  /** Brighten everything the TCP has already travelled over (segment granularity). */
  setProgress(segIdx) {
    if (!this._groupOfSeg) return;
    const counts = [0, 0, 0];
    const upto = Math.min(segIdx, this._groupOfSeg.length - 1);
    // Counts per group are monotone; recompute is an O(segs) int loop — cheap.
    for (let i = 0; i <= upto; i++) counts[this._groupOfSeg[i]]++;
    const keys = ['rapid', 'rough', 'finish'];
    for (let g = 0; g < 3; g++) {
      const pair = this.pathMeshes[keys[g]];
      const verts = counts[g] * 2;
      if (this._lastDone[g] !== verts) {
        pair.done.geometry.setDrawRange(0, verts);
        this._lastDone[g] = verts;
      }
    }
  }

  setGroupVisible(name, visible) {
    const pair = this.pathMeshes[name];
    if (pair) { pair.all.visible = visible; pair.done.visible = visible; }
  }

  setGhostVisible(v) {
    if (this.ghostMesh) this.ghostMesh.visible = v;
  }

  // -------------------------------------------------------------------------
  // Per-frame kinematics
  // -------------------------------------------------------------------------
  setRotor(aDeg) {
    this.rotor.rotation.x = -aDeg * RAD_PER_DEG;
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
