// Round 4 naval layer meshes: tethered mines (+ chains, sinkers), LETHE hunter-subs, smuggler / patrol boats
// (bow + stern halves so a destroyed boat breaks apart) with a glowing belly weak point, and the LETHE rim turret.
// Everything is instanced: one draw call per mesh type.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function colored(g, c) {
  g = g.index ? g.toNonIndexed() : g.clone();
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set(c, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));   // uniform attribute set for merging
  return g;
}
export const tr = (g, x, y, z, rx = 0, ry = 0, rz = 0) => g.rotateX(rx).rotateY(ry).rotateZ(rz).translate(x, y, z);

// Lambert + vertex colours + a view-space fresnel rim (light edge so dark metal reads against the rock)
export function rimMaterial(rim = [0.9, 0.72, 0.55], k = 0.9) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRim = { value: new THREE.Color(...rim).multiplyScalar(k) };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim;')
      .replace('#include <opaque_fragment>', `
        { vec3 vv = normalize(vViewPosition); float fr = pow(1.0 - clamp(abs(dot(normal, vv)), 0.0, 1.0), 2.6);
          outgoingLight += uRim * fr; }
        #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'rim' + rim.join(',') + k;
  return m;
}

function inst(geo, mat, n, dynamic = true) {
  const m = new THREE.InstancedMesh(geo, mat, n);
  if (dynamic) m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = false;
  const z = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < n; i++) m.setMatrixAt(i, z);
  return m;
}

// ---------------------------------------------------------------- mines
export function buildMines(n, mat) {
  const parts = [colored(new THREE.SphereGeometry(1.05, 14, 10), [0.2, 0.17, 0.15])];
  // spikes (horn detonators) on the icosahedron vertices
  const ico = new THREE.IcosahedronGeometry(1, 0);
  const pos = ico.attributes.position, seen = new Set();
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i).normalize();
    const key = v.toArray().map((x) => x.toFixed(2)).join();
    if (seen.has(key)) continue;
    seen.add(key);
    const c = new THREE.ConeGeometry(0.13, 0.55, 6).translate(0, 1.22, 0);
    c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v));
    parts.push(colored(c, [0.32, 0.29, 0.25]));
    const cap = new THREE.CylinderGeometry(0.17, 0.17, 0.12, 6).translate(0, 1.0, 0);
    cap.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v));
    parts.push(colored(cap, [0.55, 0.12, 0.08]));
  }
  parts.push(colored(tr(new THREE.TorusGeometry(1.07, 0.09, 5, 20), 0, 0, 0, Math.PI / 2), [0.42, 0.24, 0.12]));
  parts.push(colored(tr(new THREE.CylinderGeometry(0.22, 0.22, 0.4, 6), 0, -1.15, 0), [0.15, 0.14, 0.13]));
  const mines = inst(mergeGeometries(parts), mat, n);
  // chain: a stack of flat links (unit height, scaled in y to the tether length)
  const links = [];
  for (let k = 0; k < 10; k++) links.push(colored(tr(new THREE.TorusGeometry(0.05, 0.022, 3, 6).scale(1, 1.9, 1), 0, k / 10 + 0.05, 0, 0, k % 2 ? Math.PI / 2 : 0), [0.2, 0.18, 0.16]));
  links.push(colored(tr(new THREE.CylinderGeometry(0.018, 0.018, 1, 4), 0, 0.5, 0), [0.16, 0.15, 0.14]));
  const chains = inst(mergeGeometries(links), mat, n);
  const sinkers = inst(mergeGeometries([
    colored(tr(new THREE.CylinderGeometry(0.7, 0.9, 0.7, 6), 0, 0.35, 0), [0.17, 0.16, 0.15]),
    colored(tr(new THREE.TorusGeometry(0.25, 0.06, 4, 8), 0, 0.85, 0), [0.25, 0.22, 0.2]),
  ]), mat, n);
  return { mines, chains, sinkers };
}

// ---------------------------------------------------------------- hunter-subs (nose along -Z)
export function buildHunters(n, mat) {
  const g = mergeGeometries([
    colored(tr(new THREE.CylinderGeometry(0.42, 0.36, 2.6, 10), 0, 0, 0, Math.PI / 2), [0.17, 0.19, 0.22]),
    colored(tr(new THREE.SphereGeometry(0.42, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0, -1.3, -Math.PI / 2), [0.24, 0.27, 0.3]),
    colored(tr(new THREE.CylinderGeometry(0.15, 0.15, 0.06, 8), 0, 0, -1.72, Math.PI / 2), [0.5, 1.4, 1.5]),
    colored(tr(new THREE.CylinderGeometry(0.36, 0.2, 0.7, 10), 0, 0, 1.6, Math.PI / 2), [0.13, 0.14, 0.16]),
    colored(tr(new THREE.TorusGeometry(0.38, 0.06, 4, 12), 0, 0, 1.85), [0.3, 0.33, 0.36]),
    colored(tr(new THREE.BoxGeometry(1.5, 0.05, 0.45), 0, 0, 1.45), [0.22, 0.24, 0.27]),
    colored(tr(new THREE.BoxGeometry(0.05, 1.3, 0.45), 0, 0, 1.45), [0.22, 0.24, 0.27]),
    colored(tr(new THREE.BoxGeometry(0.06, 0.04, 1.6), 0.4, 0, -0.1), [0.4, 1.3, 1.4]),
    colored(tr(new THREE.BoxGeometry(0.06, 0.04, 1.6), -0.4, 0, -0.1), [0.4, 1.3, 1.4]),
  ]);
  return inst(g, mat, n);
}

// ---------------------------------------------------------------- boats (bow toward -Z; deck at y = 1.3, keel at -1.3)
// Round 15 detail (keel, gunwale, rails, windows, rudder, propeller, scanner dish) lives on the
// same bow/stern halves, so a wreck still reads as a vessel. Collision box is unchanged.
const HULL_H = 2.6;
function hullHalf(pts) {
  const sh = new THREE.Shape();
  pts.forEach(([x, y], i) => (i ? sh.lineTo(x, y) : sh.moveTo(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: HULL_H, bevelEnabled: false });
  g.rotateX(-Math.PI / 2).translate(0, -HULL_H / 2, 0);
  return g;
}
const BOW = [[-2.5, 0], [2.5, 0], [2.5, 4.2], [1.3, 6.5], [0, 7.3], [-1.3, 6.5], [-2.5, 4.2]];
const STERN = [[-2.5, 0], [-2.3, -6.9], [2.3, -6.9], [2.5, 0]];
export const BOAT_HL = 7.1, BOAT_HW = 2.6, BOAT_KEEL = -1.3, BOAT_TOP = 4.6;
export const BOAT_FEATURES = ['keel', 'gunwale', 'rails', 'portholes', 'windows', 'rudder', 'propeller', 'scanner'];
const box = (w, h, d, x, y, z, c, rx = 0, ry = 0, rz = 0) => colored(tr(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz), c);
const cyl = (rt, rb, h, x, y, z, c, rx = 0, ry = 0, rz = 0, seg = 7) => colored(tr(new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z, rx, ry, rz), c);
function railRun(parts, x, y, z0, z1, c, posts = 4) {
  parts.push(box(0.08, 0.1, Math.abs(z1 - z0), x, y, (z0 + z1) / 2, c));
  for (let i = 0; i < posts; i++) parts.push(box(0.07, 0.5, 0.07, x, y - 0.26, z0 + (z1 - z0) * (i / (posts - 1)), c));
}
function portholes(parts, x, y, z0, n, dz, c) {
  for (let i = 0; i < n; i++) parts.push(cyl(0.16, 0.16, 0.22, x, y, z0 + i * dz, c, 0, 0, Math.PI / 2, 8));
}
function prop(parts, x, y, z, shaft, blade) {
  parts.push(cyl(0.09, 0.11, 0.85, x, y, z, shaft, Math.PI / 2, 0, 0, 6));
  parts.push(cyl(0.2, 0.2, 0.14, x, y, z + 0.42, shaft, Math.PI / 2, 0, 0, 8));
  for (let k = 0; k < 3; k++) parts.push(box(0.1, 0.78, 0.05, x, y, z + 0.5, blade, 0, 0, k * 2.094));
}
function hullDetail(parts, bow, band, dark, glass) {
  const z0 = bow ? -6.4 : 0.6, z1 = bow ? -0.35 : 6.35;
  parts.push(box(0.34, 0.28, (z1 - z0) - 0.4, 0, -1.42, (z0 + z1) / 2, dark));
  parts.push(box(0.22, 0.28, z1 - z0, 2.42, 1.32, (z0 + z1) / 2, band));
  parts.push(box(0.22, 0.28, z1 - z0, -2.42, 1.32, (z0 + z1) / 2, band));
  parts.push(box(0.14, 0.18, z1 - z0 - 0.4, 2.35, 0.02, (z0 + z1) / 2, dark));
  parts.push(box(0.14, 0.18, z1 - z0 - 0.4, -2.35, 0.02, (z0 + z1) / 2, dark));
  railRun(parts, 2.15, 1.62, z0 + 0.4, z1 - 0.3, dark, bow ? 4 : 5);
  railRun(parts, -2.15, 1.62, z0 + 0.4, z1 - 0.3, dark, bow ? 4 : 5);
  portholes(parts, 2.52, 0.15, bow ? -4.6 : 1.3, bow ? 3 : 4, 1.15, glass);
  portholes(parts, -2.52, 0.15, bow ? -4.6 : 1.3, bow ? 3 : 4, 1.15, glass);
  if (bow) parts.push(box(0.22, 1.7, 0.55, 0, 0.35, -6.85, dark));
  else {
    parts.push(box(0.12, 1.15, 0.5, 0, -0.55, 6.85, dark));
    prop(parts, 0, -0.82, 5.7, dark, band);
  }
}
export function buildBoats(n, mat) {
  // Council patrol: grey-white hull, dark waterline band, blue-grey bridge, bow gun, radar mast
  const pHull = [0.74, 0.76, 0.78], pBand = [0.16, 0.2, 0.26], pCab = [0.82, 0.84, 0.86], pDark = [0.2, 0.22, 0.25];
  const pGlass = [0.15, 0.28, 0.38], pBoot = [0.12, 0.3, 0.75];
  const pFparts = [
    colored(hullHalf(BOW), pHull),
    colored(tr(new THREE.BoxGeometry(5.1, 0.45, 4.3), 0, -0.95, -2.1), pBand),
    colored(tr(new THREE.BoxGeometry(3.4, 1.7, 3.0), 0, 2.15, -0.9), pCab),
    colored(tr(new THREE.BoxGeometry(3.45, 0.5, 0.2), 0, 2.55, -2.45), [0.12, 0.2, 0.3]),
    colored(tr(new THREE.CylinderGeometry(0.55, 0.65, 0.5, 8), 0, 1.55, -4.6), pDark),
    colored(tr(new THREE.CylinderGeometry(0.1, 0.12, 1.8, 6), 0, 1.75, -5.6, Math.PI / 2), pDark),
    colored(tr(new THREE.BoxGeometry(5.15, 0.18, 0.5), 0, 0.6, -3.5), pBoot),
    box(0.42, 0.34, 0.08, 0, 2.25, -2.42, pGlass),
    box(0.42, 0.34, 0.08, 0.7, 2.25, -2.42, pGlass),
    box(0.42, 0.34, 0.08, -0.7, 2.25, -2.42, pGlass),
    box(0.08, 0.36, 0.7, 1.72, 2.2, -1.3, pGlass),
    box(0.08, 0.36, 0.7, -1.72, 2.2, -1.3, pGlass),
    box(0.08, 0.36, 0.7, 1.72, 2.2, -0.4, pGlass),
    box(0.08, 0.36, 0.7, -1.72, 2.2, -0.4, pGlass),
    box(1.1, 0.08, 1.5, 0, 1.38, -3.4, [0.55, 0.58, 0.6]),
    box(0.35, 0.35, 0.35, -1.7, 1.55, -5.4, pDark),
  ];
  hullDetail(pFparts, true, pBand, pDark, pGlass);
  const pBparts = [
    colored(hullHalf(STERN), pHull),
    colored(tr(new THREE.BoxGeometry(5.1, 0.45, 6.8), 0, -0.95, 3.45), pBand),
    colored(tr(new THREE.BoxGeometry(3.0, 1.2, 2.6), 0, 1.9, 1.3), pCab),
    colored(tr(new THREE.CylinderGeometry(0.08, 0.1, 3.4, 5), 0, 3.6, 1.0), pDark),
    colored(tr(new THREE.BoxGeometry(1.4, 0.12, 0.3), 0, 4.6, 1.0), pDark),
    colored(tr(new THREE.BoxGeometry(5.15, 0.18, 0.5), 0, 0.6, 2.5), pBoot),
    colored(tr(new THREE.BoxGeometry(4.4, 0.3, 0.3), 0, 1.45, 6.7), pDark),
    box(0.5, 0.28, 0.08, 0.55, 2.05, 0.02, pGlass),
    box(0.5, 0.28, 0.08, -0.55, 2.05, 0.02, pGlass),
    box(0.08, 0.32, 0.55, 1.52, 2.0, 1.3, pGlass),
    box(0.08, 0.32, 0.55, -1.52, 2.0, 1.3, pGlass),
    cyl(0.62, 0.62, 0.08, 0, 5.55, 1.0, [0.7, 0.78, 0.85], Math.PI / 2, 0, 0, 10),
    cyl(0.16, 0.22, 0.28, 0, 5.28, 1.0, pDark, 0, 0, 0, 6),
    box(0.9, 0.16, 1.6, 0, 1.42, 4.2, [0.5, 0.53, 0.56]),
  ];
  hullDetail(pBparts, false, pBand, pDark, pGlass);
  const pF = mergeGeometries(pFparts);
  const pB = mergeGeometries(pBparts);
  // smuggler: rusty patched hull, cargo crates under a tarp, aft wheelhouse, exhaust stack
  const sHull = [0.42, 0.22, 0.12], sRust = [0.55, 0.28, 0.12], sDark = [0.16, 0.12, 0.1];
  const sGlass = [0.22, 0.16, 0.1], sTarp = [0.28, 0.3, 0.2];
  const sFparts = [
    colored(hullHalf(BOW), sHull),
    colored(tr(new THREE.BoxGeometry(5.1, 0.5, 2.0), 0, -0.4, -1.2), sRust),
    colored(tr(new THREE.BoxGeometry(5.1, 0.35, 1.2), 0, 0.5, -4.0), [0.3, 0.3, 0.27]),
    colored(tr(new THREE.BoxGeometry(1.6, 1.2, 1.6), -0.9, 1.9, -2.2), [0.35, 0.42, 0.3]),
    colored(tr(new THREE.BoxGeometry(1.5, 1.0, 1.5), 0.95, 1.8, -1.0, 0, 0.2), [0.5, 0.36, 0.2]),
    colored(tr(new THREE.BoxGeometry(1.2, 0.9, 1.2), 0.6, 1.75, -3.6, 0, -0.3), [0.4, 0.4, 0.38]),
    box(3.6, 0.12, 2.4, 0, 2.55, -2.2, sTarp, 0.08, 0, 0.04),
    box(0.5, 0.16, 0.5, -1.6, 1.5, -5.2, sDark),
  ];
  hullDetail(sFparts, true, sRust, sDark, sGlass);
  const sBparts = [
    colored(hullHalf(STERN), sHull),
    colored(tr(new THREE.BoxGeometry(5.1, 0.6, 2.4), 0, -0.2, 3.5), sRust),
    colored(tr(new THREE.BoxGeometry(3.2, 2.0, 2.6), 0, 2.3, 3.6), [0.5, 0.4, 0.3]),
    colored(tr(new THREE.BoxGeometry(3.25, 0.45, 0.2), 0, 2.8, 2.3), [0.1, 0.1, 0.1]),
    colored(tr(new THREE.CylinderGeometry(0.28, 0.32, 1.8, 7), 0.9, 3.9, 4.6), sDark),
    colored(tr(new THREE.BoxGeometry(2.8, 0.7, 1.8), 0, 1.65, 0.9), [0.3, 0.32, 0.22]),
    box(0.55, 0.32, 0.08, 0.45, 2.45, 2.32, sGlass),
    box(0.55, 0.32, 0.08, -0.45, 2.45, 2.32, sGlass),
    box(0.08, 0.4, 0.6, 1.62, 2.45, 3.6, sGlass),
    box(0.08, 0.4, 0.6, -1.62, 2.45, 3.6, sGlass),
    cyl(0.5, 0.5, 0.08, 0, 3.45, 3.5, [0.45, 0.32, 0.18], Math.PI / 2, 0, 0, 8),
    box(1.4, 0.12, 2.2, 0, 1.48, 5.4, sTarp),
  ];
  hullDetail(sBparts, false, sRust, sDark, sGlass);
  const sF = mergeGeometries(sFparts);
  const sB = mergeGeometries(sBparts);
  // glowing belly weak point: an emissive panel facing down under the keel (only visible from underwater)
  const panelGeo = new THREE.PlaneGeometry(2.2, 4.2).rotateX(Math.PI / 2).translate(0, BOAT_KEEL - 0.04, 0.3);
  const panelMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true });
  const panels = inst(panelGeo, panelMat, n);
  return {
    pF: inst(pF, mat, n), pB: inst(pB, mat, n), sF: inst(sF, mat, n), sB: inst(sB, mat, n), panels,
  };
}

// ---------------------------------------------------------------- LETHE rim turret (round 4: stronger silhouette)
// dark gunmetal housing with light edge trims, a wall bracket/backplate and a big red sensor eye; nose along -Z
export function buildTurretGeo() {
  const dark = [0.11, 0.11, 0.12], mid = [0.2, 0.2, 0.21], trim = [0.86, 0.8, 0.7], red = [1.0, 0.06, 0.04];
  return mergeGeometries([
    colored(tr(new THREE.CylinderGeometry(1.7, 2.1, 1.0, 8), 0, -0.1, 0), mid),
    colored(tr(new THREE.CylinderGeometry(2.15, 2.15, 0.16, 8), 0, 0.42, 0), trim),
    colored(tr(new THREE.BoxGeometry(2.9, 1.6, 3.2), 0, 1.25, 0.2), dark),
    colored(tr(new THREE.BoxGeometry(2.4, 0.9, 1.4), 0, 1.25, -1.8, -0.35), dark),
    colored(tr(new THREE.BoxGeometry(3.0, 0.14, 3.3), 0, 2.08, 0.2), trim),
    colored(tr(new THREE.BoxGeometry(0.14, 1.66, 3.3), 1.5, 1.25, 0.2), trim),
    colored(tr(new THREE.BoxGeometry(0.14, 1.66, 3.3), -1.5, 1.25, 0.2), trim),
    colored(tr(new THREE.BoxGeometry(2.2, 0.5, 0.9), 0, 2.4, 1.0), mid),
    colored(tr(new THREE.BoxGeometry(2.9, 0.22, 1.0), 0, 1.95, 1.3), [0.75, 0.1, 0.06]),
    colored(tr(new THREE.CylinderGeometry(0.2, 0.26, 4.2, 8), 0.6, 1.0, -3.0, Math.PI / 2), dark),
    colored(tr(new THREE.CylinderGeometry(0.2, 0.26, 4.2, 8), -0.6, 1.0, -3.0, Math.PI / 2), dark),
    colored(tr(new THREE.CylinderGeometry(0.3, 0.3, 0.6, 8), 0.6, 1.0, -5.0, Math.PI / 2), trim),
    colored(tr(new THREE.CylinderGeometry(0.3, 0.3, 0.6, 8), -0.6, 1.0, -5.0, Math.PI / 2), trim),
    colored(tr(new THREE.CylinderGeometry(0.62, 0.62, 0.3, 12), 0, 1.4, -2.5, Math.PI / 2), trim),
    colored(tr(new THREE.SphereGeometry(0.5, 12, 8), 0, 1.4, -2.55), red),
  ]);
}
// static wall bracket (path-aligned): backplate against the rock + struts; x toward the canyon centre
export function buildTurretMountGeo() {
  const plate = [0.09, 0.09, 0.1], trim = [0.7, 0.62, 0.5];
  return mergeGeometries([
    colored(tr(new THREE.BoxGeometry(0.5, 5.2, 6.2), -1.6, 0.3, 0), plate),
    colored(tr(new THREE.BoxGeometry(0.56, 0.18, 6.3), -1.6, 2.9, 0), trim),
    colored(tr(new THREE.BoxGeometry(2.4, 0.5, 0.6), -0.4, -0.9, 2.0, 0, 0, 0.5), plate),
    colored(tr(new THREE.BoxGeometry(2.4, 0.5, 0.6), -0.4, -0.9, -2.0, 0, 0, 0.5), plate),
    colored(tr(new THREE.BoxGeometry(4.2, 0.4, 4.2), 0, -0.75, 0), plate),
  ]);
}
