// Builds the canyon chunks (walls, riverbed, rocks, arches, settlements), river
// surface and the force-field vaults. Everything static is merged per chunk.
import * as THREE from 'three';
import { clamp, lerp, smoothstep, noise1, noise2, hash2, rng } from './util.js';
import {
  S0, S_END, PAD_A, PAD_B, PAD_TOP, frame, toWorld, wallLat, riverHalf, rimH,
  ARCHES, ROCKS, ZONES, BEACONS, MASTS, archBottom, archTop,
} from './world.js';

const SEC = 6;              // metres between cross sections
const CH_SEC = 40;          // sections per chunk (240 m)
export const CHUNK_LEN = SEC * CH_SEC;

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
  geo(g, m, col) {
    const base = this.n, pos = g.attributes.position, uv = g.attributes.uv;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      const c = typeof col === 'function' ? col(v) : col;
      this.v(v.x, v.y, v.z, c[0], c[1], c[2], uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.ix.push(base + g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) this.ix.push(base + i);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.ix);
    g.computeVertexNormals();
    return g;
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
    _c[0] = lerp(0.40, 0.14, t); _c[1] = lerp(0.30, 0.22, t); _c[2] = lerp(0.22, 0.19, t);
    return _c;
  }
  const yy = y + 5 * noise1(s * 0.004 + side * 3.1);
  const band = Math.floor(yy / 7);
  const c = STRATA[(hash2(band, 7) * STRATA.length) | 0];
  const j = 0.9 + 0.12 * noise2(s * 0.05, y * 0.15);
  const ao = lerp(0.6, 1.02, smoothstep(2, 50, y));
  const wet = y < 3.2 ? 0.62 : 1;
  const k = j * ao * wet;
  _c[0] = c[0] * k; _c[1] = c[1] * k; _c[2] = c[2] * k;
  return _c;
}
// post pass: dust on horizontal ledges
function dustLedges(g) {
  const n = g.attributes.normal, c = g.attributes.color, p = g.attributes.position;
  for (let i = 0; i < n.count; i++) {
    if (p.getY(i) < 3.5) continue;
    const t = smoothstep(0.62, 0.92, n.getY(i)) * 0.75;
    if (t <= 0) continue;
    c.setXYZ(i, lerp(c.getX(i), 0.86, t), lerp(c.getY(i), 0.56, t), lerp(c.getZ(i), 0.38, t));
  }
}

