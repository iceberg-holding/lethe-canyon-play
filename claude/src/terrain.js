// Builds the canyon chunks (walls, riverbed, rocks, arches, settlements, set dressing), river
// surface, foam, light shafts, force-field vaults and the sky. Everything static is merged per chunk.
import * as THREE from 'three';
import { clamp, lerp, smoothstep, noise1, noise2, hash2, rng, sanitizeNormals } from './util.js?v=r30';
import {
  S0, S_END, PAD_A, PAD_B, PAD_TOP, frame, toWorld, wallLat, riverHalf, rimH, basinF, bankY,
  ARCHES, ROCKS, ZONES, BEACONS, MASTS, TURRETS, DRESS, WRECK, TRIBS, archBottom, archTop, RIVER_A, GATE_S, isWet,
} from './world.js?v=r30';
import { rockTextures, colonialTextures } from './textures.js?v=r30';

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
  const band = Math.floor(yy / 11);
  const c = STRATA[(hash2(band, 7) * STRATA.length) | 0];
  const j = 0.91 + 0.16 * noise2(s * 0.018, y * 0.09);
  const ao = lerp(0.58, 1.04, smoothstep(2, 50, y));
  const wet = y < 3.2 ? 0.6 : 1;
  // greenish-grey tint of the half-terraformed lower banks
  const moss = y < 9 && y > 0.5 ? clamp(noise2(s * 0.03 + side * 7, y * 0.2) * 1.6, 0, 1) * 0.35 : 0;
  const k = j * ao * wet;
  _c[0] = lerp(c[0] * k, 0.30, moss); _c[1] = lerp((c[1] + 0.035) * k, 0.34, moss); _c[2] = lerp((c[2] + 0.035) * k, 0.24, moss);
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
    // Only remove material from the collision envelope. Recesses form harder
    // caprock and irregular erosion shelves without adding flight obstacles.
    const recess = y > 5 ? (0.5 + 0.5 * noise2(s * 0.038 + side * 19, y * 0.085)) *
      (1.2 + 2.8 * Math.pow(Math.sin(y * 0.19 + noise1(s * 0.007)), 8)) : 0;
    const garden = side === -1 ? smoothstep(1990, 2040, s) * (1 - smoothstep(2250, 2310, s)) : 0;
    const dam = side === -1 ? smoothstep(4370, 4410, s) * (1 - smoothstep(4560, 4610, s)) : 0;
    const alcove = garden * smoothstep(20, 25, y) * (1 - smoothstep(65, 72, y)) * 26
      + dam * smoothstep(28, 34, y) * (1 - smoothstep(96, 104, y)) * 26;
    const cascade = side === 1 ? Math.max(...[HEAD_FALL, 1850, 7080].map(c => (1 - smoothstep(4, 14, Math.abs(s - c))))) *
      smoothstep(1, 4, y) * (1 - smoothstep(60, 68, y)) * 8 : 0;
    const l = wallLat(s, y, side) + recess + alcove + cascade;
    out.push([l, y]);
    rimLat = l;
  }
  const crest = 8 + 22 * (0.5 + 0.5 * noise1(s * 0.019 + side * 13));
  out.push([rimLat + 12, H + crest], [rimLat + 38, H + crest * 0.8],
    [rimLat + 95, H + 8], [rimLat + 230, H + 22]);
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

