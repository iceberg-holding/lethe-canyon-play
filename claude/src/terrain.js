// Builds the canyon chunks (walls, riverbed, rocks, arches, settlements, set dressing), river
// surface, foam, light shafts, force-field vaults and the sky. Everything static is merged per chunk.
import * as THREE from 'three';
import { clamp, lerp, smoothstep, noise1, noise2, hash2, rng, sanitizeNormals } from './util.js';
import {
  S0, S_END, PAD_A, PAD_B, PAD_TOP, frame, toWorld, wallLat, riverHalf, rimH, basinF, bankY,
  ARCHES, ROCKS, ZONES, BEACONS, MASTS, TURRETS, DRESS, WRECK, TRIBS, archBottom, archTop,
} from './world.js';
import { rockTextures } from './textures.js';

const SEC = 6;              // metres between cross sections
const CH_SEC = 40;          // sections per chunk (240 m)
export const CHUNK_LEN = SEC * CH_SEC;

// ---------------------------------------------------------------- global height haze
// Patch three's fog so every built-in material also gets a low-lying warm haze layer
// (denser near the river, thinning with altitude). Disabled automatically underwater (dense fog).
THREE.ShaderChunk.fog_pars_vertex = '#ifdef USE_FOG\n varying float vFogDepth; varying float vFogWY;\n#endif';
THREE.ShaderChunk.fog_vertex = '#ifdef USE_FOG\n vFogDepth = - mvPosition.z; vFogWY = cameraPosition.y + (vec4(mvPosition.xyz, 0.0) * viewMatrix).y;\n#endif';
THREE.ShaderChunk.fog_pars_fragment = '#ifdef USE_FOG\n uniform vec3 fogColor; varying float vFogDepth; varying float vFogWY;\n #ifdef FOG_EXP2\n uniform float fogDensity;\n #else\n uniform float fogNear; uniform float fogFar;\n #endif\n#endif';
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
 #ifdef FOG_EXP2
  float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  float hz = step(fogDensity, 0.01) * (1.0 - exp(-vFogDepth * 0.0042)) * exp(-max(vFogWY, 0.0) * 0.03) * 0.45;
  fogFactor = 1.0 - (1.0 - fogFactor) * (1.0 - hz);
 #else
  float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
 #endif
 gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

// --------------------------------------------------------------- geometry builder
class Builder {
  constructor() { this.p = []; this.c = []; this.uv = []; this.ix = []; }
  get n() { return this.p.length / 3; }
  v(x, y, z, r, g, b, u, w) {
    this.p.push(x, y, z); this.c.push(r, g, b); this.uv.push(u, w);
    return this.n - 1;
  }
  tri(a, b, c) { this.ix.push(a, b, c); }
  // append a three.js geometry transformed by matrix, coloured by fn(worldPos) or [r,g,b]
  geo(g, m, col, uvScale = 1) {
    const base = this.n, pos = g.attributes.position, uv = g.attributes.uv;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      const c = typeof col === 'function' ? col(v) : col;
      this.v(v.x, v.y, v.z, c[0], c[1], c[2], uv ? uv.getX(i) * uvScale : 0, uv ? uv.getY(i) * uvScale : 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.ix.push(base + g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) this.ix.push(base + i);
  }
  build(flat = false) {
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.ix);
    if (flat) g = g.toNonIndexed();
    g.computeVertexNormals();
    return sanitizeNormals(g);
  }
}

// --------------------------------------------------------------- colours
const STRATA = [
  [0.52, 0.21, 0.12], [0.66, 0.31, 0.17], [0.76, 0.47, 0.27], [0.82, 0.54, 0.40],
  [0.58, 0.25, 0.15], [0.86, 0.63, 0.47], [0.70, 0.37, 0.21], [0.62, 0.28, 0.18],
];
const _c = [0, 0, 0];
function rockColor(s, y, side) {
  if (y < -0.4) {
    const t = clamp(-y / 11, 0, 1);
    _c[0] = lerp(0.40, 0.14, t); _c[1] = lerp(0.30, 0.24, t); _c[2] = lerp(0.22, 0.21, t);
    return _c;
  }
  const yy = y + 5 * noise1(s * 0.004 + side * 3.1);
  const band = Math.floor(yy / 7);
  const c = STRATA[(hash2(band, 7) * STRATA.length) | 0];
  const j = 0.9 + 0.12 * noise2(s * 0.05, y * 0.15);
  const ao = lerp(0.58, 1.04, smoothstep(2, 50, y));
  const wet = y < 3.2 ? 0.6 : 1;
  // greenish-grey tint of the half-terraformed lower banks
  const moss = y < 9 && y > 0.5 ? clamp(noise2(s * 0.03 + side * 7, y * 0.2) * 1.6, 0, 1) * 0.35 : 0;
  const k = j * ao * wet;
  _c[0] = lerp(c[0] * k, 0.30, moss); _c[1] = lerp(c[1] * k, 0.34, moss); _c[2] = lerp(c[2] * k, 0.24, moss);
  return _c;
}
function dustLedges(g) {
  const n = g.attributes.normal, c = g.attributes.color, p = g.attributes.position;
  for (let i = 0; i < n.count; i++) {
    if (p.getY(i) < 3.5) continue;
    const t = smoothstep(0.62, 0.92, n.getY(i)) * 0.7;
    if (t <= 0) continue;
    c.setXYZ(i, lerp(c.getX(i), 0.86, t), lerp(c.getY(i), 0.56, t), lerp(c.getZ(i), 0.38, t));
  }
}

// --------------------------------------------------------------- y levels of a wall
const LEVELS = [];
for (let k = 0; k < 7; k++) for (const o of [0, 4, 8, 12, 16.5, 19.5, 22]) LEVELS.push(k * 24 + o);
LEVELS[0] = 3;

const F = { x: 0, z: 0, th: 0, tx: 0, tz: 0, rx: 0, rz: 0 };
function sideProfile(s, side, out) {
  out.length = 0;
  const wr = riverHalf(s), H = rimH(s);
  const w3 = wallLat(s, 3, side);
  out.push([0.45 * wr, -10.5], [0.8 * wr, -7], [0.95 * wr, -2.5], [wr, 0.4], [(wr + w3) * 0.5, 1.8]);
  let rimLat = 0;
  for (const L of LEVELS) {
    const y = Math.min(L, H);
    const l = wallLat(s, y, side);
    out.push([l, y]);
    rimLat = l;
  }
  out.push([rimLat + 30, H + 3], [rimLat + 230, H + 22]);
  return out;
}

function addTerrain(B, i0, i1) {
  const pl = [], pr = [];
  let cols = 0;
  const start = B.n;
  for (let i = i0; i <= i1; i++) {
    const s = S0 + i * SEC;
    frame(s, F);
    sideProfile(s, -1, pl); sideProfile(s, 1, pr);
    const row = [];
    for (let k = pl.length - 1; k >= 0; k--) row.push([-pl[k][0], pl[k][1], -1]);
    row.push([0, -11, 0]);
    for (const p of pr) row.push([p[0], p[1], 1]);
    cols = row.length;
    for (const [lat, y, side] of row) {
      const c = rockColor(s, y, side);
      const u = s / 36;
      const v = y > 2 ? y / 36 : lat / 36;
      B.v(F.x + F.rx * lat, y, F.z + F.rz * lat, c[0], c[1], c[2], u, v);
    }
  }
  for (let i = 0; i < i1 - i0; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = start + i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      B.tri(a, b, c); B.tri(b, d, c);
    }
  }
}

