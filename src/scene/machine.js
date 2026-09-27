/**
 * machine.js — static CNC machine visuals (headstock, tailstock, bed) plus
 * the moving X–Z carriage with spindle and cutter.
 *
 * World conventions (see unroll.js): rotary axis = world X at y=0,z=0; tool
 * axis vertical through world y=0; tool tip at (X, 0, Z). Everything here is
 * cosmetic — the kinematics live in sim/stock, this just follows them.
 */
import * as THREE from 'three';

const MAT = {
  bed: new THREE.MeshStandardMaterial({ color: 0x232a35, roughness: 0.85, metalness: 0.35 }),
  cast: new THREE.MeshStandardMaterial({ color: 0x333c4b, roughness: 0.7, metalness: 0.4 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x5a6577, roughness: 0.45, metalness: 0.8 }),
  accent: new THREE.MeshStandardMaterial({ color: 0x2d6cdf, roughness: 0.5, metalness: 0.5 }),
  tool: new THREE.MeshStandardMaterial({ color: 0xb9c2cf, roughness: 0.3, metalness: 0.95 }),
  rail: new THREE.MeshStandardMaterial({ color: 0x8d97a5, roughness: 0.35, metalness: 0.9 }),
  tip: new THREE.MeshBasicMaterial({ color: 0xffe08a }),
};

const BED_LEN = 700;       // generous fixed bed, covers stock up to ~450 mm
const FLOOR_Z = -150;      // top of bed / grid plane
const RAIL_Y = 42;

function box(w, h, d, mat) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}
function cylX(r, len, mat, segs = 28) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, segs), mat);
  m.rotation.z = Math.PI / 2; // cylinder default axis Y → rotate to X
  return m;
}
function cylZ(r, len, mat, segs = 24) {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, segs), mat);
}

export class MachineModel {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    // ---- bed ---------------------------------------------------------------
    const bed = box(BED_LEN, 60, 26, MAT.bed);
    bed.position.set(150, 0, FLOOR_Z - 13);
    this.group.add(bed);

    // linear rails along X
    const railGeoLen = BED_LEN - 40;
    for (const sy of [-RAIL_Y, RAIL_Y]) {
      const rail = cylX(4.5, railGeoLen, MAT.rail);
      rail.position.set(150, sy, FLOOR_Z + 6);
      this.group.add(rail);
    }

    // ---- headstock (left, houses the A-axis motor + chuck) ------------------
    const head = new THREE.Group();
    const hsH = 185; // spans bed top (FLOOR_Z) up to z=+35, axis passes through
    const hb = new THREE.Mesh(new THREE.BoxGeometry(56, 96, hsH), MAT.cast);
    hb.position.set(-40, 0, (35 + FLOOR_Z) / 2);
    head.add(hb);
    const motor = cylX(20, 34, MAT.metal);
    motor.position.set(-80, 0, -30);
    head.add(motor);
    const chuck = cylX(24, 22, MAT.metal);
    chuck.position.set(-13, 0, 0); // grips the stock start at X=0
    head.add(chuck);
    const collar = cylX(15, 14, MAT.accent); // A-axis drive collar
    collar.position.set(-27, 0, 0);
    head.add(collar);
    this.group.add(head);

    // ---- tailstock (slides along the bed, centres the far end) --------------
    this.tailstock = new THREE.Group();
    const tb = new THREE.Mesh(new THREE.BoxGeometry(44, 80, 170), MAT.cast);
    tb.position.set(30, 0, -65); // rests on the bed, reaches just past the axis
    this.tailstock.add(tb);
    const quill = cylX(7, 34, MAT.rail);
    quill.position.set(-2, 0, 0);
    this.tailstock.add(quill);
    const center = new THREE.Mesh(new THREE.ConeGeometry(9, 16, 20), MAT.metal);
    center.rotation.z = Math.PI / 2; // cone apex (+Y default) now points −X
    center.position.set(-12, 0, 0);
    this.tailstock.add(center);
    this.group.add(this.tailstock);

    // ---- carriage: rides the rails in X, head rides the ram in Z ------------
    this.carriage = new THREE.Group();
    const saddle = box(56, 110, 22, MAT.cast);
    saddle.position.set(0, 0, FLOOR_Z + 11); // saddle top at FLOOR_Z+22
    this.carriage.add(saddle);
    const ram = box(26, 30, 330, MAT.metal);
    ram.position.set(18, 0, FLOOR_Z + 22 + 165); // rises to z≈+200
    this.carriage.add(ram);

    // spindle head + tool group: positioned at (0,0,Z), Z == machine Z
    this.headZ = new THREE.Group();
    const headBox = box(40, 52, 64, MAT.accent);
    headBox.position.set(2, 0, 34);
    this.headZ.add(headBox);
    const spindle = cylZ(11, 26, MAT.metal);
    spindle.position.set(0, 0, -4);
    this.headZ.add(spindle);
    const collet = new THREE.Mesh(new THREE.CylinderGeometry(8, 5.5, 10, 20), MAT.metal);
    collet.position.set(0, 0, -21);
    this.headZ.add(collet);
    this.carriage.add(this.headZ);

    // cutter mesh rebuilt whenever tool type/diameter changes
    this.toolGroup = new THREE.Group();
    this.headZ.add(this.toolGroup);

    // glowing point exactly at the tool tip (X, 0, Z)
    this.tipDot = new THREE.Mesh(new THREE.SphereGeometry(1.6, 10, 10), MAT.tip);
    this.group.add(this.tipDot);

    this.group.add(this.carriage);
  }

  /** Reposition tailstock when stock length changes (cone tip meets X=L). */
  setStockLength(L) {
    this.tailstock.position.x = L + 20;
  }

  /** Rebuild cutter mesh: flat cylinder or ball-nose (sphere + shank). */
  setTool(type, diameter) {
    while (this.toolGroup.children.length) {
      const c = this.toolGroup.children[0];
      c.geometry.dispose();
      this.toolGroup.remove(c);
    }
    const R = Math.max(diameter / 2, 0.2);
    const len = 30;
    if (type === 'ball') {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(R, 20, 14), MAT.tool);
      ball.position.z = R; // sphere bottom touches z=0 (the tip plane)
      this.toolGroup.add(ball);
      const shank = cylZ(R * 0.92, len, MAT.tool);
      shank.position.z = R + len / 2 - 2;
      this.toolGroup.add(shank);
    } else {
      const mill = cylZ(R, len, MAT.tool);
      mill.position.z = len / 2;
      this.toolGroup.add(mill);
    }
  }

  /** Follow the simulated machine pose. */
  updatePose(x, z) {
    this.carriage.position.x = x;
    this.headZ.position.z = z;
    this.tipDot.position.set(x, 0, z);
  }
}