// --------------------------------------------------------------- strata texture
function strataTexture() {
  const S = 256, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    const row = 0.8 + 0.2 * noise2(0.5, y * 0.21) + 0.08 * noise2(3.3, y * 1.3);
    for (let x = 0; x < S; x++) {
      const streak = 0.06 * noise2(x * 0.35, y * 0.02 + 9);
      const grain = 0.07 * (hash2(x, y) - 0.5) + 0.06 * noise2(x * 0.11, y * 0.11);
      const v = clamp(row + streak + grain, 0, 1) * 255;
      const o = (y * S + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 2;
  return t;
}

// --------------------------------------------------------------- y levels of a wall
const LEVELS = [];
for (let k = 0; k < 7; k++) for (const o of [0, 6, 12, 16.5, 19.5, 22]) LEVELS.push(k * 24 + o);
LEVELS[0] = 3;

const F = { x: 0, z: 0, th: 0, tx: 0, tz: 0, rx: 0, rz: 0 };
function sideProfile(s, side, out) {
  // returns list of [lat, y] from centre outwards
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

// a rough rock column / boulder standing in the river
function addRock(B, r) {
  const seg = 10, base = new THREE.Vector3();
  toWorld(r.s, r.lat, 0, base);
  const y0 = -11, y1 = r.h, rings = r.boulder ? 6 : Math.max(6, Math.round((y1 - y0) / 6));
  const start = B.n;
  for (let k = 0; k <= rings; k++) {
    const t = k / rings, y = lerp(y0, y1, t);
    let rad = r.boulder ? r.r * (1 - Math.pow(Math.max(0, (y) / r.h), 2.2) * 0.75) : r.r * (1 - 0.18 * t);
    const step = r.boulder ? 0 : 0.1 * smoothstep(0.6, 1, (y / 9) % 1);
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const n = 1 + 0.24 * noise2(Math.cos(a) * 1.5 + r.seed, y * 0.07 + Math.sin(a) * 1.5) - step;
      const x = base.x + Math.cos(a) * rad * n, z = base.z + Math.sin(a) * rad * n;
      const c = rockColor(r.s + j * 3, y, 1);
      B.v(x, y, z, c[0], c[1], c[2], j / 3, y / 36);
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
  const w = a.w + 10, steps = Math.ceil((2 * w) / 3);
  const start = B.n, ring = 8;
  for (let i = 0; i <= steps; i++) {
    const lat = -w + (2 * w * i) / steps;
    const bot = Math.max(archBottom(a, lat), -12), top = archTop(a, lat);
    const ht = a.ht * (1 + 0.5 * Math.pow(Math.abs(lat) / w, 3));
    const pts = [[-ht, bot + 1.5], [-ht * 0.6, bot], [ht * 0.6, bot], [ht, bot + 1.5], [ht, top - 1.5], [ht * 0.6, top], [-ht * 0.6, top], [-ht, top - 1.5]];
    for (let k = 0; k < ring; k++) {
      const [ds, y] = pts[k];
      const n = noise2(lat * 0.12 + k * 3.1, a.s * 0.01);
      const yy = y + n * 1.2 * (k === 1 || k === 2 ? 0.4 : 1);
      frame(a.s + ds * (1 + 0.15 * n), F);
      const c = rockColor(a.s, yy, 1);
      B.v(F.x + F.rx * lat, yy, F.z + F.rz * lat, c[0], c[1], c[2], lat / 36, yy / 36);
    }
  }
  for (let i = 0; i < steps; i++) for (let k = 0; k < ring; k++) {
    const k2 = (k + 1) % ring;
    const p = start + i * ring + k, b = start + i * ring + k2, c = p + ring, d = b + ring;
    B.tri(p, b, c); B.tri(b, d, c);
  }
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _T = new THREE.Vector3(), _R = new THREE.Vector3(), _U = new THREE.Vector3(0, 1, 0), _P = new THREE.Vector3();
function basisAt(s, lat, y, yaw = 0) {
  frame(s, F);
  _R.set(F.rx, 0, F.rz); _T.set(-F.tx, 0, -F.tz);
  _m.makeBasis(_R, _U, _T);
  if (yaw) _m.multiply(new THREE.Matrix4().makeRotationY(yaw));
  toWorld(s, lat, y, _P);
  _m.setPosition(_P);
  return _m;
}

// static glow lights (settlement lamps etc.): {p:Vector3, c:[r,g,b], size, blink}
export const STATIC_GLOWS = [];

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  dome: new THREE.SphereGeometry(1, 16, 7, 0, Math.PI * 2, 0, Math.PI / 2),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 14),
  cyl6: new THREE.CylinderGeometry(1, 1, 1, 6),
};
function place(B, geo, s, lat, y, sx, sy, sz, col, yaw = 0) {
  const m = basisAt(s, lat, y, yaw).clone().multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
  B.geo(geo, m, col);
}

function addSettlement(B, sPad, sMin, sMax, which) {
  const R = rng(which === 'A' ? 11 : 22);
  // landing pad on a pier in the river
  place(B, GEO.cyl, sPad, 0, PAD_TOP / 2 - 2, 13, PAD_TOP + 4, 13, [0.30, 0.30, 0.31]);
  place(B, GEO.cyl, sPad, 0, PAD_TOP + 0.05, 10, 0.1, 10, which === 'A' ? [0.75, 0.55, 0.18] : [0.2, 0.55, 0.35]);
  place(B, GEO.cyl, sPad, 0, PAD_TOP + 0.12, 8.6, 0.1, 8.6, [0.26, 0.26, 0.27]);
  for (const sd of [-1, 1]) place(B, GEO.box, sPad, sd * 22, 1.2, 18, 1.0, 4, [0.33, 0.32, 0.31]);
  const padCol = which === 'A' ? [1, 0.6, 0.2] : [0.3, 1, 0.5];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2, p = new THREE.Vector3();
    toWorld(sPad + Math.cos(a) * 12.2, Math.sin(a) * 12.2, PAD_TOP + 0.4, p);
    STATIC_GLOWS.push({ p, c: padCol, size: 1.6, blink: k * 0.08 + (which === 'B' ? 1 : 0) });
  }
  // domes, towers and tanks on both banks
  for (let s = sMin; s < sMax; s += 26 + R() * 24) {
    for (const side of [-1, 1]) {
      if (R() < 0.3) continue;
      const wr = riverHalf(s), wb = wallLat(s, 3, side);
      const lat = side * lerp(wr + 12, wb - 14, R());
      const r = 6 + R() * 9;
      const kind = R();
      if (kind < 0.55) {
        place(B, GEO.dome, s, lat, 1.8, r, r * 0.8, r, (v) => {
          const band = Math.abs(((v.y - 1.8) / (r * 0.8)) - 0.55) < 0.07;
          return band ? [0.16, 0.30, 0.32] : [0.86, 0.83, 0.78];
        });
        place(B, GEO.cyl, s, lat, 1.6, r * 1.05, 0.8, r * 1.05, [0.45, 0.43, 0.4]);
        const p = new THREE.Vector3(); toWorld(s, lat, 2 + r * 0.8, p);
        STATIC_GLOWS.push({ p, c: [1, 0.25, 0.15], size: 1.4, blink: R() * 6 });
        const p2 = new THREE.Vector3(); toWorld(s - r * 0.9, lat, 3, p2);
        STATIC_GLOWS.push({ p: p2, c: [1, 0.82, 0.55], size: 2.6, blink: -1 });
      } else if (kind < 0.8) {
        const h = 14 + R() * 18;
        place(B, GEO.cyl6, s, lat, 1.8 + h / 2, 0.8, h, 0.8, [0.5, 0.5, 0.5]);
        place(B, GEO.box, s, lat, 1.8 + h, 4, 1.2, 4, [0.62, 0.6, 0.56]);
        const p = new THREE.Vector3(); toWorld(s, lat, 2.8 + h, p);
        STATIC_GLOWS.push({ p, c: [1, 0.2, 0.1], size: 2.2, blink: R() * 6 });
      } else {
        // water tanks: the cargo
        place(B, GEO.cyl, s, lat, 1.8 + r * 0.45, r * 0.55, r * 0.9, r * 0.55, (v) => (Math.abs(v.y - 1.8 - r * 0.6) < 0.6 ? [0.2, 0.62, 0.66] : [0.78, 0.78, 0.76]));
      }
    }
  }
}

// --------------------------------------------------------------- materials
let terrainMat = null;
export function makeTerrainMaterial() {
  terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: strataTexture() });
  return terrainMat;
}