function addSkyline(B, sA, sB) {
  for (let s = Math.ceil(sA / 110) * 110; s < sB; s += 110) {
    for (const side of [-1, 1]) {
      const h = 32 + hash2(s, side + 11) * 95;
      const y = rimH(s), lat = side * (wallLat(s, y, side) + 165 + hash2(s, side) * 90);
      const width = 25 + hash2(s, 91 + side) * 36;
      // All vertices are >100 m behind the rim; no collision changes.
      place(B, GEO.cyl6, s, lat, y + h * 0.36, width, h, width * 0.8,
        [0.58, 0.35, 0.25], hash2(s, 22) * 6);
      place(B, GEO.cyl6, s, lat, y + h * 0.86, width * 1.04, h * 0.09, width * 0.84,
        [0.74, 0.48, 0.31], hash2(s, 22) * 6);
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
    // round 27: both pads stand on the dry bed, so the pylon reaches down to it (bed ≈ −11 m at the centre)
    place(P, GEO.cyl, sPad, 0, (PAD_TOP - 11.6) / 2, 13, PAD_TOP + 11.6, 13, [0.32, 0.32, 0.33]);
    place(P, GEO.cyl, sPad, 0, -10.6, 17, 1.2, 17, [0.36, 0.34, 0.32]);
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
    for (let k = 1; k < 9; k++) {
      glowAt(sPad - 18 - k * 14, 0, 1.2, padCol, 2.2, 10 + k * 0.4);
      place(P, GEO.cyl8, sPad - 18 - k * 14, 0, -4.9, 0.35, 12.2, 0.35, dark);   // round 27: posts on the dry bed
    }
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
    P.geo(GEO.cyl8, m, v => {
      const rust=0.5+0.5*Math.sin(v.y*15+v.x*0.7+v.z*0.4);
      return rust>0.68?[0.39,0.23,0.13]:pipeCol;
    });
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

// Sheltered terraces and the surviving side abutment of a breached colonial dam.
// New structures sit behind the analytic wall. The river opening stays untouched.
function outerWall(s, y0, y1, ds, side) {
  let lat = 0;
  for (let ss = s - ds; ss <= s + ds; ss += 2)
    for (let y = y0; y <= y1; y += 1) lat = Math.max(lat, wallLat(ss, y, side));
  return lat + 1;
}
function addColonial(P, E, C, G, sA, sB) {
  for (let s = 2050; s <= 2230; s += 30) {
    if (s < sA || s >= sB) continue;
    for (const y of [26, 50]) {
      const lat = -(outerWall(s, y - 3, y + 10, 13, -1) + 11);
      place(P, GEO.box, s, lat - 5, y - 1.4, 20, 2.5, 25, [0.51, 0.42, 0.31]);
      for (const ds of [-9, 9]) place(P, GEO.box, s + ds, lat, y - 4, 1.2, 7, 1.8, [0.34, 0.31, 0.25]);
      place(P, GEO.box, s, lat - 5, y + 0.02, 17, 0.22, 22, [0.28, 0.37, 0.23]);
      for (let k = -1; k <= 1; k++) {
        place(P, GEO.box, s + k * 7, lat - 4, y + 0.4, 13, 0.5, 1.8, [0.39, 0.45, 0.24]);
      }
      if (s % 60 === 10) {
        place(P, GEO.cyl, s, lat - 8, y + 0.8, 5.7, 1.6, 6.2, [0.53, 0.50, 0.41]);
        place(G, GEO.dome, s, lat - 8, y + 1.6, 5.5, 7, 6, [0.37, 0.57, 0.52]);
        // Ribbed greenhouse with latitude rails, base collar and planted silhouettes.
        place(P, GEO.ring, s, lat-8, y+1.6, 5.65,0.35,6.15,[0.48,0.44,0.33]);
        for(let a=0;a<Math.PI*2;a+=Math.PI/6) for(let j=0;j<6;j++){
          const t=(j+0.5)/6*Math.PI/2, dt=Math.PI/12;
          const q0=toWorld(s+Math.sin(a)*6*Math.cos(t-dt/2),lat-8+Math.cos(a)*5.5*Math.cos(t-dt/2),y+1.6+7*Math.sin(t-dt/2),new THREE.Vector3());
          const q1=toWorld(s+Math.sin(a)*6*Math.cos(t+dt/2),lat-8+Math.cos(a)*5.5*Math.cos(t+dt/2),y+1.6+7*Math.sin(t+dt/2),new THREE.Vector3());
          const m=new THREE.Matrix4().lookAt(q0,q1,_U).setPosition(q0.clone().add(q1).multiplyScalar(0.5));
          m.multiply(new THREE.Matrix4().makeScale(0.12,0.12,q0.distanceTo(q1)*1.1));P.geo(GEO.box,m,[0.67,0.62,0.45]);
        }
        for(const t of [0.35,0.75,1.10]) {
          const r=Math.cos(t);
          place(P,GEO.ring,s,lat-8,y+1.6+7*Math.sin(t),5.5*r,0.10,6*r,[0.48,0.50,0.39]);
        }
        for(let j=0;j<5;j++){
          place(P,GEO.cone,s-3+j*1.5,lat-8,y+3.2,0.8,3.0,0.65,[0.17,0.28,0.13]);
          place(E,GEO.box,s-3+j*1.5,lat-8,y+2,0.25,0.12,0.25,[1.5,0.9,0.35]);
        }
        glowAt(s,lat-8,y+7,[1.0,0.65,0.25],4,-1);
        place(P,GEO.box,s+12,lat-6,y+0.4,3,0.4,14,[0.39,0.37,0.30]);
        place(E, GEO.box, s - 5.1, lat - 8, y + 1.8, 0.08, 0.35, 6, [1.1, 0.77, 0.35]);
      }
    }
  }
  for (let s = 4420; s <= 4550; s += 26) {
    if (s < sA || s >= sB) continue;
    const lat = -(outerWall(s, 32, 92, 13, -1) + 14), top = (s > 4510 ? 55 : 80) + hash2(s, 29) * 14;
    place(C, GEO.box, s, lat, (34 + top) / 2, 13, top - 34, 22, [0.57, 0.52, 0.44]);
    for (const ds of [-7, 5]) place(P, GEO.box, s + ds, lat + 6.6, (top + 34) / 2, 0.4, top - 34, 1.5, [0.36, 0.32, 0.27]);
    place(P, GEO.box, s, lat + 7, 54, 2, 4, 24, [0.30, 0.28, 0.26]);
    for(let j=0;j<7;j++) {
      place(P,GEO.cyl6,s-8+j*2.5,lat+3,top+1.4+hash2(s,j)*1.2,0.09,3+hash2(s,j)*2,0.09,[0.28,0.17,0.10],0,0,0.15);
      place(C,GEO.ico0,s-8+j*2.5,lat+6,top-0.5,1.3,0.7+hash2(j,s),1,[0.65,0.59,0.48]);
    }
    for(const ds of [-7,0,7]) {
      const chip=hash2(s,ds+41);
      place(C,GEO.box,s+ds,lat,top+0.5+chip*0.6,16+chip*2,1+chip*1.6,5.6+chip,[0.71,0.62,0.48]);
    }
    place(P, GEO.cyl8, s, lat + 8, 70, 1.7, 24, 1.7, [0.38, 0.29, 0.21], 0, Math.PI / 2);
    place(E, GEO.box, s - 10, lat + 7, top - 4, 0.12, 0.5, 5, [1.3, 0.46, 0.12]);
  }
}

export const FALLS = [];
// round 27: the river enters the canyon as a side cascade just past the weir (the main bed above it is dry)
const HEAD_FALL = RIVER_A + 32;
function addFalls(grp, sA, sB) {
  for (const s of [HEAD_FALL, 1850, 7080]) {
    if (s < sA || s >= sB) continue;
    const B = new Builder(), rows = 24, cols = 9, width = s === 7080 ? 10 : s === HEAD_FALL ? 16 : 18, edges = [];
    // Sheets follow the wall column by column, flare slightly toward the foot and
    // bulge gently toward the river, always keeping clear of the analytic wall.
    for (let layer = 0; layer < 3; layer++) {
    for (let i = 0; i <= rows; i++) {
      const y = 3 + i / rows * 57, yn = i / rows;
      for (let c = 0; c < cols; c++) {
        const u = c / (cols - 1), half = width / 2 * (1.12 - 0.2 * yn) * (1 - layer * 0.07);
        const ss = s + (u - 0.5) * 2 * half;
        const bulge = Math.sin(Math.PI * u) * (0.35 + 0.55 * (1 - yn)) * (layer === 0 ? 1 : 0.6);
        const lat = Math.max(outerWall(ss, y - 1, y + 2, 3, 1) + 0.3 + layer * 0.24 - bulge, wallLat(ss, y, 1) + 0.35);
        const p = toWorld(ss, lat, y, new THREE.Vector3());
        B.v(p.x, p.y, p.z, 1, 1, 1, u, yn);
        if (layer === 0 && (c === 0 || c === cols - 1) && i % 3 === 1) edges.push({ p, out: c ? 1 : -1 });
      }
    }
    for (let i = 0; i < rows; i++) for (let c = 0; c < cols - 1; c++) {
      const a = layer * (rows + 1) * cols + i * cols + c;
      B.tri(a, a + cols, a + 1); B.tri(a + 1, a + cols, a + cols + 1);
    }
    }
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uFlowRight: { value: new THREE.Vector3(frame(s,F).tx,0,F.tz) } },
      vertexShader: `uniform float uTime; uniform vec3 uFlowRight; varying vec2 vUv; varying float vD; void main(){ vUv=uv; vec3 p=position+uFlowRight*sin(uv.y*23.0+uTime*2.0)*(uv.x-0.5)*0.28; vec4 mv=modelViewMatrix*vec4(p,1.0); vD=-mv.z; gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `uniform float uTime; varying vec2 vUv; varying float vD;
      float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+1.0),f.x),f.y);}
      void main(){
        float y=clamp(vUv.y,0.0,1.0), t=uTime;
        float x=vUv.x+sin(y*19.0+t*1.7)*0.018;
        vec2 flow=vec2(x*13.0,y*8.0+t*2.8);
        float broad=n(flow), fine=n(flow*vec2(3.7,2.1)+t*0.7), veil=n(flow*vec2(0.55,3.4)-t);
        float streak=pow(n(vec2(x*125.0,y*2.0+t*3.0)),3.0)*fine;
        float fibre=n(vec2(x*60.0,y*3.0+t*3.4));
        // ragged, noise-broken sides that fray into separate fibres
        float side=min(x,1.0-x), sn=n(vec2(step(0.5,x)*31.0+y*7.0+t*2.4,y*2.0));
        float edge=smoothstep(0.0,0.2,side+(sn-0.5)*0.14);
        edge*=mix(smoothstep(0.3,0.7,fibre),1.0,smoothstep(0.06,0.2,side));
        // soft broken lip at the top, dissolving foot at the bottom
        float ln=n(vec2(x*21.0,t*0.6)), bn=n(vec2(x*17.0,t*1.9));
        float top=1.0-smoothstep(0.9,1.0,y+(ln-0.5)*0.06);
        float foot=smoothstep(0.0,0.13,y-0.02+(bn-0.5)*0.1);
        float lip=smoothstep(0.84,0.94,y)*top, impact=exp(-y*9.0);
        float density=0.12+smoothstep(0.18,0.82,broad)*0.58+fine*0.16+streak*0.55+lip*0.45+impact*0.7;
        vec3 col=mix(vec3(0.26,0.44,0.40),vec3(0.94,0.9,0.78),clamp(broad*0.65+streak+lip+impact*1.4,0.0,1.0));
        col=mix(col,vec3(1.08,1.06,1.0),impact*0.8);
        gl_FragColor=vec4(col,clamp(edge*top*foot*density*(0.55+veil*0.45),0.0,1.0)*exp(-vD*vD*0.0000036)); }`,
    });
    const m = mk(B, mat); m.userData.width = width; m.userData.layers = 3; m.userData.detail = true; m.userData.highOnly = s === 7080;
    grp.add(m); FALLS.push(m);
    // Impact pool is entirely behind the analytic wall, at the foot of the cascade.
    const p = toWorld(s, outerWall(s, 2, 5, width * 1.2 + 1, 1) + width * 0.11, 3.1, new THREE.Vector3());
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(width * 2.4, width * 0.2), new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, side:THREE.DoubleSide,
      uniforms:{uTime:{value:0}},
      vertexShader:`varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader:`uniform float uTime; varying vec2 vUv;
      float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+1.0),f.x),f.y);}
      void main(){vec2 p=vUv*2.0-1.0;float r=length(p);
        float churn=n(p*9.0+vec2(uTime*0.7,-uTime*0.4));
        float bubbles=n(p*23.0-vec2(uTime,0.0));
        float rings=pow(0.5+0.5*sin(r*32.0-uTime*4.0+churn*6.0),5.0);
        float foam=smoothstep(0.46,0.78,churn)*0.55+rings*bubbles*0.45+pow(max(0.0,1.0-r),8.0)*0.4;
        float edge=1.0-smoothstep(0.15,1.0,r+churn*0.12);
        gl_FragColor=vec4(mix(vec3(0.13,0.28,0.24),vec3(0.86,0.83,0.69),foam),edge*(0.24+foam*0.65));}`
    }));
    frame(s,F);
    pool.matrixAutoUpdate=false;
    pool.matrix.makeBasis(new THREE.Vector3(F.tx,0,F.tz),new THREE.Vector3(F.rx,0,F.rz),_U).setPosition(p);
    pool.userData.detail=true; pool.userData.highOnly=s===7080; grp.add(pool); FALLS.push(pool);
    VENTS.push({ p, k: 0, waterfall:true, highOnly:s===7080, edges, width, tx:F.tx, tz:F.tz, rx:F.rx, rz:F.rz });
  }
}