function addRock(B, r) {
  const seg = 12, base = new THREE.Vector3();
  toWorld(r.s, r.lat, 0, base);
  const y0 = -11, y1 = r.h, rings = r.boulder ? 7 : Math.max(7, Math.round((y1 - y0) / 4));
  const start = B.n;
  for (let k = 0; k <= rings; k++) {
    const t = k / rings, y = lerp(y0, y1, t);
    const rad = r.boulder ? r.r * (1 - Math.pow(Math.max(0, (y) / r.h), 2.2) * 0.75) : r.r * (1 - 0.18 * t);
    const step = r.boulder ? 0 : 0.12 * smoothstep(0.6, 1, (y / 9) % 1);
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const n = 1 + 0.26 * noise2(Math.cos(a) * 1.5 + r.seed, y * 0.07 + Math.sin(a) * 1.5) + 0.08 * noise2(a * 3 + r.seed, y * 0.4) - step;
      const x = base.x + Math.cos(a) * rad * n, z = base.z + Math.sin(a) * rad * n;
      const c = rockColor(r.s + j * 3, y, 1);
      B.v(x, y, z, c[0], c[1], c[2], (j / seg) * r.r * 0.17, y / 36);
    }
  }
  for (let k = 0; k < rings; k++) for (let j = 0; j < seg; j++) {
    const a = start + k * seg + j, b = start + k * seg + ((j + 1) % seg), c = a + seg, d = b + seg;
    B.tri(a, c, b); B.tri(b, c, d);
  }
  const top = B.v(base.x, y1 + r.r * 0.25, base.z, 0.84, 0.56, 0.4, 0, 0);
  const tr = start + rings * seg;
  for (let j = 0; j < seg; j++) B.tri(tr + j, top, tr + ((j + 1) % seg));
}

function addArch(B, a) {
  const w = a.w + 10, steps = Math.ceil((2 * w) / 2.5);
  const start = B.n, ring = 10;
  for (let i = 0; i <= steps; i++) {
    const lat = -w + (2 * w * i) / steps;
    const bot = Math.max(archBottom(a, lat), -12), top = archTop(a, lat);
    const ht = a.ht * (1 + 0.5 * Math.pow(Math.abs(lat) / w, 3));
    const mid = (bot + top) / 2;
    const pts = [[-ht, bot + 1.5], [-ht * 0.6, bot], [ht * 0.6, bot], [ht, bot + 1.5], [ht * 1.05, mid], [ht, top - 1.5], [ht * 0.6, top], [-ht * 0.6, top], [-ht, top - 1.5], [-ht * 1.05, mid]];
    for (let k = 0; k < ring; k++) {
      const [ds, y] = pts[k];
      const n = noise2(lat * 0.12 + k * 3.1, a.s * 0.01) + 0.4 * noise2(lat * 0.5 + k, a.s);
      const yy = y + n * 1.2 * (k === 1 || k === 2 ? 0.4 : 1);
      frame(a.s + ds * (1 + 0.15 * n), F);
      const c = rockColor(a.s, yy, 1);
      B.v(F.x + F.rx * lat, yy, F.z + F.rz * lat, c[0], c[1], c[2], lat / 36, (yy + ds) / 36);
    }
  }
  for (let i = 0; i < steps; i++) for (let k = 0; k < ring; k++) {
    const k2 = (k + 1) % ring;
    const p = start + i * ring + k, b = start + i * ring + k2, c = p + ring, d = b + ring;
    B.tri(p, b, c); B.tri(b, d, c);
  }
}

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _T = new THREE.Vector3(), _R = new THREE.Vector3(), _U = new THREE.Vector3(0, 1, 0), _P = new THREE.Vector3();
const _E = new THREE.Euler();
function basisAt(s, lat, y, yaw = 0, pitch = 0, roll = 0) {
  frame(s, F);
  _R.set(F.rx, 0, F.rz); _T.set(-F.tx, 0, -F.tz);
  _m.makeBasis(_R, _U, _T);
  if (yaw || pitch || roll) _m.multiply(_m2.makeRotationFromEuler(_E.set(pitch, yaw, roll, 'YXZ')));
  toWorld(s, lat, y, _P);
  _m.setPosition(_P);
  return _m;
}

// static glow lights (settlement lamps etc.): {p:Vector3, c:[r,g,b], size, blink}
export const STATIC_GLOWS = [];
// steam / smoke vents near the settlements: {p:Vector3, k: 0 steam | 1 smoke}
export const VENTS = [];

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  dome: new THREE.SphereGeometry(1, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 16),
  ring: new THREE.CylinderGeometry(1, 1, 1, 32, 1, true),
  cyl8: new THREE.CylinderGeometry(1, 1, 1, 8),
  cyl6: new THREE.CylinderGeometry(1, 1, 1, 6),
  cone: new THREE.ConeGeometry(1, 1, 10),
  tri: new THREE.CylinderGeometry(1, 1, 1, 3),
  ico: new THREE.IcosahedronGeometry(1, 1),
  ico0: new THREE.IcosahedronGeometry(1, 0),
};
// lumpy boulder variants
const BOULDERS = [0, 1, 2, 3].map((k) => {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 1 + 0.28 * noise2(x * 1.7 + k * 9, y * 1.7 + z * 1.3) + 0.1 * noise2(z * 4 + k, x * 4);
    p.setXYZ(i, x * n, y * n * 0.72, z * n);
  }
  return g;
});
function place(B, geo, s, lat, y, sx, sy, sz, col, yaw = 0, pitch = 0, roll = 0) {
  const m = basisAt(s, lat, y, yaw, pitch, roll).clone().multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
  B.geo(geo, m, col);
}
function glowAt(s, lat, y, c, size, blink) {
  const p = new THREE.Vector3(); toWorld(s, lat, y, p);
  STATIC_GLOWS.push({ p, c, size, blink });
}

