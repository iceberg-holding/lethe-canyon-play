// Canyon spline, cross-section profile functions and procedural level layout.
// Everything is expressed in "path space": s = distance along the canyon,
// lat = lateral offset (right positive), y = height above river surface.
import { clamp, lerp, smoothstep, noise1, noise2, fbm2, rng } from './util.js';

export const S0 = -400;          // terrain starts here
export const S_END = 9700;       // terrain ends here
export const PAD_A = 60;         // settlement A landing pad
export const PAD_B = 9000;       // settlement B landing pad
export const PAD_TOP = 3.2;      // pad deck height
export const ROUTE = PAD_B - PAD_A;

const N = S_END - S0 + 2;
const CX = new Float32Array(N), CZ = new Float32Array(N), TH = new Float32Array(N);
const WR = new Float32Array(N), WB = new Float32Array(N), HR = new Float32Array(N);
const SL = new Float32Array(N), TR = new Float32Array(N), NZ = new Float32Array(N);

function thetaAt(s) {
  return 0.55 * Math.sin(s / 900 + 0.3) + 0.32 * Math.sin(s / 380 + 1.3) + 0.16 * Math.sin(s / 210 + 2.1);
}
export function basinF(s) {
  return Math.max(1 - smoothstep(200, 520, s), smoothstep(PAD_B - 480, PAD_B - 180, s));
}
export const NARROWS = [[1650, 200], [3350, 240], [5250, 180], [7150, 220]];
function narrowF(s) {
  let m = 0;
  for (const [c, l] of NARROWS) m = Math.max(m, 1 - smoothstep(l * 0.5, l * 0.5 + 120, Math.abs(s - c)));
  return m;
}

// ---- build path + profiles at 1 m resolution
{
  let x = 0, z = 0;
  for (let i = 0; i < N; i++) {
    const s = S0 + i;
    const th = thetaAt(s);
    TH[i] = th; CX[i] = x; CZ[i] = z;
    x += Math.sin(th); z -= Math.cos(th);
  }
  const i0 = -S0, ox = CX[i0], oz = CZ[i0];
  for (let i = 0; i < N; i++) {
    CX[i] -= ox; CZ[i] -= oz;
    const s = S0 + i, b = basinF(s), n = narrowF(s);
    let wr = 30 + 9 * noise1(s / 260);
    wr = lerp(lerp(wr, 16, n), 54, b);
    let wb = wr + 8 + 9 * (0.5 + 0.5 * noise1(s / 190 + 40));
    wb = lerp(lerp(wb, wr + 3, n), 125, b);
    let h = 132 + 38 * noise1(s / 520 + 80);
    h = lerp(lerp(h, 158, n), 44, b);
    WR[i] = wr; WB[i] = wb; HR[i] = Math.min(h, 166);
    SL[i] = lerp(lerp(0.2, 0.06, n), 0.35, b);
    TR[i] = lerp(lerp(1, 0.45, n), 0.5, b);
    NZ[i] = n;
  }
}

const idx = (s) => clamp(Math.round(s - S0), 0, N - 1);
export const riverHalf = (s) => WR[idx(s)];
export const wallBase = (s) => WB[idx(s)];
export const rimH = (s) => HR[idx(s)];
export const narrowAt = (s) => NZ[idx(s)];
export const maxY = (s) => Math.min(74, HR[idx(s)] - 22);

// Path frame: centre (x,z), tangent (tx,tz) pointing toward B, right vector (rx,rz).
export function frame(s, out) {
  const f = clamp(s - S0, 0, N - 1.001);
  const i = f | 0, t = f - i;
  out.x = CX[i] + (CX[i + 1] - CX[i]) * t;
  out.z = CZ[i] + (CZ[i + 1] - CZ[i]) * t;
  const th = TH[i] + (TH[i + 1] - TH[i]) * t;
  out.th = th;
  out.tx = Math.sin(th); out.tz = -Math.cos(th);
  out.rx = Math.cos(th); out.rz = Math.sin(th);
  return out;
}
const _F = { x: 0, z: 0, th: 0, tx: 0, tz: 0, rx: 0, rz: 0 };
export function toWorld(s, lat, y, v) {
  frame(s, _F);
  v.x = _F.x + _F.rx * lat; v.y = y; v.z = _F.z + _F.rz * lat;
  return v;
}
// project world point back to path space (needs a nearby guess for s)
export const proj = { s: 0, lat: 0 };
export function projectToPath(px, pz, sGuess) {
  let s = sGuess;
  for (let k = 0; k < 3; k++) {
    frame(s, _F);
    s += (px - _F.x) * _F.tx + (pz - _F.z) * _F.tz;
  }
  frame(s, _F);
  proj.s = s;
  proj.lat = (px - _F.x) * _F.rx + (pz - _F.z) * _F.rz;
  return proj;
}

// Lateral distance of the canyon wall at height y on side (-1 left, +1 right).
export function wallLat(s, y, side) {
  const i = idx(s);
  const yy = y < 3 ? 3 : y;
  const k = Math.floor(yy / 24), f = yy / 24 - k;
  const terr = (k + smoothstep(0.68, 1, f)) * 6 * TR[i];
  const amp = 1 - 0.5 * NZ[i];
  const n = fbm2(s * 0.013 + side * 91.7, yy * 0.04, 2) * 6 * amp;
  const flute = 1.6 * amp * Math.sin(s * 0.21 + side * 2 + 2.5 * noise2(s * 0.01, yy * 0.03 + side * 5));
  return WB[i] + (yy - 3) * SL[i] + terr + n + flute;
}

