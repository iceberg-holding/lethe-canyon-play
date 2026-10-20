// Procedural "Cormorant" (БАКЛАН): blunt armoured nose, short thick wings,
// two big rear engine pods. Nose points to -Z. ~2k triangles.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lerp } from './util.js';

// loft an octagonal armoured cross-section along z
function loft(sections, prof) {
  prof = prof || [[1, 0], [0.72, 0.78], [0, 1], [-0.72, 0.78], [-1, 0], [-0.75, -0.55], [0, -0.7], [0.75, -0.55]];
  const P = prof.length, pos = [], uv = [], ix = [];
  sections.forEach((sc, i) => {
    for (let j = 0; j < P; j++) {
      pos.push(prof[j][0] * sc.w, sc.y + prof[j][1] * sc.h, sc.z);
      uv.push(j / P, i / sections.length);
    }
  });
  for (let i = 0; i < sections.length - 1; i++) for (let j = 0; j < P; j++) {
    const a = i * P + j, b = i * P + ((j + 1) % P), c = a + P, d = b + P;
    ix.push(a, b, c, b, d, c);
  }
  // caps
  const addCap = (i, flip) => {
    const sc = sections[i], ci = pos.length / 3;
    pos.push(0, sc.y, sc.z); uv.push(0.5, 0.5);
    for (let j = 0; j < P; j++) {
      const a = i * P + j, b = i * P + ((j + 1) % P);
      if (flip) ix.push(ci, a, b); else ix.push(ci, b, a);
    }
  };
  addCap(0, false); addCap(sections.length - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(ix);
  return g.toNonIndexed();
}
const T = (g, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  const out = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(m);
  out.deleteAttribute('normal');
  return out;
};
const merge = (list) => { const g = mergeGeometries(list); g.computeVertexNormals(); return g; };

function wingGeo(side) {
  const sh = new THREE.Shape();
  // in (x, z) plane; root along x=0 (pivot), z forward negative
  sh.moveTo(0, -1.8); sh.lineTo(3.6, 0.9); sh.lineTo(3.8, 2.4); sh.lineTo(0, 3.1); sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.42, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.1, bevelSegments: 1 });
  // shape XY -> XZ, thickness along y
  g.rotateX(Math.PI / 2);
  g.translate(0, 0.21, 0);
  if (side < 0) { g.scale(-1, 1, 1); const idx = g.index; if (!idx) { const p = g.attributes.position; for (let i = 0; i < p.count; i += 3) { for (let k = 0; k < 3; k++) { const t = p.getComponent(i + 1, k); p.setComponent(i + 1, k, p.getComponent(i + 2, k)); p.setComponent(i + 2, k, t); } } } }
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