// --------------------------------------------------------------- chunks
export function buildChunks(scene, mat) {
  const totalSec = Math.floor((S_END - S0) / SEC);
  const chunks = [];
  for (let c0 = 0; c0 < totalSec; c0 += CH_SEC) {
    const c1 = Math.min(c0 + CH_SEC, totalSec);
    const sA = S0 + c0 * SEC, sB = S0 + c1 * SEC;
    const B = new Builder();
    addTerrain(B, c0, c1);
    for (const r of ROCKS) if (r.s >= sA && r.s < sB) addRock(B, r);
    for (const a of ARCHES) if (a.s >= sA && a.s < sB) addArch(B, a);
    for (const b of BEACONS) if (b.s >= sA && b.s < sB) {
      place(B, GEO.box, b.s, b.lat + b.side * 0.5, b.y - 0.7, 6, 1.4, 6, rockColor(b.s, b.y, 1).slice());
    }
    for (const m of MASTS) if (m.s >= sA && m.s < sB) {
      place(B, GEO.box, m.s, m.lat + m.side * 0.6, m.y - 0.6, 5, 1.2, 5, [0.36, 0.36, 0.38]);
      place(B, GEO.box, m.s, m.lat + m.side * 1.4, m.y + 2, 1, 5, 3, [0.3, 0.3, 0.32]);
    }
    if (sA <= PAD_A + 260 && sB >= -200) addSettlement(B, PAD_A, Math.max(sA, -200), Math.min(sB, PAD_A + 260), 'A');
    if (sB >= PAD_B - 260 && sA <= PAD_B + 250) addSettlement(B, PAD_B, Math.max(sA, PAD_B - 260), Math.min(sB, PAD_B + 250), 'B');
    const g = B.build();
    dustLedges(g);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat);
    mesh.matrixAutoUpdate = false;
    mesh.userData = { sA, sB };
    scene.add(mesh);
    chunks.push(mesh);
  }
  return chunks;
}