// ground height under a point (above the riverbed; river surface is y=0)
export function bankY(s, lat) {
  const wr = riverHalf(s), a = Math.abs(lat);
  if (a <= wr) return -100;
  const wb = wallLat(s, 3, Math.sign(lat));
  return lerp(0.4, 3, clamp((a - wr) / Math.max(1, wb - wr), 0, 1));
}

// ---------------------------------------------------------------- level layout
const R = rng(20290);
const rr = (a, b) => a + (b - a) * R();

export const ARCHES = [];
const archS = [1150, 2050, 2720, 3900, 4600, 5800, 6480, 7620, 8250];
archS.forEach((s, i) => {
  const low = i === 1 || i === 4 || i === 7;
  const yb = low ? rr(8.5, 10) : rr(24, 38);
  const th = low ? rr(10, 14) : rr(7, 11);
  const w = Math.max(wallLat(s, yb, -1), wallLat(s, yb, 1)) + 6;
  ARCHES.push({ s, yb, th, ht: rr(5, 8), w, low });
});
// bottom of an arch at lateral position lat
export function archBottom(a, lat) {
  const u = clamp(Math.abs(lat) / a.w, 0, 1);
  return a.yb * (1 - Math.pow(u, 4)) - 3 * Math.pow(u, 6);
}
export function archTop(a, lat) {
  const u = clamp(Math.abs(lat) / a.w, 0, 1);
  return a.yb + a.th + 6 * u * u;
}

export const ROCKS = [];
{
  let s = 600;
  while (s < PAD_B - 520) {
    s += rr(40, 110);
    if (ARCHES.some((a) => Math.abs(a.s - s) < 55)) continue;
    if (narrowAt(s) > 0.3) continue;
    const wr = riverHalf(s);
    const boulder = R() < 0.35;
    const r = boulder ? rr(3, 5.5) : rr(3.5, 7);
    const lat = rr(-1, 1) * (wr - r - 4);
    const h = boulder ? rr(3, 7) : (R() < 0.3 ? rr(60, 95) : rr(16, 45));
    ROCKS.push({ s, lat, r, h, boulder, seed: R() * 100 });
  }
}

// Shield zones: each one has a force-field emitter mast.
export const ZONES = [];
{
  const z0 = 520, z1 = PAD_B - 460, n = 14, len = (z1 - z0) / n;
  for (let i = 0; i < n; i++) ZONES.push({ s0: z0 + i * len, s1: z0 + (i + 1) * len, shielded: true, mast: null, collapse: 0 });
}
export function zoneAt(s) {
  for (const z of ZONES) if (s >= z.s0 && s < z.s1) return z;
  return null;
}

export const BEACONS = [];
export const DRONES = [];
export const MASTS = [];
function nearRock(s, lat, pad) {
  return ROCKS.some((r) => Math.abs(r.s - s) < r.r + pad && Math.abs(r.lat - lat) < r.r + pad);
}
ZONES.forEach((z, zi) => {
  const len = z.s1 - z.s0;
  // beacon(s) on wall ledges
  const nb = zi % 3 === 0 ? 2 : 1;
  let first = null;
  for (let b = 0; b < nb; b++) {
    const s = z.s0 + len * (0.2 + 0.45 * b) + rr(0, len * 0.15);
    const side = R() < 0.5 ? -1 : 1;
    const y = rr(7, 24);
    const lat = side * (wallLat(s, y, side) - 2.2);
    const bc = { s, y, lat, side, alive: true, phase: R() * 6 };
    BEACONS.push(bc);
    if (!first) first = bc;
  }
  // the mast sits on the same wall, just beyond the first beacon (in the line of fire)
  {
    const s = first.s + rr(24, 42);
    const y = clamp(first.y + rr(-3, 7), 6, 40);
    const side = first.side;
    const lat = side * (wallLat(s, y, side) - 0.8);
    const m = { s, y, lat, side, zone: z, alive: true, broken: 0 };
    MASTS.push(m);
    z.mast = m;
  }
  // drones
  const nd = 2 + (zi % 2);
  for (let d = 0; d < nd; d++) {
    let s = z.s0 + len * (0.12 + 0.8 * R());
    // one drone tends to hover in front of the mast wall
    let latBias = 0;
    if (d === 0) { s = z.mast.s - rr(10, 25); latBias = z.mast.side * 0.45; }
    const wr = riverHalf(s);
    let lat = clamp(latBias + rr(-0.5, 0.5), -0.75, 0.75) * wr;
    for (let k = 0; k < 6 && nearRock(s, lat, 8); k++) lat = rr(-0.7, 0.7) * wr;
    DRONES.push({ s, lat, y: rr(9, 28), amp: rr(5, 12), phase: R() * 6.28, speed: rr(0.35, 0.7), alive: true });
  }
});
BEACONS.sort((a, b) => a.s - b.s);
DRONES.sort((a, b) => a.s - b.s);

export function resetLevel() {
  for (const z of ZONES) { z.shielded = true; z.collapse = 0; }
  for (const b of BEACONS) b.alive = true;
  for (const d of DRONES) d.alive = true;
  for (const m of MASTS) { m.alive = true; m.broken = 0; }
}