// ---------------------------------------------------------------- settlements
function addSettlement(P, E, sPad, sMin, sMax, which) {
  const R = rng(which === 'A' ? 11 : 22);
  const metal = [0.42, 0.42, 0.43], pale = [0.86, 0.84, 0.8], dark = [0.2, 0.2, 0.22];
  if (sPad >= sMin && sPad < sMax) {
    place(P, GEO.cyl, sPad, 0, PAD_TOP / 2 - 2, 13, PAD_TOP + 4, 13, [0.32, 0.32, 0.33]);
    place(P, GEO.cyl, sPad, 0, PAD_TOP + 0.05, 10, 0.1, 10, which === 'A' ? [0.75, 0.55, 0.18] : [0.2, 0.55, 0.35]);
    place(P, GEO.cyl, sPad, 0, PAD_TOP + 0.12, 8.6, 0.1, 8.6, [0.26, 0.26, 0.27]);
    place(P, GEO.box, sPad, 0, PAD_TOP + 0.16, 1.2, 0.05, 9, pale);
    place(P, GEO.box, sPad, 0, PAD_TOP + 0.16, 9, 0.05, 1.2, pale);
    for (const sd of [-1, 1]) {
      place(P, GEO.box, sPad, sd * 24, 1.2, 22, 1.0, 4, [0.33, 0.32, 0.31]);
      for (let k = 0; k < 4; k++) place(P, GEO.cyl8, sPad + 1.6, sd * (16 + k * 5), 2.4, 0.08, 2.2, 0.08, dark);
    }
    const padCol = which === 'A' ? [1.6, 0.9, 0.3] : [0.4, 1.6, 0.7];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      glowAt(sPad + Math.cos(a) * 12.2, Math.sin(a) * 12.2, PAD_TOP + 0.4, padCol, 1.7, k * 0.09 + (which === 'B' ? 1 : 0));
    }
    // approach light row on the water
    for (let k = 1; k < 9; k++) glowAt(sPad - 18 - k * 14, 0, 1.2, padCol, 2.2, 10 + k * 0.4);
  }
  for (let s = Math.ceil(sMin / 22) * 22; s < sMax; s += 22) {
    for (const side of [-1, 1]) {
      const hR = hash2(Math.round(s), side + (which === 'A' ? 0 : 7));
      if (hR < 0.18) continue;
      const wr = riverHalf(s), wb = wallLat(s, 3, side);
      if (wb - wr < 26) continue;
      const lat = side * lerp(wr + 12, wb - 14, hash2(Math.round(s), side + 3));
      const r = 6 + hR * 9;
      const kind = hash2(Math.round(s) + 5, side);
      if (kind < 0.42) {
        // habitat dome: banded shell, lit window ring, airlock, light
        place(P, GEO.dome, s, lat, 1.8, r, r * 0.8, r, (v) => {
          const band = Math.abs(((v.y - 1.8) / (r * 0.8)) - 0.55) < 0.06;
          return band ? [0.16, 0.30, 0.32] : pale;
        });
        place(P, GEO.cyl, s, lat, 1.6, r * 1.05, 0.8, r * 1.05, [0.45, 0.43, 0.4]);
        place(E, GEO.ring, s, lat, 2.7, r * 1.004, 0.55, r * 1.004, (v) => (Math.sin(Math.atan2(v.x, v.z) * 26) > 0.1 ? [1.9, 1.3, 0.7] : [0.25, 0.18, 0.12]));
        place(P, GEO.box, s, lat - side * r, 2.6, 3, 3, 4, metal);
        glowAt(s, lat, 2 + r * 0.8, [1.4, 0.3, 0.15], 1.4, hR * 6);
        glowAt(s - r * 0.9, lat, 3, [1, 0.82, 0.55], 2.6, -1);
      } else if (kind < 0.6) {
        // antenna mast with dish + red light
        const h = 18 + hR * 22;
        place(P, GEO.cyl6, s, lat, 1.8 + h / 2, 0.5, h, 0.5, metal);
        for (let k = 1; k < 4; k++) place(P, GEO.cyl6, s, lat, 1.8 + h * k / 4, 2.4, 0.15, 2.4, dark);
        place(P, GEO.cone, s, lat - side * 1.5, 1.8 + h * 0.7, 2.6, 1.2, 2.6, pale, 0, 0, side * 1.1);
        glowAt(s, lat, 2.4 + h, [1.6, 0.2, 0.1], 2.4, hR * 6);
      } else if (kind < 0.75) {
        // crane: tower + boom + hook block
        const h = 20 + hR * 12, yaw = hR * 6;
        place(P, GEO.box, s, lat, 1.8 + h / 2, 1.2, h, 1.2, [0.78, 0.55, 0.18]);
        place(P, GEO.box, s, lat, 1.8 + h, 1, 1, 18, [0.78, 0.55, 0.18], yaw);
        place(P, GEO.box, s, lat, 1.8 + h + 0.8, 2, 1.6, 2, dark, yaw);
        glowAt(s, lat, 2.8 + h, [1.6, 0.2, 0.1], 2, hR * 6);
      } else {
        // water tanks: the cargo
        place(P, GEO.cyl, s, lat, 1.8 + r * 0.45, r * 0.55, r * 0.9, r * 0.55, (v) => (Math.abs(v.y - 1.8 - r * 0.6) < 0.6 ? [0.2, 0.62, 0.66] : [0.78, 0.78, 0.76]));
        place(P, GEO.dome, s, lat, 1.8 + r * 0.9, r * 0.55, r * 0.18, r * 0.55, pale);
      }
    }
  }
  if (which === 'B') {
    // desalination / condenser plant on the right bank beyond the pad, with steam
    for (let k = 0; k < 5; k++) {
      const s = PAD_B + 60 + k * 16;
      if (s < sMin || s >= sMax) continue;
      const lat = riverHalf(s) + 14;
      place(P, GEO.cyl, s, lat, 10, 5, 16, 5, pale);
      place(P, GEO.cyl, s, lat, 18.4, 4.2, 1, 4.2, metal);
      place(E, GEO.ring, s, lat, 6, 5.03, 0.4, 5.03, [0.3, 1.6, 1.5]);
      place(P, GEO.cyl8, s + 8, lat - 5, 4, 0.7, 0.7, 16, metal, 0, Math.PI / 2);
      const p = new THREE.Vector3(); toWorld(s, lat, 19, p); VENTS.push({ p, k: 0 });
    }
    // tall beacon tower — visible from far up the canyon
    const s = PAD_B - 40, lat = -(riverHalf(s) + 10);
    if (s >= sMin && s < sMax) {
      place(P, GEO.cyl6, s, lat, 24, 1.4, 46, 1.4, metal);
      place(P, GEO.box, s, lat, 46, 6, 3, 6, pale);
      place(E, GEO.box, s, lat, 46, 6.1, 0.6, 6.1, [2.2, 1.6, 0.8]);
      glowAt(s, lat, 49, [0.5, 2, 1], 10, 0.5);
      glowAt(s, lat, 47, [2, 1.4, 0.7], 14, -1);
    }
  }
  if (which === 'A') {
    const s = PAD_A + 120, lat = riverHalf(s) + 12;
    if (s >= sMin && s < sMax) { const p = new THREE.Vector3(); toWorld(s, lat, 8, p); VENTS.push({ p, k: 1 }); place(P, GEO.cyl8, s, lat, 4, 1.5, 8, 1.5, dark); }
  }
}