// --------------------------------------------------------------- materials
export const terrainTex = {};
export function makeTerrainMaterial() {
  const { map, normalMap } = rockTextures(512);
  terrainTex.map = map; terrainTex.normalMap = normalMap;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map, normalMap, normalScale: new THREE.Vector2(0.45, 0.45) });
  // World-space mineral seams break up the UV tile. Analytic, no added texture
  // fetches / draws; the original normal map supplies close-range rock grain.
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec3 vStone;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vStone = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = 'varying vec3 vStone;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      float warp = sin(vStone.x * 0.009 + vStone.z * 0.006) * 2.8 + sin(vStone.z * 0.031) * 0.6;
      float bed = vStone.y + warp;
      float seam = smoothstep(0.90, 0.97, fract(bed * 0.31));
      float lamina = sin(bed * 5.3) * sin(bed * 1.7) * 0.045;
      float run = sin(vStone.x * 0.43 + sin(vStone.z * 0.14)) * sin(vStone.z * 0.37 + vStone.y * 0.025);
      float varnish = smoothstep(0.45, 0.9, run) * 0.14;
      diffuseColor.rgb *= 1.05 + lamina - seam * 0.22 - varnish;
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 1.04, 0.91), smoothstep(0.60, 0.95, fract(bed * 0.073)) * 0.35);
    `);
  };
  return mat;
}
const concreteTex=colonialTextures();
const concreteMat=new THREE.MeshLambertMaterial({vertexColors:true,map:concreteTex.map,normalMap:concreteTex.normalMap,normalScale:new THREE.Vector2(0.35,0.35)});
const glassMat=new THREE.MeshLambertMaterial({vertexColors:true,transparent:true,opacity:0.48,depthWrite:false,side:THREE.DoubleSide,emissive:0x263a24});
glassMat.onBeforeCompile=(sh)=>{
  sh.vertexShader='varying vec3 vGlassP;\n'+sh.vertexShader;
  sh.vertexShader=sh.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n vGlassP=position;');
  sh.fragmentShader='varying vec3 vGlassP;\n'+sh.fragmentShader;
  sh.fragmentShader=sh.fragmentShader.replace('#include <opaque_fragment>',`
    float fr=pow(1.0-abs(dot(normal,normalize(vViewPosition))),3.0);
    float dirt=sin(vGlassP.x*3.0+vGlassP.z*0.7)*sin(vGlassP.y*8.0);
    outgoingLight+=vec3(0.24,0.33,0.27)*fr;
    diffuseColor.a=0.22+fr*0.42+max(0.0,dirt)*0.12;
    #include <opaque_fragment>`);
};
export const propMat = new THREE.MeshLambertMaterial({ vertexColors: true });
// Shared weathering keeps colonial concrete and metal from reading as clean boxes.
propMat.onBeforeCompile = (shader) => {
  shader.vertexShader = 'varying vec3 vWear;\n' + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vWear = (modelMatrix * vec4(position, 1.0)).xyz;');
  shader.fragmentShader = 'varying vec3 vWear;\n' + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
    float streak = sin(vWear.x * 1.2 + vWear.z * 0.91 + sin(vWear.y * 0.08));
    float grain = sin(vWear.x * 19.0 + vWear.y * 31.0) * sin(vWear.z * 27.0 - vWear.y * 7.0);
    diffuseColor.rgb *= 0.94 + grain * 0.055 - smoothstep(0.45, 1.0, streak) * 0.16;
  `);
};
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
    const B = new Builder(), D = new Builder(), P = new Builder(), E = new Builder(), S = new Builder(), C = new Builder(), G = new Builder();
    addTerrain(B, c0, c1);
    addSkyline(B, sA, sB);
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
    addColonial(P, E, C, G, sA, sB);
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
    addFalls(grp, sA, sB);
    for(const [builder, material] of [[C,concreteMat],[G,glassMat]]) {
      const mesh=mk(builder,material);if(mesh){mesh.userData.detail=true;grp.add(mesh);}
    }
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
    col += vec3(1.5, 1.1, 0.7) * (sp1 * 0.85 + sp1 * sparkle * 1.2) * uGlint;
    col += vec3(0.85, 0.95, 1.2) * (sp2 * 1.2 + pow(max(dot(R, uSun2), 0.0), 120.0) * 0.12) * uGlint;
    // flow streaks + bank foam
    float streak = smoothstep(0.62, 0.95, vn(vec2(p.x * 0.8, p.y * 0.02 - t * 1.4)));
    col += vec3(0.08, 0.13, 0.12) * streak;
    float fn = vn(vec2(p.x * 1.3, p.y * 0.5 - t * 2.2)) * 0.6 + vn(vec2(p.x * 3.1, p.y * 1.7 - t * 3.0)) * 0.4;
    float foam = smoothstep(2.6, 0.0, edgeD + fn * 1.6 - 0.6);
    foam = max(foam, smoothstep(0.78, 0.95, fn) * smoothstep(5.0, 1.0, edgeD));
    float lace = 0.65 + 0.35 * sin(fn * 29.0 + uTime * 2.0);
    col = mix(col, vec3(0.9, 0.93, 0.86), foam * (0.7 + 0.2 * lace));
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
  for (let sA0 = S0; sA0 < S_END; sA0 += CHUNK_LEN) {
    // round 27: water only between the weir (RIVER_A) and the LETHE curtain (GATE_S)
    const sA = Math.max(sA0, RIVER_A), sB = Math.min(sA0 + CHUNK_LEN, S_END, GATE_S - 0.3);
    if (sB - sA < 1) continue;
    const pos = [], uv = [], aw = [], ix = [];
    let rows = 0;
    for (let s0 = sA; s0 <= sB + step - 0.01; s0 += step) {
      const s = Math.min(s0, sB);
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
  a *= 0.6 + 0.4 * smoothstep(0.3, 0.75, n) + 0.5 * smoothstep(0.3, 0.0, abs(vP.x - 0.75));
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
uniform float uTime; uniform float uReach;
varying float vSide; varying float vEnd; varying float vFade; varying float vK;
void main(){
  vec3 P = aA + aD * aP.x * uReach * aP.w;
  vec3 toCam = cameraPosition - P;
  vec3 side = normalize(cross(aD, toCam));
  P += side * aP.y * aP.z * (0.55 + 0.45 * aP.w);
  vSide = aP.z; vEnd = aP.w;
  float d = length(toCam);
  vFade = smoothstep(18.0, 90.0, d) * (1.0 - smoothstep(500.0, 900.0, d));
  vK = 0.82 + 0.18 * sin(uTime * 0.35 + aA.x * 0.05 + aA.z * 0.03);
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`;
const shaftFS = /* glsl */`
uniform float uOp; uniform vec3 uCol;
varying float vSide; varying float vEnd; varying float vFade; varying float vK;
void main(){
  float filament = 0.72 + 0.28 * pow(0.5 + 0.5 * sin(vSide * 27.0 + vEnd * 7.0), 3.0);
  float a = filament * pow(1.0 - vSide * vSide, 2.0) * smoothstep(0.0, 0.2, vEnd) * pow(1.0 - vEnd, 1.4) * vFade * vK;
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
      const len = Math.min(300, (H + 10) / -dir.y), w = 4 + R() * 9;   // (round 4: the mirror is lower -> cap the slant length)
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
    uniforms: { uTime: { value: 0 }, uOp: { value: 0.085 }, uReach: { value: 1 }, uCol: { value: new THREE.Color(1.0, 0.93, 0.85) } },
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
  float edge = (1.0 - smoothstep(0.012, 0.035, abs(0.5 - max(abs(g.x), dot(abs(g), vec2(0.5, 0.866))))));
  float scan = 0.5 + 0.5 * sin(vUv.x * 0.05 - uTime * 2.0 + vUv.y * 0.02);
  float fres = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float a1 = (0.004 + edge * 0.045 * (0.4 + 0.6 * scan) + pow(fres, 3.0) * 0.08) * uAlpha * uFlick;
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
  // orbital mirror (second sun, round 4): cooler/whiter and distinct from the real sun — crisp disc, sharp ring,
  // soft halo, faint cross / lens streaks, and a slow dimming pulse with rare stutters (LETHE is dimming it)
  float s2 = dot(d, uSun2);
  if (s2 > 0.0) {
    float ang = acos(clamp(s2, -1.0, 1.0));
    vec3 rgt = normalize(cross(uSun2, vec3(0.0, 1.0, 0.0)));
    vec3 upv = cross(rgt, uSun2);
    vec2 q = vec2(dot(d, rgt), dot(d, upv));
    float pulse = 0.8 + 0.14 * sin(uTime * 0.5) + 0.06 * sin(uTime * 1.63 + 0.6);
    float flick = pulse * (1.0 - 0.4 * step(0.986, h21(vec2(floor(uTime * 14.0), 5.0))));
    vec3 cool = vec3(0.76, 0.9, 1.0);
    col += cool * (exp(-ang * 13.0) * 0.2 + exp(-ang * 48.0) * 0.4) * flick;
    float rq = (ang - 0.06) / 0.0026;
    col += cool * exp(-rq * rq) * 0.32 * flick;
    float rq2 = (ang - 0.098) / 0.005;
    col += cool * exp(-rq2 * rq2) * 0.07 * flick;
    float sx = exp(-abs(q.y) * 380.0) * exp(-abs(q.x) * 8.0);
    float sy = exp(-abs(q.x) * 380.0) * exp(-abs(q.y) * 20.0);
    col += cool * (sx * 0.35 + sy * 0.20) * flick;
    col = mix(col, vec3(2.4, 2.6, 2.85) * (0.82 + 0.18 * flick), smoothstep(0.0165, 0.0142, ang));
  }
  // Phobos is irregular and larger; Deimos is a distant pin of reflected light.
  vec3 moonDir = normalize(vec3(-0.34, 0.46, -0.82));
  float md = length(d - moonDir);
  float limb = 0.0068 * (1.0 + 0.08 * sin(atan(d.y - moonDir.y, d.x - moonDir.x) * 5.0));
  float moon = 1.0 - smoothstep(limb - 0.0006, limb + 0.0006, md);
  col = mix(col, vec3(0.47, 0.36, 0.29) * (0.8 + 0.2 * vn(d.xz * 3500.0)), moon * 0.85);
  float deimos = 1.0 - smoothstep(0.0011, 0.0018, length(d - normalize(vec3(0.56, 0.38, -0.74))));
  col = mix(col, vec3(1.05, 0.85, 0.67), deimos * 0.8);
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

// --------------------------------------------------------------- round 27: dry riverbed, weir, held-back water face
// The river only has water between the colonists' weir (RIVER_A) and the LETHE curtain (GATE_S). Outside that the
// riverbed trench (same cross-section the terrain uses: 0 / −11 m centre, −10.5 @0.45 wr, −7 @0.8 wr, −2.5 @0.95 wr,
// +0.4 @wr) is draped with a cracked, salt-crusted mud overlay; a few damp stains seep past the curtain and the weir.
// At the curtain the held-back river stands as a vertical water face (bed → level 0) right behind the field.
const BED_K = [[-1, 0.4], [-0.95, -2.5], [-0.8, -7], [-0.45, -10.5], [0, -11], [0.45, -10.5], [0.8, -7], [0.95, -2.5], [1, 0.4]];
function bedKnots(wr, sub) {
  const out = [];
  for (let k = 0; k < BED_K.length - 1; k++) for (let j = 0; j < sub; j++) {
    const t = j / sub, a = BED_K[k], b = BED_K[k + 1];
    out.push([(a[0] + (b[0] - a[0]) * t) * wr, a[1] + (b[1] - a[1]) * t]);
  }
  out.push([wr, 0.4]);
  return out;
}
export const bedYAt = (s, lat) => {
  const wr = riverHalf(s), u = Math.abs(lat) / wr;
  for (let k = 4; k < BED_K.length - 1; k++) {
    const a = BED_K[k], b = BED_K[k + 1];
    if (u <= b[0]) return a[1] + (b[1] - a[1]) * (u - a[0]) / (b[0] - a[0]);
  }
  return 0.4;
};
export function makeDryMaterial() {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  mat.userData.uniforms = { uGate: { value: GATE_S }, uWeir: { value: RIVER_A } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, mat.userData.uniforms);
    sh.vertexShader = 'attribute vec3 aPath;\nvarying vec3 vPath;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vPath = aPath;');
    sh.fragmentShader = `varying vec3 vPath; uniform float uGate; uniform float uWeir;
float dh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 dh2(vec2 p){ return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
float dn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(dh(i), dh(i+vec2(1,0)), f.x), mix(dh(i+vec2(0,1)), dh(i+vec2(1,1)), f.x), f.y); }
// Voronoi: x = distance to the nearest cell border (crack), y = cell id hash
vec2 crack(vec2 p){
  vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0; vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y)), o = dh2(i + g), r = g + o - f; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = i + g; } else if (d < d2) d2 = d;
  }
  return vec2(sqrt(d2) - sqrt(d1), dh(id));
}
` + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec2 p = vPath.xy;                 // x = lateral metres, y = metres along the canyon
    float u = vPath.z;                 // 0 at the bed centre, 1 at the bank lip
    float n = dn(p * vec2(0.09, 0.05)), n2 = dn(p * 0.6 + 7.0);
    vec2 c1 = crack(p * vec2(0.42, 0.36)), c2 = crack(p * 1.35 + 3.0);
    vec3 mud = mix(vec3(0.58, 0.45, 0.35), vec3(0.70, 0.57, 0.45), c1.y * 0.6 + n * 0.4);
    mud *= 0.92 + 0.12 * n2;
    // pale salt / perchlorate crust on the flats, thinning up the slopes
    float salt = smoothstep(0.55, 0.85, dn(p * vec2(0.16, 0.11) + 11.0)) * (1.0 - smoothstep(0.45, 0.9, u));
    mud = mix(mud, vec3(0.88, 0.85, 0.78), salt * 0.55);
    // plate cracks (bigger on the flats) + a fine craquelure
    float cw = mix(0.075, 0.035, smoothstep(0.3, 0.9, u));
    float cr = 1.0 - smoothstep(cw * 0.4, cw, c1.x);
    float fine = 1.0 - smoothstep(0.015, 0.04, c2.x);
    mud *= 1.0 - cr * 0.62 - fine * 0.18 * (1.0 - u);
    // a few damp stains: seepage just past the curtain and below the weir, darker patches in the low channel
    float seep = exp(-max(vPath.y - uGate, 0.0) / 70.0) * step(uGate - 8.0, vPath.y) + exp(-max(uWeir - vPath.y, 0.0) / 28.0) * step(vPath.y, uWeir + 8.0);
    float patchy = smoothstep(0.62, 0.8, dn(p * vec2(0.07, 0.035) + 21.0)) * 0.55;
    float damp = clamp((seep * (0.55 + 0.45 * n) + patchy) * (1.0 - smoothstep(0.25, 0.75, u)), 0.0, 1.0);
    mud = mix(mud, mud * vec3(0.48, 0.44, 0.42), damp);
    diffuseColor.rgb *= mud;
  }`);
  };
  return mat;
}
export function buildDryBed(scene) {
  const grp = new THREE.Group();
  const dryMat = makeDryMaterial();
  const spans = [[S0, RIVER_A + 6], [GATE_S - 8, S_END]];
  for (const [a, b] of spans) {
    for (let c0 = a; c0 < b; c0 += CHUNK_LEN) {
      const i0 = Math.floor((c0 - S0) / SEC), i1 = Math.ceil((Math.min(c0 + CHUNK_LEN, b) - S0) / SEC);
      const pos = [], path = [], ix = [];
      let cols = 0;
      for (let i = i0; i <= i1; i++) {
        const s = S0 + i * SEC, wr = riverHalf(s);
        frame(s, F);
        const ks = bedKnots(wr, 3);
        cols = ks.length;
        for (const [lat, y] of ks) { pos.push(F.x + F.rx * lat, y + 0.12, F.z + F.rz * lat); path.push(lat, s, Math.abs(lat) / wr); }
      }
      for (let i = 0; i < i1 - i0; i++) for (let j = 0; j < cols - 1; j++) {
        const q = i * cols + j; ix.push(q, q + cols, q + 1, q + 1, q + cols, q + cols + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aPath', new THREE.Float32BufferAttribute(path, 3));
      g.setIndex(ix); g.computeVertexNormals(); g.computeBoundingSphere();
      const m = new THREE.Mesh(g, dryMat); m.matrixAutoUpdate = false; m.receiveShadow = true;
      m.userData = { sA: S0 + i0 * SEC, sB: S0 + i1 * SEC };
      grp.add(m);
    }
  }
  // the colonists' weir: a low concrete sill across the old bed, crest 0.7 m above the river level
  {
    const s0 = RIVER_A - 1.6, s1 = RIVER_A + 1.6, pos = [], col = [], ix = [];
    const wr = riverHalf(RIVER_A), ks = bedKnots(wr * 1.02, 2);
    const V = (s, lat, y, c) => { frame(s, F); pos.push(F.x + F.rx * lat, y, F.z + F.rz * lat); col.push(c, c * 0.97, c * 0.92); return pos.length / 3 - 1; };
    for (let j = 0; j < ks.length - 1; j++) {
      const [la, ya] = ks[j], [lb, yb] = ks[j + 1];
      const tint = 0.5 + 0.08 * Math.sin(j * 2.3);
      // dry-side face (stained darker toward the foot) + crest
      const a0 = V(s0, la, ya - 0.5, tint * 0.7), a1 = V(s0, la, 0.7, tint), b0 = V(s0, lb, yb - 0.5, tint * 0.7), b1 = V(s0, lb, 0.7, tint);
      ix.push(a0, b0, a1, a1, b0, b1);
      const t0 = V(s0, la, 0.7, tint * 1.1), t1 = V(s1, la, 0.7, tint * 1.05), t2 = V(s0, lb, 0.7, tint * 1.1), t3 = V(s1, lb, 0.7, tint * 1.05);
      ix.push(t0, t2, t1, t1, t2, t3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(ix); g.computeVertexNormals(); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    m.matrixAutoUpdate = false; m.userData = { sA: s0, sB: s1 }; grp.add(m);
  }
  // the held-back river: a vertical water face pressed against the curtain (seen from the dry side through the field)
  const faceMat = new THREE.ShaderMaterial({
    fog: true, side: THREE.DoubleSide,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
    vertexShader: `varying vec2 vUv; varying vec3 vW;
      #include <fog_pars_vertex>
      void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `uniform float uTime; varying vec2 vUv; varying vec3 vW;
      #include <fog_pars_fragment>
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+1.0), f.x), f.y); }
      void main(){
        float t = uTime, y = vUv.y;                  // y: metres, 0 = river level, negative = depth
        float d = clamp(-y / 11.0, 0.0, 1.0);
        float sw = n(vec2(vUv.x * 0.18 + t * 0.15, y * 0.35 - t * 0.4)) * 0.6 + n(vec2(vUv.x * 0.6 - t * 0.3, y * 1.1 + t * 0.7)) * 0.4;
        vec3 col = mix(vec3(0.10, 0.50, 0.48), vec3(0.01, 0.13, 0.16), d) * (0.75 + 0.5 * sw);
        // caustic ripples near the top, a foamy lip pressed against the field, a red rim from the curtain
        col += vec3(0.25, 0.4, 0.36) * pow(n(vec2(vUv.x * 0.9, y * 2.0 - t * 1.6)), 4.0) * (1.0 - d);
        float lip = smoothstep(-0.9, -0.05, y + (n(vec2(vUv.x * 1.3, t * 1.2)) - 0.5) * 0.4);
        col = mix(col, vec3(0.86, 0.92, 0.88), lip * 0.8);
        col += vec3(0.35, 0.05, 0.03) * (0.4 + 0.6 * sw) * (1.0 - d * 0.5);
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`,
  });
  faceMat.userData.tick = (time) => { faceMat.uniforms.uTime.value = time; };
  {
    const s = GATE_S - 0.45, wr = riverHalf(s), ks = bedKnots(wr * 1.03, 4), pos = [], uv = [], ix = [];
    frame(s, F);
    for (const [lat, yb] of ks) {
      const yy = Math.min(yb - 0.6, -0.02);
      pos.push(F.x + F.rx * lat, yy, F.z + F.rz * lat, F.x + F.rx * lat, 0.02, F.z + F.rz * lat);
      uv.push(lat, yy, lat, 0.02);
    }
    for (let j = 0; j < ks.length - 1; j++) { const a = j * 2; ix.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(ix); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, faceMat); m.matrixAutoUpdate = false; m.userData = { sA: s - 1, sB: s + 1 };
    grp.add(m);
  }
  scene.add(grp);
  return { grp, faceMat, dryMat, meshes: grp.children };
}
