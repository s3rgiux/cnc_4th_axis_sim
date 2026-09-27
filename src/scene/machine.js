/**
 * machine.js — static CNC machine visuals (headstock, tailstock, bed) plus
 * the moving X–Z carriage with spindle and cutter.
 *
 * World conventions (see unroll.js): rotary axis = world X at y=0,z=0; tool
 * axis vertical through world y=0; tool tip at (X, 0, Z). Everything here is
 * cosmetic — the kinematics live in sim/stock, this just follows them.
 *
 * Carriage = overhead gantry (M1): two side posts + bridge sized so their
 * inner faces sit outside the maximum stock swing radius (60 mm, diameter
 * input ≤ 120). The carriage can therefore travel the full bed length at any
 * stock length without any solid member crossing the swept circle of the
 * work. Z-feed is a telescoping quill + cutter descending from the fixed
 * spindle housing under the bridge; nothing solid passes beside the axis.
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

// Gantry envelope (M1). Post inner faces must stay outside the swept circle.
const SWING_MAX = 60;      // max stock radius the sim allows (Ø ≤ 120)
const POST_Y = 90;         // post centre y; inner face at 82 > SWING_MAX ✓
const POST_BOTTOM = FLOOR_Z + 22;              // saddle top
const BRIDGE_Z = 170;      // bridge centre, spans 156..184 (≫ SWING_MAX ✓)
const POST_TOP = BRIDGE_Z - 14;
const HOUSING_Z = 131;     // spindle housing centre, spans 104..158
const QUILL_TOP = 98;      // bottom of the spindle nose bore (fixed)
const COLLET_TOP = 43;     // local z of the collet top, above the tip

function box(w, h, d, mat) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}
function cylX(r, len, mat, segs = 28) {
  const g = new THREE.CylinderGeometry(r, r, len, segs);
  g.rotateZ(Math.PI / 2); // cylinder default axis Y → X (baked into verts)
  return new THREE.Mesh(g, mat);
}
function cylZ(r, len, mat, segs = 24) {
  const g = new THREE.CylinderGeometry(r, r, len, segs);
  g.rotateX(Math.PI / 2); // axis Y → Z: tool/spindle axis is world Z
  return new THREE.Mesh(g, mat);
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
    const tq = cylX(7, 34, MAT.rail); // tailstock quill
    tq.position.set(-2, 0, 0);
    this.tailstock.add(tq);
    const center = new THREE.Mesh(new THREE.ConeGeometry(9, 16, 20), MAT.metal);
    center.geometry.rotateZ(Math.PI / 2); // cone apex (+Y default) now points −X
    center.position.set(-12, 0, 0);
    this.tailstock.add(center);
    this.group.add(this.tailstock);

    // ---- carriage: overhead gantry straddling the work ----------------------
    this.carriage = new THREE.Group();
    this.frameMeshes = []; // structural members that must never enter the swept circle
    const frame = (mesh) => { this.frameMeshes.push(mesh); return mesh; };

    const saddle = frame(box(56, 110, 22, MAT.cast));
    saddle.position.set(0, 0, FLOOR_Z + 11); // saddle top at FLOOR_Z+22
    this.carriage.add(saddle);

    const crossPlate = frame(box(60, 2 * POST_Y + 20, 14, MAT.cast));
    crossPlate.position.set(0, 0, POST_BOTTOM + 7); // spans below the work
    this.carriage.add(crossPlate);

    const postH = POST_TOP - POST_BOTTOM;
    for (const sy of [-POST_Y, POST_Y]) {
      const post = frame(box(22, 16, postH, MAT.cast));
      post.position.set(0, sy, (POST_TOP + POST_BOTTOM) / 2);
      this.carriage.add(post);
    }

    const bridge = frame(box(50, 2 * POST_Y + 32, 28, MAT.cast));
    bridge.position.set(0, 0, BRIDGE_Z);
    this.carriage.add(bridge);

    // spindle housing + nose bore: fixed under the bridge (Z-feed = quill)
    const housing = frame(box(46, 58, 54, MAT.accent));
    housing.position.set(0, 0, HOUSING_Z);
    this.carriage.add(housing);
    const nose = frame(cylZ(14, 14, MAT.metal));
    nose.position.set(0, 0, QUILL_TOP + 7); // bore the quill slides through
    this.carriage.add(nose);

    // telescoping quill: unit-height cylinder along Z, scaled per frame
    this.quill = cylZ(7, 1, MAT.metal, 20);
    this.carriage.add(this.quill);

    // Z head: collet + cutter ride here, origin == tool tip (X, 0, Z)
    this.headZ = new THREE.Group();
    this.carriage.add(this.headZ);

    // collet + cutter meshes rebuilt whenever tool type/diameter changes
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

  /** Rebuild collet + cutter: flat cylinder, ball-nose (sphere + shank) or
   *  V-bit (truncated cone widening at the included angle + shank). */
  setTool(type, diameter, angle = 90) {
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
      const shank = cylZ(Math.max(R * 0.92, 1.2), len, MAT.tool);
      shank.position.z = R + len / 2 - 2;
      this.toolGroup.add(shank);
    } else if (type === 'vbit') {
      // Truncated cone: tip flat radius R at z=0, flanks opening at angle/2.
      const a = Math.min(Math.max(angle, 15), 170) * 0.5 * (Math.PI / 180);
      const coneLen = 26;
      const rTop = R + coneLen * Math.tan(a);
      const coneGeo = new THREE.CylinderGeometry(rTop, R, coneLen, 24);
      coneGeo.rotateX(Math.PI / 2); // +Y (wide end) → +Z: flanks open upward
      const cone = new THREE.Mesh(coneGeo, MAT.tool);
      cone.position.z = coneLen / 2;
      this.toolGroup.add(cone);
      const shank = cylZ(Math.min(Math.max(R * 0.92, 1.2), rTop), len, MAT.tool);
      shank.position.z = coneLen + len / 2 - 2;
      this.toolGroup.add(shank);
    } else {
      const mill = cylZ(R, len, MAT.tool);
      mill.position.z = len / 2;
      this.toolGroup.add(mill);
    }
    // collet nut gripping the shank just above the cutter
    const collet = new THREE.Mesh(
      new THREE.CylinderGeometry(9.5, Math.max(R + 1, 5.5), 14, 20), MAT.metal,
    );
    collet.geometry.rotateX(Math.PI / 2); // axis → Z
    collet.position.z = COLLET_TOP - 7;   // spans ~29..43 above the tip
    this.toolGroup.add(collet);
  }

  /** Follow the simulated machine pose. */
  updatePose(x, z) {
    this.carriage.position.x = x;
    this.headZ.position.z = z;
    // quill spans from the fixed nose bore down to the travelling collet top
    const bottom = z + COLLET_TOP;
    const len = QUILL_TOP - bottom;
    if (len > 1.5) {
      this.quill.visible = true;
      this.quill.scale.z = len;
      this.quill.position.z = (QUILL_TOP + bottom) / 2;
    } else {
      this.quill.visible = false; // fully retracted into the spindle nose
    }
    this.tipDot.position.set(x, 0, z);
  }
}