// ---------------------------------------------------------------- set dressing
function addScree(D, sA, sB, R) {
  for (let s = sA; s < sB; s += 2.2 + R() * 3.5) {
    if (basinF(s) > 0.4) continue;
    for (const side of [-1, 1]) {
      if (R() < 0.35) continue;
      const wb = wallLat(s, 3, side), wr = riverHalf(s);
      const t = Math.pow(R(), 0.6);
      const lat = side * lerp(wr + 1.5, wb - 0.4, t);
      const sz = lerp(0.5, 2.4, R() * R()) * (t > 0.7 ? 1.3 : 0.8);
      const c = rockColor(s, 6 + R() * 30, side);
      const k = 0.7 + 0.3 * R();
      place(D, BOULDERS[(R() * 4) | 0], s, lat, bankY(s, lat) + sz * 0.25, sz * (0.8 + R() * 0.6), sz, sz * (0.8 + R() * 0.6), [c[0] * k, c[1] * k, c[2] * k], R() * 6);
    }
  }
  // occasional big fallen blocks at the wall foot
  for (let s = sA + R() * 60; s < sB; s += 45 + R() * 70) {
    if (basinF(s) > 0.4) continue;
    const side = R() < 0.5 ? -1 : 1;
    const lat = side * (wallLat(s, 3, side) - 1.5);
    const sz = 3 + R() * 3;
    const c = rockColor(s, 30, side);
    place(D, BOULDERS[(R() * 4) | 0], s, lat, 1.5, sz * 1.3, sz, sz, c.slice(), R() * 6, R() * 0.4);
  }
}
function addLichen(P, sA, sB, R) {
  for (let s = sA; s < sB; s += 3 + R() * 7) {
    const side = R() < 0.5 ? -1 : 1;
    const wr = riverHalf(s), wb = wallLat(s, 3, side);
    const onLedge = R() < 0.35;
    const g = 0.75 + R() * 0.4;
    const col = R() < 0.3 ? [0.22 * g, 0.27 * g, 0.16 * g] : [0.2 * g, 0.23 * g, 0.19 * g];
    if (onLedge) {
      const y = 20 + 24 * ((R() * 3) | 0) + R() * 3;
      const lat = side * (wallLat(s, y, side) - 0.3);
      place(P, BOULDERS[(R() * 4) | 0], s, lat, y - 0.5, 1.5 + R() * 2.5, 0.35, 1.5 + R() * 2.5, col, R() * 6);
    } else {
      const lat = side * lerp(wr + 0.5, wb - 0.5, R());
      place(P, BOULDERS[(R() * 4) | 0], s, lat, bankY(s, lat) - 0.05, 1.2 + R() * 2.8, 0.3, 1.2 + R() * 2.8, col, R() * 6);
    }
  }
}
function pipeLat(s, y) {
  let m = 1e9;
  for (let k = -9; k <= 9; k += 3) m = Math.min(m, wallLat(s + k, y, -1));
  return -(m - 1.9);
}
function addPipe(P, sA, sB) {
  const pp = DRESS.pipe, y = pp.y;
  const a = Math.max(sA, pp.s0), b = Math.min(sB, pp.s1);
  if (a >= b) return;
  const pipeCol = [0.62, 0.6, 0.56], bandCol = [0.7, 0.48, 0.16];
  const q0 = new THREE.Vector3(), q1 = new THREE.Vector3();
  for (let s = Math.floor(a / 6) * 6; s < b; s += 6) {
    toWorld(s, pipeLat(s, y), y, q0); toWorld(s + 6, pipeLat(s + 6, y), y, q1);
    const len = q0.distanceTo(q1);
    const m = new THREE.Matrix4().lookAt(q0, q1, _U).setPosition(q0.clone().add(q1).multiplyScalar(0.5));
    m.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)).multiply(new THREE.Matrix4().makeScale(0.65, len + 0.05, 0.65));
    P.geo(GEO.cyl8, m, pipeCol);
    if (s % 12 === 0) {
      const lat = pipeLat(s, y);
      const by = Math.max(0.5, bankY(s, lat));
      place(P, GEO.box, s, lat, (y + by) / 2 - 0.4, 0.3, y - by, 0.3, [0.3, 0.3, 0.32]);
      place(P, GEO.box, s, lat, y - 0.7, 1.6, 0.25, 0.4, [0.3, 0.3, 0.32]);
      place(P, GEO.cyl8, s, lat, y, 0.75, 0.5, 0.75, bandCol, 0, Math.PI / 2);
    }
  }
}
function addCable(P, c) {
  const n = 14, pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s = lerp(c.s, c.s2, t);
    const L = wallLat(s, c.y, -1), Rt = wallLat(s, c.y, 1);
    const lat = lerp(-L + 1, Rt - 1, t);
    pts.push(toWorld(s, lat, c.y - c.sag * 4 * t * (1 - t), new THREE.Vector3()));
  }
  for (let i = 0; i < n; i++) {
    const q0 = pts[i], q1 = pts[i + 1];
    const m = new THREE.Matrix4().lookAt(q0, q1, _U).setPosition(q0.clone().add(q1).multiplyScalar(0.5));
    m.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)).multiply(new THREE.Matrix4().makeScale(0.12, q0.distanceTo(q1), 0.12));
    P.geo(GEO.cyl6, m, [0.12, 0.12, 0.13]);
  }
  for (const i of [4, 7, 10]) STATIC_GLOWS.push({ p: pts[i].clone().add(new THREE.Vector3(0, -0.4, 0)), c: [1.5, 0.25, 0.12], size: 2.4, blink: i * 0.7 });
}
function addRuin(P, r) {
  const s = r.s, side = r.side;
  const wr = riverHalf(s), wb = wallLat(s, 3, side);
  const lat = side * Math.min(wb - 4, wr + 4);
  const rust = [0.46, 0.33, 0.24], conc = [0.62, 0.56, 0.5], dark = [0.22, 0.2, 0.2];
  if (r.kind === 'tower') {
    // ruined terraforming tower: tapering lattice of boxes with a broken top
    const h = r.h;
    for (const dx of [-1.6, 1.6]) for (const dz of [-1.6, 1.6]) place(P, GEO.box, s + dz, lat + dx, h / 2, 0.45, h, 0.45, rust, 0, dz * 0.01, dx * 0.012);
    for (let y = 4; y < h - 2; y += 4.5) place(P, GEO.box, s, lat, y, 3.8, 0.3, 3.8, dark, r.seed * 3);
    place(P, GEO.box, s + 1.2, lat, h + 1.5, 4.5, 3.2, 3.5, conc, 0.3, 0.25, 0.35);
    glowAt(s, lat, h + 3.4, [1.4, 0.25, 0.1], 2.2, r.seed * 9);
  } else {
    // atmospheric condenser: squat cylinder stack with fins
    place(P, GEO.cyl, s, lat, 4, 4.2, 8, 4.2, conc);
    place(P, GEO.cyl, s, lat, 9, 3.4, 2, 3.4, dark);
    for (let k = 0; k < 6; k++) place(P, GEO.box, s, lat, 4.5, 9.6, 6, 0.25, rust, (k / 6) * Math.PI);
    place(P, GEO.cyl8, s, lat, 11.5, 1, 3, 1, rust, 0, 0.3);
    glowAt(s, lat, 13.5, [0.4, 1.4, 1.3], 2.4, r.seed * 9);
  }
}
function addSign(P, E, g) {
  const s = g.s, side = g.side;
  const lat = side * (riverHalf(s) + 2.5), by = Math.max(0.5, bankY(s, lat));
  place(P, GEO.box, s, lat, by + 2.5, 0.25, 5, 0.25, [0.25, 0.25, 0.27]);
  // red triangular LETHE warning panel facing the oncoming ship
  place(P, GEO.tri, s, lat, by + 5.6, 1.8, 0.15, 1.8, [0.75, 0.12, 0.08], 0, Math.PI / 2, 0);
  place(P, GEO.tri, s - 0.09, lat, by + 5.55, 1.25, 0.15, 1.25, [0.9, 0.86, 0.78], 0, Math.PI / 2, 0);
  place(E, GEO.box, s - 0.2, lat, by + 5.45, 0.18, 0.75, 0.04, [2, 0.25, 0.12]);
  glowAt(s, lat, by + 7.2, [1.6, 0.2, 0.1], 1.8, s * 0.1);
}
function addMarker(P, g) {
  const s = g.s, side = g.side;
  const lat = side * (riverHalf(s) + 1.2), by = Math.max(0.4, bankY(s, lat));
  for (let k = 0; k < 6; k++) place(P, GEO.cyl6, s, lat, by + 0.4 + k * 0.7, 0.2, 0.7, 0.2, k % 2 ? [0.12, 0.12, 0.12] : [0.85, 0.55, 0.12]);
  glowAt(s, lat, by + 4.6, [1.6, 0.8, 0.2], 1.6, s * 0.13);
}
function addWreck(P, D) {
  const s = WRECK.s, lat = WRECK.lat, side = WRECK.side;
  const hull = [0.32, 0.32, 0.34], dark = [0.16, 0.16, 0.17], burn = [0.1, 0.08, 0.07];
  // nose-down courier: hull, snapped wing, one pod torn off
  place(P, GEO.cyl8, s, lat, 0.6, 1.8, 13, 1.6, (v) => (v.y < 0.4 ? burn : hull), 0.4 * side, 0.32, 0.5 * side);
  place(P, GEO.cone, s - 7, lat + side * 2.6, -0.2, 1.6, 3.5, 1.6, hull, 0.4 * side, -1.2, 0.5 * side);
  place(P, GEO.box, s + 2, lat - side * 4.5, 1.2, 6, 0.4, 3.5, hull, 0.8, 0.1, -0.5 * side);
  place(P, GEO.cyl8, s + 5, lat + side * 5.5, 0.9, 1.1, 4.8, 1.1, dark, 0.2, Math.PI / 2 - 0.2, 0.3);
  place(P, GEO.box, s + 1, lat + side * 0.4, 2.2, 0.15, 1.8, 3.8, [0.7, 0.48, 0.16], 0.4 * side, 0.3, 0.5 * side);
  for (let k = 0; k < 6; k++) place(D, BOULDERS[k % 4], s - 6 + k * 3, lat + side * (k % 2 ? 3 : -2), 0, 0.6 + (k % 3) * 0.4, 0.5, 0.8, dark, k);
}
function addScorchedTurret(P, g = DRESS.scorched) {
  const s = g.s, side = g.side, y = 34;
  const lat = side * (wallLat(s, y, side) - 2.2);
  const burn = [0.13, 0.11, 0.1];
  place(P, GEO.box, s, lat + side * 0.8, y - 0.8, 6, 1.6, 6, rockColor(s, y, side).slice());
  place(P, GEO.cyl8, s, lat, y + 0.8, 1.8, 1.6, 1.8, burn);
  place(P, GEO.box, s - 1, lat - side * 1.2, y + 1.6, 1.2, 1, 2.2, burn, 0.7, 0.5, side * 0.9);
  place(P, GEO.cyl6, s - 3, lat - side * 2.5, y + 0.5, 0.25, 4.5, 0.25, burn, 0.2, 1.4, 0.6);
}
function addOldMast(P) {
  const g = DRESS.oldMast, s = g.s, side = g.side, y = 18;
  const lat = side * (wallLat(s, y, side) - 0.8);
  const col = [0.45, 0.47, 0.5];
  place(P, GEO.box, s, lat + side * 0.6, y - 0.6, 5, 1.2, 5, [0.3, 0.3, 0.32]);
  place(P, GEO.cyl6, s, lat - side * 1.5, y + 2.3, 0.5, 5, 0.5, col, 0, 0, side * 0.5);
  // the snapped top lying on the bank below
  const bl = side * (riverHalf(s) + 3.5);
  place(P, GEO.cyl6, s + 3, bl, Math.max(1, bankY(s, bl)) + 0.4, 0.35, 7, 0.35, col, 0.6, 0, Math.PI / 2 - 0.1);
  place(P, GEO.cyl6, s + 5.5, bl, Math.max(1, bankY(s, bl)) + 0.6, 1.1, 0.35, 1.1, [0.25, 0.5, 0.55], 0.6, 0, Math.PI / 2 - 0.1);
}