// --------------------------------------------------------------- river surface
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
uniform float uTime; uniform vec3 uSun; uniform vec3 uHorizon;
varying vec2 vUv; varying float vW; varying vec3 vWorld;
#include <fog_pars_fragment>
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
void main(){
  float t = uTime;
  vec2 p = vUv;
  vec2 q = vec2(p.x * 0.55, p.y * 0.16 - t * 2.2);
  float n2 = vn(q);
  float nx = vn(q + vec2(0.35, 0.0)) - n2;
  float nz = vn(q + vec2(0.0, 0.35)) - n2;
  float n3 = vn(vec2(p.x * 1.7, p.y * 0.5 - t * 4.0));
  vec3 N = normalize(vec3(nx * 0.45 + (n3 - 0.5) * 0.12, 1.0, nz * 0.45));
  vec3 V = normalize(cameraPosition - vWorld);
  float n1 = vn(vec2(p.x * 0.06, p.y * 0.012 - t * 0.25));
  float edge = clamp((vW - abs(p.x)) / 12.0, 0.0, 1.0);
  vec3 deep = vec3(0.02, 0.36, 0.38), shallow = vec3(0.16, 0.66, 0.60);
  vec3 col = mix(shallow, deep, edge * 0.75 + 0.25 * n1);
  float streak = smoothstep(0.55, 0.95, vn(vec2(p.x * 0.9, p.y * 0.02 - t * 1.4)));
  col += vec3(0.10, 0.16, 0.14) * streak;
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col = mix(col, uHorizon * 0.9, clamp(fres * 0.8, 0.0, 0.5));
  vec3 H = normalize(uSun + V);
  float spec = pow(max(dot(N, H), 0.0), 160.0);
  col += vec3(1.0, 0.85, 0.6) * spec * 0.9;
  float foam = smoothstep(3.0, 0.0, vW - abs(p.x)) * (0.55 + 0.45 * n3);
  col = mix(col, vec3(0.88, 0.93, 0.9), foam * 0.75);
  if (!gl_FrontFacing) col = mix(vec3(0.12, 0.55, 0.55), vec3(0.55, 0.92, 0.88), n2 * 0.6 + 0.25 * n3);
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}`;
export function makeWaterMaterial(sunDir, horizon) {
  return new THREE.ShaderMaterial({
    vertexShader: waterVS, fragmentShader: waterFS, fog: true, side: THREE.DoubleSide,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uSun: { value: sunDir.clone() }, uHorizon: { value: new THREE.Color(...horizon) },
    }]),
  });
}
export function buildWater(scene, mat) {
  const out = [];
  const step = 12, cols = 7;
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

// --------------------------------------------------------------- force-field vaults
const fieldVS = /* glsl */`
varying vec2 vUv; varying float vFog; varying vec3 vN; varying vec3 vV;
uniform float uFogD;
void main(){
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  float d = -mv.z * uFogD; vFog = exp(-d * d);
  vV = normalize(cameraPosition - wp.xyz);
  vN = normal;
  gl_Position = projectionMatrix * mv;
}`;
const fieldFS = /* glsl */`
uniform float uTime; uniform float uAlpha; uniform float uFlick;
varying vec2 vUv; varying float vFog; varying vec3 vN; varying vec3 vV;
void main(){
  vec2 p = vec2(vUv.x * 0.11, vUv.y * 0.11);
  // hex-ish cell lines
  vec2 r = vec2(1.0, 1.732);
  vec2 h = r * 0.5;
  vec2 a = mod(p, r) - h, b = mod(p - h, r) - h;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  float edge = smoothstep(0.42, 0.5, max(abs(g.x) * 0.866 + abs(g.y) * 0.5, abs(g.y)));
  float scan = 0.5 + 0.5 * sin(vUv.x * 0.05 - uTime * 2.0 + vUv.y * 0.02);
  float fres = 1.0 - abs(dot(normalize(vN), vV));
  float a1 = (0.025 + edge * 0.13 * (0.4 + 0.6 * scan) + fres * 0.08) * uAlpha * uFlick;
  vec3 col = mix(vec3(0.25, 0.85, 1.0), vec3(0.7, 1.0, 1.0), edge);
  gl_FragColor = vec4(col * a1 * vFog, 1.0);
}`;
export function buildFields(scene, fogD) {
  const geoStep = 15, arc = 14;
  for (const z of ZONES) {
    const pos = [], uv = [], ix = [];
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
        uv.push(lat + j * 0, s - z.s0);
      }
      rows++;
    }
    for (let i = 0; i < rows - 1; i++) for (let j = 0; j < arc - 1; j++) {
      const a = i * arc + j, b = a + 1, c = a + arc, d = c + 1;
      ix.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
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
uniform vec3 uSun; uniform vec3 uSun2; uniform vec3 uHor; uniform vec3 uZen;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHor, uZen, smoothstep(-0.02, 0.6, h));
  col = mix(col, uHor * 0.92, smoothstep(0.0, -0.25, h));
  // dust bands
  col *= 1.0 + 0.03 * sin(h * 60.0 + d.x * 4.0);
  float s1 = max(dot(d, uSun), 0.0);
  col += vec3(1.0, 0.6, 0.35) * pow(s1, 5.0) * 0.16 + vec3(1.0, 0.82, 0.55) * pow(s1, 60.0) * 0.35;
  col = mix(col, vec3(1.0, 0.95, 0.82), smoothstep(0.99935, 0.99955, s1));
  float s2 = max(dot(d, uSun2), 0.0);
  col += vec3(0.75, 0.86, 1.0) * (pow(s2, 300.0) * 0.7 + pow(s2, 30.0) * 0.12);
  col = mix(col, vec3(0.96, 0.99, 1.0), smoothstep(0.99988, 0.99993, s2));
  gl_FragColor = vec4(col, 1.0);
}`;
export function makeSky(sun, sun2, hor, zen) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), new THREE.ShaderMaterial({
    vertexShader: skyVS, fragmentShader: skyFS, side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: { uSun: { value: sun }, uSun2: { value: sun2 }, uHor: { value: new THREE.Color(...hor) }, uZen: { value: new THREE.Color(...zen) } },
  }));
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}