export class Ship {
  constructor() {
    this.group = new THREE.Group();      // world transform (yaw/pitch/roll)
    const body = new THREE.Group();
    this.body = body;
    this.group.add(body);

    const metal = new THREE.MeshPhongMaterial({ color: 0x74777a, specular: 0x3a3a3a, shininess: 26, flatShading: true });
    const dark = new THREE.MeshPhongMaterial({ color: 0x2a2c2f, specular: 0x222222, shininess: 18, flatShading: true });
    const pale = new THREE.MeshPhongMaterial({ color: 0xb8bbbd, specular: 0x333333, shininess: 22, flatShading: true });
    const ochre = new THREE.MeshPhongMaterial({ color: 0xb07a2c, specular: 0x222222, shininess: 12, flatShading: true });
    const glass = new THREE.MeshPhongMaterial({ color: 0x141a1e, specular: 0xffd9a0, shininess: 90, emissive: 0x2a1606, flatShading: true });
    this.mats = { metal, dark, pale, ochre, glass };

    // hull
    const hull = loft([
      { z: -7.3, w: 0.95, h: 0.42, y: -0.15 },
      { z: -6.6, w: 1.35, h: 0.66, y: -0.05 },
      { z: -4.2, w: 1.75, h: 0.95, y: 0.05 },
      { z: -0.5, w: 1.95, h: 1.15, y: 0.15 },
      { z: 3.2, w: 1.8, h: 1.05, y: 0.12 },
      { z: 5.8, w: 1.35, h: 0.8, y: 0.12 },
      { z: 6.9, w: 1.0, h: 0.58, y: 0.12 },
    ]);
    const pods = [];
    for (const sx of [-1, 1]) {
      pods.push(T(new THREE.CylinderGeometry(1.05, 1.18, 5.6, 12), sx * 2.65, 0.0, 3.9, Math.PI / 2));
      pods.push(T(new THREE.CylinderGeometry(0.6, 1.05, 1.3, 12), sx * 2.65, 0.0, 0.45, Math.PI / 2));
      // spine strut joining pod to hull
      pods.push(T(new THREE.BoxGeometry(1.6, 0.55, 3.2), sx * 1.8, 0.2, 3.8));
    }
    // canted tail fins
    for (const sx of [-1, 1]) pods.push(T(new THREE.BoxGeometry(0.14, 0.9, 1.8), sx * 0.75, 1.3, 5.5, 0.45, 0, -sx * 0.5));
    // armoured canopy frame
    pods.push(T(new THREE.BoxGeometry(0.16, 0.22, 3.9), 0, 1.62, -2.0, 0.08));
    this.add(merge([hull, ...pods]), metal);

    const darkParts = [];
    for (const sx of [-1, 1]) {
      darkParts.push(T(new THREE.CylinderGeometry(0.98, 1.08, 0.7, 12, 1, true), sx * 2.65, 0, 6.95, Math.PI / 2));
      darkParts.push(T(new THREE.TorusGeometry(0.72, 0.2, 6, 14), sx * 2.65, 0, -0.25));
      darkParts.push(T(new THREE.CylinderGeometry(0.13, 0.16, 2.0, 6), sx * 0.62, -0.42, -7.4, Math.PI / 2));
      darkParts.push(T(new THREE.BoxGeometry(0.5, 0.35, 1.2), sx * 0.62, -0.45, -6.2));
    }
    this.add(merge(darkParts), dark);

    // light grey replacement panel on the left nose, ochre hazard stripes, water tank
    this.add(merge([T(new THREE.BoxGeometry(0.06, 0.55, 2.0), -1.47, 0.1, -5.0, 0, -0.13, 0)]), pale);
    const tank = T(new THREE.CapsuleGeometry(0.62, 3.4, 3, 10), 0, -1.0, 0.8, Math.PI / 2);
    this.add(merge([tank]), pale);
    this.add(merge([
      T(new THREE.BoxGeometry(0.06, 0.18, 2.4), 1.49, 0.25, -4.6, 0, 0.13, 0),
      T(new THREE.BoxGeometry(0.06, 0.18, 2.4), -1.49, -0.15, -4.6, 0, -0.13, 0),
      T(new THREE.BoxGeometry(2.2, 0.06, 0.3), 2.65, 1.08, 5.2),
      T(new THREE.BoxGeometry(2.2, 0.06, 0.3), -2.65, 1.08, 5.2),
    ]), ochre);

    // canopy with slit armour
    const canopy = loft([
      { z: -4.1, w: 0.35, h: 0.2, y: 0.9 },
      { z: -3.2, w: 0.75, h: 0.48, y: 1.05 },
      { z: -1.0, w: 0.86, h: 0.58, y: 1.12 },
      { z: 0.6, w: 0.7, h: 0.4, y: 1.1 },
    ]);
    this.add(canopy, glass);
    // dive shield: slides over the canopy
    this.shield = this.add(loft([
      { z: -4.2, w: 0.42, h: 0.25, y: 0.92 },
      { z: -3.2, w: 0.84, h: 0.55, y: 1.06 },
      { z: -1.0, w: 0.95, h: 0.66, y: 1.13 },
      { z: 0.7, w: 0.78, h: 0.46, y: 1.1 },
    ]), dark);
    this.shield.scale.set(1, 0.2, 0.25);
    this.shield.position.set(0, 0.95, 1.6);

    // wings on pivots at the root
    this.wings = [];
    for (const sx of [-1, 1]) {
      const piv = new THREE.Group();
      piv.position.set(sx * 1.55, -0.55, 0.4);
      const w = new THREE.Mesh(wingGeo(sx), metal);
      piv.add(w);
      // wing-tip ochre marker
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 1.2), ochre);
      tip.position.set(sx * 3.7, 0.2, 1.7);
      piv.add(tip);
      body.add(piv);
      this.wings.push(piv);
    }

    // engine glow discs + iris rings
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xffa040 });
    this.irises = [];
    this.nozzles = [];
    for (const sx of [-1, 1]) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.9, 16), this.glowMat);
      disc.position.set(sx * 2.65, 0, 7.15);
      body.add(disc);
      const iris = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.16, 6, 16), dark);
      iris.position.set(sx * 2.65, 0, 7.25);
      body.add(iris);
      this.irises.push(iris);
      this.nozzles.push(new THREE.Vector3(sx * 2.65, 0, 7.6));
    }
    this.muzzles = [new THREE.Vector3(-0.62, -0.42, -8.6), new THREE.Vector3(0.62, -0.42, -8.6)];
    this.diveT = 0;
    this._amber = new THREE.Color(1.0, 0.62, 0.22);
    this._cold = new THREE.Color(0.25, 1.0, 0.92);
    this.glowColor = new THREE.Color();
  }
  add(geo, mat) {
    const m = new THREE.Mesh(geo, mat);
    this.body.add(m);
    return m;
  }
  // dive: 0 = flight config, 1 = submerged config (~0.4 s transition)
  animate(dt, diving, boost, time) {
    const target = diving ? 1 : 0;
    const k = dt / 0.4;
    this.diveT += Math.max(-k, Math.min(k, target - this.diveT));
    const d = this.diveT, e = d * d * (3 - 2 * d);
    this.wings[0].rotation.y = -e * 0.61;   // 35 deg sweep back
    this.wings[1].rotation.y = e * 0.61;
    this.shield.scale.set(1, lerp(0.2, 1, e), lerp(0.25, 1, e));
    this.shield.position.set(0, lerp(0.95, 0, e), lerp(1.6, 0, e));
    for (const ir of this.irises) ir.scale.setScalar(lerp(1, 0.72, e));
    const flick = 0.92 + 0.08 * Math.sin(time * 60) + boost * 0.25;
    this.glowColor.copy(this._amber).lerp(this._cold, e);
    this.glowMat.color.copy(this.glowColor).multiplyScalar(flick);
  }
}