// --------------------------------------------------------------- materials
export const terrainTex = {};
export function makeTerrainMaterial() {
  const { map, normalMap } = rockTextures(512);
  terrainTex.map = map; terrainTex.normalMap = normalMap;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map, normalMap, normalScale: new THREE.Vector2(1.3, 1.3) });
  return mat;
}
export const propMat = new THREE.MeshLambertMaterial({ vertexColors: true });
export const emissiveMat = new THREE.MeshBasicMaterial({ vertexColors: true });

// --------------------------------------------------------------- chunks
function mk(B, mat, flat) {
  if (!B.ix.length) return null;
  const g = B.build(flat);
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, mat);
  m.matrixAutoUpdate = false;
  return m;
}
export function buildChunks(scene, mat) {
  const totalSec = Math.floor((S_END - S0) / SEC);
  const chunks = [];
  const R = rng(4242);
  for (let c0 = 0; c0 < totalSec; c0 += CH_SEC) {
    const c1 = Math.min(c0 + CH_SEC, totalSec);
    const sA = S0 + c0 * SEC, sB = S0 + c1 * SEC;
    const B = new Builder(), D = new Builder(), P = new Builder(), E = new Builder(), S = new Builder();
    addTerrain(B, c0, c1);
    for (const r of ROCKS) if (r.s >= sA && r.s < sB && !r.wreck) addRock(B, r);
    for (const a of ARCHES) if (a.s >= sA && a.s < sB) addArch(B, a);
    for (const b of BEACONS) if (b.s >= sA && b.s < sB) {
      place(B, GEO.box, b.s, b.lat + b.side * 0.5, b.y - 0.7, 6, 1.4, 6, rockColor(b.s, b.y, 1).slice());
    }
    for (const m of MASTS) if (m.s >= sA && m.s < sB) {
      place(S, GEO.box, m.s, m.lat + m.side * 0.6, m.y - 0.6, 5, 1.2, 5, [0.36, 0.36, 0.38]);
      place(S, GEO.box, m.s, m.lat + m.side * 1.4, m.y + 2, 1, 5, 3, [0.3, 0.3, 0.32]);
      place(E, GEO.box, m.s, m.lat + m.side * 0.9, m.y + 2, 0.1, 3.6, 0.3, [0.3, 1.8, 2.0]);
    }
    for (const t of TURRETS) if (t.s >= sA && t.s < sB) {
      place(S, GEO.box, t.s, t.lat + t.side * 1.2, t.y - 1.2, 7, 2.4, 7, [0.3, 0.29, 0.3]);
      place(S, GEO.box, t.s, t.lat + t.side * 3.5, t.y - 5, 2.2, 8, 2.2, [0.24, 0.24, 0.25]);
      place(E, GEO.box, t.s, t.lat - t.side * 2.3, t.y - 1.2, 0.2, 0.3, 6.2, [2.2, 0.25, 0.12]);
    }
    if (sA <= PAD_A + 300 && sB >= -260) addSettlement(S, E, PAD_A, Math.max(sA, -260), Math.min(sB, PAD_A + 300), 'A');
    if (sB >= PAD_B - 300 && sA <= PAD_B + 300) addSettlement(S, E, PAD_B, Math.max(sA, PAD_B - 300), Math.min(sB, PAD_B + 300), 'B');
    // set dressing
    addScree(D, sA, sB, R);
    addLichen(P, sA, sB, R);
    addPipe(P, sA, sB);
    for (const c of DRESS.cables) if (c.s >= sA && c.s < sB) addCable(P, c);
    for (const r of DRESS.ruins) if (r.s >= sA && r.s < sB) addRuin(P, r);
    for (const g of DRESS.signs) if (g.s >= sA && g.s < sB) addSign(P, E, g);
    for (const g of DRESS.markers) if (g.s >= sA && g.s < sB) addMarker(P, g);
    if (WRECK.s >= sA && WRECK.s < sB) addWreck(P, D);
    for (const g of [DRESS.scorched, DRESS.scorched2]) if (g.s >= sA && g.s < sB) addScorchedTurret(P, g);
    if (DRESS.oldMast.s >= sA && DRESS.oldMast.s < sB) addOldMast(P);

    const grp = new THREE.Group();
    grp.matrixAutoUpdate = false;
    grp.userData = { sA, sB };
    const base = mk(B, mat);
    dustLedges(base.geometry);
    base.receiveShadow = true;
    grp.add(base);
    const det = mk(D, mat, false);
    if (det) { det.userData.detail = true; det.receiveShadow = true; grp.add(det); }
    const props = mk(P, propMat, true);
    if (props) { props.userData.detail = true; props.receiveShadow = true; grp.add(props); }
    const st = mk(S, propMat, true);
    if (st) { st.receiveShadow = true; grp.add(st); }
    const em = mk(E, emissiveMat);
    if (em) grp.add(em);
    scene.add(grp);
    chunks.push(grp);
  }
  return chunks;
}

// --------------------------------------------------------------- river surface
const SKY_FN = /* glsl */`
uniform vec3 uSun; uniform vec3 uSun2; uniform vec3 uHor; uniform vec3 uZen;
vec3 skyRefl(vec3 d){
  vec3 col = mix(uHor, uZen, smoothstep(0.0, 0.6, d.y));
  float s1 = max(dot(d, uSun), 0.0);
  col += vec3(1.0, 0.6, 0.35) * pow(s1, 6.0) * 0.25;
  return col;
}`;
const waterVS = /* glsl */`
attribute float aW;
varying vec2 vUv; varying float vW; varying vec3 vWorld;
#include <fog_pars_vertex>
void main(){
  vUv = uv; vW = aW;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const waterFS = /* glsl */`
uniform float uTime; uniform float uGlint;
${SKY_FN}
varying vec2 vUv; varying float vW; varying vec3 vWorld;
#include <fog_pars_fragment>
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
// gradient of a noise octave by finite differences
vec2 vg(vec2 p){ float c = vn(p); return vec2(vn(p + vec2(0.2, 0.0)) - c, vn(p + vec2(0.0, 0.2)) - c) * 5.0; }
void main(){
  float t = uTime;
  vec2 p = vUv;                 // x = lateral metres, y = metres along the canyon
  float dist = length(cameraPosition - vWorld);
  float lod = clamp(dist / 160.0, 0.0, 1.0);
  // flowing waves: three scrolling octaves (flow toward -s), finer ones fade with distance
  vec2 g = vg(vec2(p.x * 0.09, p.y * 0.05 - t * 0.55)) * 0.55;
  g += vg(vec2(p.x * 0.23 + 3.0, p.y * 0.16 - t * 1.5)) * 0.32;
  g += vg(vec2(p.x * 0.7 + 7.0, p.y * 0.45 - t * 3.1)) * 0.2 * (1.0 - lod);
  g += vg(vec2(p.x * 1.9 - p.y * 0.3, p.y * 1.4 - t * 4.0)) * 0.09 * (1.0 - lod);
  vec3 N = normalize(vec3(g.x * 0.32, 1.0, g.y * 0.32));
  vec3 V = normalize(cameraPosition - vWorld);
  float edgeD = vW - abs(p.x);                     // metres from the bank
  float depth = clamp(edgeD / 14.0, 0.0, 1.0);
  vec3 deep = vec3(0.015, 0.26, 0.29), shallow = vec3(0.12, 0.58, 0.54);
  float n1 = vn(vec2(p.x * 0.06, p.y * 0.012 - t * 0.25));
  vec3 col = mix(shallow, deep, depth * 0.8 + 0.2 * n1);
  // subsurface glow on wave flanks facing the light
  col += vec3(0.05, 0.22, 0.18) * clamp(dot(N.xz, normalize(uSun.xz)) * 2.0, 0.0, 1.0) * (0.6 + 0.4 * depth);
  // fresnel reflection: canyon walls low, hazy sky above
  if (gl_FrontFacing) {
    vec3 R = reflect(-V, N);
    vec3 wall = vec3(0.42, 0.2, 0.12) * (0.7 + 0.3 * n1);
    vec3 refl = mix(wall, skyRefl(R), smoothstep(0.12, 0.42, R.y));
    float fres = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col = mix(col, refl, clamp(fres, 0.0, 0.85));
    // sun + mirror-sun glints (HDR -> bloom)
    float sp1 = pow(max(dot(R, uSun), 0.0), 380.0), sp2 = pow(max(dot(R, uSun2), 0.0), 900.0);
    float sparkle = step(0.93, h21(floor(p * vec2(2.2, 1.6) + floor(t * 9.0))));
    col += vec3(1.5, 1.1, 0.7) * (sp1 * 1.3 + sp1 * sparkle * 2.0) * uGlint;
    col += vec3(0.85, 0.95, 1.2) * (sp2 * 2.2 + pow(max(dot(R, uSun2), 0.0), 120.0) * 0.12) * uGlint;
    // flow streaks + bank foam
    float streak = smoothstep(0.62, 0.95, vn(vec2(p.x * 0.8, p.y * 0.02 - t * 1.4)));
    col += vec3(0.08, 0.13, 0.12) * streak;
    float fn = vn(vec2(p.x * 1.3, p.y * 0.5 - t * 2.2)) * 0.6 + vn(vec2(p.x * 3.1, p.y * 1.7 - t * 3.0)) * 0.4;
    float foam = smoothstep(2.6, 0.0, edgeD + fn * 1.6 - 0.6);
    foam = max(foam, smoothstep(0.78, 0.95, fn) * smoothstep(5.0, 1.0, edgeD));
    col = mix(col, vec3(0.9, 0.93, 0.9), foam * 0.85);
  } else {
    // seen from below: bright Snell window overhead, darker total reflection at grazing angles
    float up = clamp(-V.y, 0.0, 1.0);
    float win = smoothstep(0.55, 0.8, up);
    col = mix(vec3(0.04, 0.3, 0.32), vec3(0.55, 0.92, 0.86), win) + vec3(0.2, 0.3, 0.25) * win * (vn(p * 0.6 + t) - 0.3);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}`;
export function makeWaterMaterial(sunDir, sun2Dir, horizon, zenith) {
  return new THREE.ShaderMaterial({
    vertexShader: waterVS, fragmentShader: waterFS, fog: true, side: THREE.DoubleSide,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uSun: { value: sunDir.clone() }, uSun2: { value: sun2Dir.clone() }, uGlint: { value: 1 },
      uHor: { value: new THREE.Color(...horizon) }, uZen: { value: new THREE.Color(...zenith) },
    }]),
  });
}
export function buildWater(scene, mat) {
  const out = [];
  const step = 8, cols = 9;
  for (let sA = S0; sA < S_END; sA += CHUNK_LEN) {
    const sB = Math.min(sA + CHUNK_LEN, S_END);
    const pos = [], uv = [], aw = [], ix = [];
    let rows = 0;
    for (let s = sA; s <= sB + 0.01; s += step) {
      frame(s, F);
      const wr = riverHalf(s), W = wr + 9;
      for (let j = 0; j < cols; j++) {
        const lat = -W + (2 * W * j) / (cols - 1);
        pos.push(F.x + F.rx * lat, 0, F.z + F.rz * lat);
        uv.push(lat, s); aw.push(wr);
      }
      rows++;
    }
    for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      ix.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aW', new THREE.Float32BufferAttribute(aw, 1));
    g.setIndex(ix);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.matrixAutoUpdate = false;
    m.userData = { sA, sB };
    scene.add(m);
    out.push(m);
  }
  return out;
}

// foam rings around rocks / wreck standing in the river (one merged mesh)
const foamVS = /* glsl */`
attribute float aR;
varying vec2 vP; varying float vR; varying float vFog;
uniform float uFogD;
void main(){
  vP = uv; vR = aR;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = -mv.z * uFogD; vFog = exp(-d * d);
  gl_Position = projectionMatrix * mv;
}`;
const foamFS = /* glsl */`
uniform float uTime;
varying vec2 vP; varying float vR; varying float vFog;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
void main(){
  // vP: x = angle (0..1), y = 0 at rock edge .. 1 outer
  float n = vn(vec2(vP.x * 28.0, vP.y * 3.0 - uTime * 1.8)) * 0.6 + vn(vec2(vP.x * 60.0 + 3.0, vP.y * 6.0 - uTime * 3.0)) * 0.4;
  float a = smoothstep(1.0, 0.0, vP.y + n * 0.5) * smoothstep(0.0, 0.05, vP.y);
  // trailing wake downstream (x≈0.75 = downstream direction)
  a *= 0.75 + 0.5 * smoothstep(0.3, 0.0, abs(vP.x - 0.75));
  gl_FragColor = vec4(vec3(0.92, 0.96, 0.94), clamp(a, 0.0, 1.0) * 0.8 * vFog);
}`;
export function buildFoam(scene, fogD) {
  const pos = [], uv = [], ix = [], ar = [];
  const seg = 24;
  for (const r of ROCKS) {
    const base = new THREE.Vector3(); toWorld(r.s, r.lat, 0.06, base);
    const r0 = r.r * (r.wreck ? 1.4 : 0.95), r1 = r0 + 3.5 + r.r * 0.5;
    const st = pos.length / 3;
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const stretch = 1 + 0.9 * Math.max(0, -Math.sin(a));
      for (const [rad, v] of [[r0, 0], [r1, 1]]) {
        const rr = v ? rad * stretch : rad;
        pos.push(base.x + Math.cos(a) * rr, 0.06, base.z + Math.sin(a) * rr);
        uv.push(j / seg, v); ar.push(r.r);
      }
    }
    for (let j = 0; j < seg; j++) { const a = st + j * 2; ix.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aR', new THREE.Float32BufferAttribute(ar, 1));
  g.setIndex(ix);
  const mat = new THREE.ShaderMaterial({
    vertexShader: foamVS, fragmentShader: foamFS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uFogD: { value: fogD } },
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.renderOrder = 2;
  scene.add(m);
  return m;
}

// --------------------------------------------------------------- god-ray shafts from the mirror sun
const shaftVS = /* glsl */`
attribute vec3 aA; attribute vec3 aD; attribute vec4 aP; // aP: len, width, side, end
uniform float uTime;
varying float vSide; varying float vEnd; varying float vFade; varying float vK;
void main(){
  vec3 P = aA + aD * aP.x * aP.w;
  vec3 toCam = cameraPosition - P;
  vec3 side = normalize(cross(aD, toCam));
  P += side * aP.y * aP.z * (0.55 + 0.45 * aP.w);
  vSide = aP.z; vEnd = aP.w;
  float d = length(toCam);
  vFade = smoothstep(18.0, 90.0, d) * (1.0 - smoothstep(500.0, 900.0, d));
  vK = 0.65 + 0.35 * sin(uTime * 0.7 + aA.x * 0.05 + aA.z * 0.03);
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`;
const shaftFS = /* glsl */`
uniform float uOp; uniform vec3 uCol;
varying float vSide; varying float vEnd; varying float vFade; varying float vK;
void main(){
  float a = (1.0 - vSide * vSide) * smoothstep(0.0, 0.2, vEnd) * pow(1.0 - vEnd, 1.4) * vFade * vK;
  gl_FragColor = vec4(uCol * a * uOp, 1.0);
}`;
export function buildShafts(scene, sun2) {
  const R = rng(777);
  const aA = [], aD = [], aP = [], ix = [];
  const dir = sun2.clone().negate();
  let n = 0;
  for (let s = 250; s < PAD_B; s += 70 + R() * 90) {
    const k = 1 + (R() < 0.5 ? 1 : 0);
    for (let q = 0; q < k; q++) {
      const ss = s + R() * 30, H = rimH(ss);
      const side = R() < 0.5 ? -1 : 1;
      const lat = side * (wallLat(ss, H - 10, side) - 6 - R() * 12);
      const top = toWorld(ss, lat, H - 4, new THREE.Vector3());
      const len = (H + 10) / -dir.y, w = 4 + R() * 9;
      for (const [sd, e] of [[-1, 0], [1, 0], [-1, 1], [1, 1]]) {
        aA.push(top.x, top.y, top.z); aD.push(dir.x, dir.y, dir.z); aP.push(len, w, sd, e);
      }
      ix.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);
      n += 4;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(aA.slice(), 3));
  g.setAttribute('aA', new THREE.Float32BufferAttribute(aA, 3));
  g.setAttribute('aD', new THREE.Float32BufferAttribute(aD, 3));
  g.setAttribute('aP', new THREE.Float32BufferAttribute(aP, 4));
  g.setIndex(ix);
  const mat = new THREE.ShaderMaterial({
    vertexShader: shaftVS, fragmentShader: shaftFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uOp: { value: 0.085 }, uCol: { value: new THREE.Color(1.0, 0.93, 0.85) } },
  });
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.renderOrder = 3;
  scene.add(m);
  return m;
}

// --------------------------------------------------------------- force-field vaults
const fieldVS = /* glsl */`
varying vec2 vUv; varying float vFog; varying vec3 vN; varying vec3 vV; varying float vCap;
attribute float aCap;
uniform float uFogD;
void main(){
  vUv = uv; vCap = aCap;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  float d = -mv.z * uFogD; vFog = exp(-d * d);
  vV = normalize(cameraPosition - wp.xyz);
  vN = normal;
  gl_Position = projectionMatrix * mv;
}`;
const fieldFS = /* glsl */`
uniform float uTime; uniform float uAlpha; uniform float uFlick;
varying vec2 vUv; varying float vFog; varying vec3 vN; varying vec3 vV; varying float vCap;
void main(){
  vec2 p = vec2(vUv.x * 0.11, vUv.y * 0.11);
  vec2 r = vec2(1.0, 1.732);
  vec2 h = r * 0.5;
  vec2 a = mod(p, r) - h, b = mod(p - h, r) - h;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  float edge = smoothstep(0.42, 0.5, max(abs(g.x) * 0.866 + abs(g.y) * 0.5, abs(g.y)));
  float scan = 0.5 + 0.5 * sin(vUv.x * 0.05 - uTime * 2.0 + vUv.y * 0.02);
  float fres = 1.0 - abs(dot(normalize(vN), vV));
  float a1 = (0.025 + edge * 0.13 * (0.4 + 0.6 * scan) + fres * 0.08) * uAlpha * uFlick;
  // curtains hanging from the vault ends fade out downward
  a1 *= mix(1.0, smoothstep(0.0, 1.0, vCap) * (0.8 + 0.4 * sin(vUv.x * 0.3 + uTime * 3.0)), step(0.001, vCap));
  vec3 col = mix(vec3(0.25, 0.85, 1.0), vec3(0.7, 1.0, 1.0), edge);
  gl_FragColor = vec4(col * a1 * vFog * 1.3, 1.0);
}`;
export function buildFields(scene, fogD) {
  const geoStep = 15, arc = 14;
  for (const z of ZONES) {
    const pos = [], uv = [], ix = [], cap = [];
    let rows = 0;
    for (let s = z.s0; s <= z.s1 + 0.01; s += geoStep) {
      frame(s, F);
      const H = rimH(s);
      const wl = wallLat(s, H - 4, -1), wr = wallLat(s, H - 4, 1);
      for (let j = 0; j < arc; j++) {
        const t = j / (arc - 1);
        const lat = lerp(-wl - 4, wr + 4, t);
        const y = H - 8 + Math.sin(t * Math.PI) * 26;
        pos.push(F.x + F.rx * lat, y, F.z + F.rz * lat);
        uv.push(lat, s - z.s0); cap.push(0);
      }
      rows++;
    }
    for (let i = 0; i < rows - 1; i++) for (let j = 0; j < arc - 1; j++) {
      const a = i * arc + j, b = a + 1, c = a + arc, d = c + 1;
      ix.push(a, b, c, b, d, c);
    }
    // curtain at the zone entry: hangs 34 m down from the vault arch
    {
      const s = z.s0;
      frame(s, F);
      const H = rimH(s);
      const wl = wallLat(s, H - 4, -1), wr = wallLat(s, H - 4, 1);
      const st = pos.length / 3;
      for (let j = 0; j < arc; j++) {
        const t = j / (arc - 1);
        const lat = lerp(-wl - 4, wr + 4, t);
        const y = H - 8 + Math.sin(t * Math.PI) * 26;
        pos.push(F.x + F.rx * lat, y, F.z + F.rz * lat); uv.push(lat, 0); cap.push(1);
        pos.push(F.x + F.rx * lat, y - 34, F.z + F.rz * lat); uv.push(lat, 34); cap.push(0.0001);
      }
      for (let j = 0; j < arc - 1; j++) { const a = st + j * 2; ix.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aCap', new THREE.Float32BufferAttribute(cap, 1));
    g.setIndex(ix);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mat = new THREE.ShaderMaterial({
      vertexShader: fieldVS, fragmentShader: fieldFS, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 1 }, uFlick: { value: 1 }, uFogD: { value: fogD } },
    });
    const m = new THREE.Mesh(g, mat);
    m.matrixAutoUpdate = false;
    m.userData = { sA: z.s0, sB: z.s1 };
    scene.add(m);
    z.mesh = m;
  }
}

// --------------------------------------------------------------- sky
const skyVS = /* glsl */`
varying vec3 vDir;
void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const skyFS = /* glsl */`
uniform vec3 uSun; uniform vec3 uSun2; uniform vec3 uHor; uniform vec3 uZen; uniform float uTime; uniform vec3 uCam;
varying vec3 vDir;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a * vn(p); p *= 2.03; a *= 0.5; } return s; }
// skyline of mesas/buttes at radius R around the camera: flat tops, steep sides
float skyline(vec2 dxz, float R, float freq, float base, float amp, float seed){
  vec2 q = (uCam.xz + dxz * R) * freq + seed;
  float n = fbm(q);
  float mesa = smoothstep(0.42, 0.52, n) * 0.75 + smoothstep(0.62, 0.66, n) * 0.25;
  return base + amp * (mesa + 0.12 * vn(q * 6.0));
}
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec2 dxz = normalize(d.xz + 1e-5);
  // gradient + warm dusty horizon band
  vec3 col = mix(uHor, uZen, smoothstep(-0.02, 0.65, h));
  col = mix(col, uHor * 1.06, exp(-abs(h) * 14.0) * 0.5);
  col = mix(col, uHor * 0.9, smoothstep(0.0, -0.25, h));
  // dust layers
  col *= 1.0 + 0.035 * sin(h * 70.0 + fbm(dxz * 3.0) * 4.0) * smoothstep(0.35, 0.0, h);
  // high thin clouds (cirrus streaks), lit warm toward the sun
  vec2 cuv = d.xz / (h + 0.12);
  float c = fbm(vec2(cuv.x * 1.2 + uTime * 0.004, cuv.y * 4.0) + 3.0) * fbm(cuv * 0.6 + 9.0);
  float ca = smoothstep(0.2, 0.42, c) * smoothstep(0.04, 0.3, h) * 0.55;
  float s1 = max(dot(d, uSun), 0.0);
  vec3 cloudCol = mix(vec3(0.98, 0.78, 0.66), vec3(1.25, 0.95, 0.7), pow(s1, 6.0));
  col = mix(col, cloudCol, ca);
  // sun: glow + bright disc (HDR for bloom)
  col += vec3(1.0, 0.6, 0.35) * pow(s1, 5.0) * 0.18 + vec3(1.0, 0.82, 0.55) * pow(s1, 70.0) * 0.45;
  col = mix(col, vec3(2.6, 2.3, 1.85), smoothstep(0.99935, 0.99955, s1));
  // orbital mirror: small cold-white disc, halo and a dimmed, flickering ring
  float s2 = max(dot(d, uSun2), 0.0);
  float ang = acos(clamp(s2, -1.0, 1.0));
  float flick = 0.82 + 0.1 * sin(uTime * 7.3) * sin(uTime * 2.1 + 1.0) + 0.08 * step(0.97, h21(vec2(floor(uTime * 12.0), 3.0)));
  col += vec3(0.75, 0.86, 1.0) * (exp(-ang * 26.0) * 0.32 + exp(-ang * 90.0) * 0.5) * flick;
  float ringA = atan(dot(d, normalize(cross(uSun2, vec3(0.0, 1.0, 0.0)))), d.y - uSun2.y);
  float rq = (ang - 0.034) / 0.0035;
  float ring = exp(-rq * rq) * (0.55 + 0.45 * sin(ringA * 3.0 + uTime * 0.3));
  col += vec3(0.7, 0.85, 1.0) * ring * 0.35 * flick;
  col = mix(col, vec3(1.9, 2.05, 2.25) * flick, smoothstep(0.0115, 0.0085, ang));
  // distant mesas: three hazy layers with parallax (far -> near)
  float L3 = skyline(dxz, 6000.0, 1.0 / 900.0, 0.012, 0.05, 1.0);
  if (h < L3) col = mix(vec3(0.74, 0.46, 0.36), uHor, 0.62);
  float L2 = skyline(dxz, 3500.0, 1.0 / 650.0, 0.0, 0.065, 7.0);
  if (h < L2) col = mix(vec3(0.6, 0.33, 0.25), uHor, 0.45);
  float L1 = skyline(dxz, 2000.0, 1.0 / 420.0, -0.015, 0.08, 13.0);
  if (h < L1) col = mix(vec3(0.46, 0.22, 0.16), uHor, 0.3) * (0.92 + 0.08 * vn(dxz * 300.0));
  gl_FragColor = vec4(col, 1.0);
}`;
export function makeSky(sun, sun2, hor, zen) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), new THREE.ShaderMaterial({
    vertexShader: skyVS, fragmentShader: skyFS, side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: {
      uSun: { value: sun }, uSun2: { value: sun2 }, uHor: { value: new THREE.Color(...hor) }, uZen: { value: new THREE.Color(...zen) },
      uTime: { value: 0 }, uCam: { value: new THREE.Vector3() },
    },
  }));
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}
