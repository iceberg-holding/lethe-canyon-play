// Canyon spline, cross-section profile functions and procedural level layout.
// Everything is expressed in "path space": s = distance along the canyon,
// lat = lateral offset (right positive), y = height above river surface.
import { clamp, lerp, smoothstep, noise1, noise2, fbm2, rng } from './util.js?v=r28';

export const S0 = -400;          // terrain starts here
export const S_END = 8750;       // terrain ends here
export const PAD_A = 60;         // settlement A landing pad
export const PAD_B = 8050;       // settlement B landing pad
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
export const NARROWS = [[1250, 200], [2620, 240], [3900, 180], [5250, 220], [6620, 200]];
// dry tributaries: side notches cut into one wall (environmental storytelling)
export const TRIBS = [{ s: 1850, side: 1, hw: 26, d: 34 }, { s: 4560, side: -1, hw: 22, d: 28 }, { s: 7080, side: 1, hw: 24, d: 30 }];
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
  let tr = 0;
  for (const t of TRIBS) {
    if (t.side !== side) continue;
    const ds = Math.abs(s - t.s);
    if (ds < t.hw + 30) tr += t.d * (1 - smoothstep(t.hw * 0.4, t.hw + 30, ds)) * (1 - smoothstep(30, 85, yy));
  }
  return WB[i] + (yy - 3) * SL[i] + terr + n + flute + tr;
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
// [s, low]: low arches can only be passed by skimming or diving under them
const archS = [[800, 0], [1450, 1], [1960, 0], [2330, 0], [3050, 0], [3460, 1], [4250, 0], [4860, 0], [5620, 1], [6120, 0], [6930, 0], [7380, 0]];
archS.forEach(([s, lw]) => {
  const low = !!lw;
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
// a crashed courier half in the water (collides like a low boulder)
export const WRECK = { s: 2960, side: -1 };
{
  const wr = riverHalf(WRECK.s);
  WRECK.lat = WRECK.side * (wr - 5);
  for (let i = ROCKS.length - 1; i >= 0; i--) if (Math.abs(ROCKS[i].s - WRECK.s) < 40) ROCKS.splice(i, 1);
  ROCKS.push({ s: WRECK.s, lat: WRECK.lat, r: 4.5, h: 4.5, boulder: true, wreck: true, seed: 0 });
  ROCKS.sort((a, b) => a.s - b.s);
}

// Round 16 finale: the LETHE gate spans the canyon ~0.5 km before settlement B. Its approach is kept clear of rock columns
// (the ship hovers in front of it while the generators are up).
export const GATE_S = PAD_B - 540, GATE_HOLD = 70, GATE_BEAM = 46;
// round 27: where the river actually has water. Upstream of RIVER_A the old main bed is dry (the river enters the
// canyon from a side cascade just past the colonists' weir at RIVER_A); downstream of the LETHE gate the bed is dry
// too — the barrier holds the river back. Pad A (start) and pad B (Typhonia, landing) both stand on the dry bed.
export const RIVER_A = 430;
export const isWet = (s) => s > RIVER_A && s < GATE_S;
for (let i = ROCKS.length - 1; i >= 0; i--) if (ROCKS[i].s > GATE_S - 150 && ROCKS[i].s < GATE_S + 40) ROCKS.splice(i, 1);

// Round 18: checkpoints along the canyon (the start counts as checkpoint 0). Chosen clear of arches, just past the
// boats; the respawn lane (s-30 .. s+140) is cleared of rocks so a respawn never lands in a boulder.
export const CHECKPOINTS = [300, 1650, 3300, 4950, 6450, GATE_S - 360];

// Shield zones: each one has a force-field emitter mast.
export const ZONES = [];
{
  const z0 = 520, z1 = PAD_B - 460, n = 13, len = (z1 - z0) / n;
  for (let i = 0; i < n; i++) ZONES.push({ s0: z0 + i * len, s1: z0 + (i + 1) * len, shielded: true, mast: null, collapse: 0, relays: [], idx: i });
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
  // LETHE relay(s) ("beacons") on wall ledges: they pass the drones' mark to this zone's rim turrets (round 5)
  const nb = zi % 3 === 0 ? 2 : 1;
  let first = null;
  for (let b = 0; b < nb; b++) {
    const s = z.s0 + len * (0.2 + 0.45 * b) + rr(0, len * 0.15);
    const side = R() < 0.5 ? -1 : 1;
    const y = rr(7, 24);
    const lat = side * (wallLat(s, y, side) - 2.2);
    const bc = { s, y, lat, side, alive: true, phase: R() * 6, zone: z };
    BEACONS.push(bc);
    z.relays.push(bc);
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

// LETHE rim turrets: upper-ledge emplacements near the drone sections
export const TURRETS = [];
ZONES.forEach((z, zi) => {
  const len = z.s1 - z.s0, nt = zi % 2 ? 2 : 1;
  for (let k = 0; k < nt; k++) {
    const s = z.s0 + len * (nt === 1 ? rr(0.45, 0.7) : (k ? rr(0.65, 0.85) : rr(0.2, 0.4)));
    const side = R() < 0.5 ? -1 : 1;
    const y = clamp(rimH(s) - rr(55, 75), 52, 80);
    const lat = side * (wallLat(s, y, side) - 1.2);
    TURRETS.push({ s, y, lat, side, alive: true, cd: rr(2, 6), zone: z, relays: z.relays });
  }
});
TURRETS.sort((a, b) => a.s - b.s);
// Round 17: tutorial-by-play. Threats are introduced one at a time before they are combined:
//   zone 0 = drones only (no rim turret), pulled in front of the first boat so the boat tutorial gets a clean stage;
//   zone 1 = one rim turret alone (no drones) after the boat; from zone 2 on, the regular mix.
// Applied as a post-filter so the seeded layout of every other zone stays exactly as before.
{
  const z0 = ZONES[0], z1 = ZONES[1];
  const z1t = TURRETS.filter((t) => t.zone === z1);
  const keepT = z1t[z1t.length - 1];
  for (let i = TURRETS.length - 1; i >= 0; i--) { const t = TURRETS[i]; if (t.zone === z0 || (t.zone === z1 && t !== keepT)) TURRETS.splice(i, 1); }
  for (let i = DRONES.length - 1; i >= 0; i--) if (DRONES[i].s >= z1.s0 && DRONES[i].s < z1.s1) DRONES.splice(i, 1);
  const d0 = DRONES.filter((d) => d.s >= z0.s0 && d.s < z0.s1);
  for (let k = 1; k < d0.length; k++) {
    const d = d0[k], ns = d0[0].s - 70 * k;
    d.lat *= riverHalf(ns) / riverHalf(d.s); d.s = ns;
  }
  DRONES.sort((a, b) => a.s - b.s);
}
// a section stays linked while any of its relays stands; a zone without relays (none in this layout) is always linked
export const zoneLinked = (z) => !z || !z.relays.length || z.relays.some((r) => r.alive);

// set dressing positions (static, merged into chunk meshes)
export const DRESS = { cables: [], ruins: [], signs: [], markers: [] };
for (let s = 700; s < PAD_B - 400; s += rr(520, 820)) DRESS.cables.push({ s, y: rr(84, 110), sag: rr(8, 16), s2: s + rr(-30, 30) });
for (let s = 420; s < PAD_B - 400; s += rr(320, 560)) {
  if (narrowAt(s) > 0.2) continue;
  DRESS.ruins.push({ s, side: R() < 0.5 ? -1 : 1, kind: R() < 0.5 ? 'tower' : 'condenser', h: rr(16, 34), seed: R() });
}
ZONES.forEach((z) => DRESS.signs.push({ s: z.s0 + 25, side: z.mast ? -z.mast.side : 1 }));
for (let s = 300; s < PAD_B - 300; s += rr(140, 260)) DRESS.markers.push({ s, side: R() < 0.5 ? -1 : 1 });
// story props: a scorched turret wreck and a mast broken on a previous run
DRESS.scorched = { s: 2250, side: 1 };
DRESS.oldMast = { s: 3520, side: -1 };
DRESS.scorched2 = { s: 6380, side: -1 };
// pipeline on stilts along the left bank
DRESS.pipe = { s0: 150, s1: PAD_B - 120, side: -1, y: 7.5 };

// ---------------------------------------------------------------- naval layer (round 4)
// riverbed height under (s, lat): matches the terrain cross-section profile in terrain.js
export function bedY(s, lat) {
  const wr = riverHalf(s), a = Math.abs(lat) / wr;
  if (a < 0.45) return -10.5;
  if (a < 0.8) return lerp(-10.5, -7, (a - 0.45) / 0.35);
  if (a < 0.95) return lerp(-7, -2.5, (a - 0.8) / 0.15);
  return lerp(-2.5, 0.4, clamp((a - 0.95) / 0.05, 0, 1));
}
// lateral limit of the ship while submerged (see updateFlight)
export const underLim = (s) => riverHalf(s) * 0.8 - 3;

// Tethered naval mines: clusters in the dive sections (the three low arches) and open stretches under turret cover.
// [s0, s1, count]; a staggered slalom across the river, mixed depths (≈ 1/3 just under the surface: they threaten
// skimming too).
export const MINES = [];
// round 27: +9 mines (36 -> 45): one more in each field, plus a small open-river field after checkpoint 4 (4950)
const MINE_FIELDS = [[1375, 1525, 7], [2140, 2290, 6], [3385, 3545, 8], [4360, 4500, 6], [5010, 5130, 3], [5545, 5700, 9], [7140, 7290, 6]];
const R2 = rng(4404);
const r2 = (a, b) => a + (b - a) * R2();
for (const [s0, s1, n] of MINE_FIELDS) {
  const len = s1 - s0;
  for (let i = 0; i < n; i++) {
    const s = s0 + (i + 0.5) * (len / n) + r2(-6, 6);
    const lim = underLim(s) - 1.5;
    let lat = (((i * 2) % 3) - 1) * lim * 0.62 + r2(-3, 3);
    lat = clamp(lat, -lim, lim);
    for (let k = 0; k < 6 && nearRock(s, lat, 5); k++) lat = r2(-lim, lim);
    const shallow = R2() < 0.36;
    const y = shallow ? r2(-1.6, -1.05) : r2(-6.2, -2.0);
    MINES.push({ s, lat, y, phase: R2() * 6.28, alive: true, fuse: 0 });
  }
}
MINES.sort((a, b) => a.s - b.s);

// LETHE hunter-subs: small torpedo drones that live underwater in three deep sections.
export const HUNTERS = [];
for (const [s0, n] of [[3470, 2], [5590, 3], [6960, 2]]) {
  for (let i = 0; i < n; i++) {
    const s = s0 + 40 + i * 70 + r2(-10, 10);
    HUNTERS.push({ s, home: s, lat: r2(-0.4, 0.4) * underLim(s), y: r2(-6, -3.5), phase: R2() * 6.28, alive: true });
  }
}

// Boats on the surface: smuggler rivals (rusty, orange lights) and Council patrol boats (grey-white, blue lights).
// They cruise slowly back and forth around a home position; lanes avoid rock columns.
export const BOATS = [];
for (const [s, type, dir] of [[1020, 'smuggler', 1], [3200, 'patrol', -1], [4700, 'smuggler', -1], [6280, 'patrol', 1]]) {
  const wr = riverHalf(s);
  let lat = 0, best = 1e9;
  for (let c = -0.55; c <= 0.551; c += 0.05) {
    const l = c * wr;
    let cost = Math.abs(c) * 2;
    for (const r of ROCKS) if (Math.abs(r.s - s) < 200 && Math.abs(r.lat - l) < r.r + 7) cost += 10;
    if (cost < best) { best = cost; lat = l; }
  }
  BOATS.push({ s, home: s, lat, lat0: lat, type, dir, dir0: dir, speed: type === 'patrol' ? 6 : 4.5, alive: true });
}
// Round 15: the two later boats (not the tutorial pair) sit over a short mine slalom.
// Mines are moved out of the dense field so the river still holds 36. The hull's centerline
// stays clear for the belly shot; the approach itself is not a straight dive.
const laterBoats = BOATS.filter((b) => b.home > 4000);
const mineDonors = MINES.filter((m) => m.s >= 5545 && m.s <= 5700).sort((a, b) => b.s - a.s);
let mineDonor = 0;
for (const boat of laterBoats) {
  for (const [ds, dl, y] of [[-64, 0.6, -3.15], [-30, -12, -3.7]]) {
    const m = mineDonors[mineDonor++];
    if (!m) break;
    const s = boat.home + ds;
    const lim = underLim(s) - 1.5;
    let lat = clamp(boat.lat + dl, -lim, lim);
    for (let k = 0; k < 6 && nearRock(s, lat, 4); k++) lat = clamp(boat.lat + dl + (k % 2 ? 4 : -4), -lim, lim);
    m.s = s; m.lat = lat; m.y = y;
  }
}
MINES.sort((a, b) => a.s - b.s);

export function resetLevel() {
  for (const z of ZONES) { z.shielded = true; z.collapse = 0; }
  for (const b of BEACONS) b.alive = true;
  for (const d of DRONES) d.alive = !d.debug;
  for (const m of MASTS) { m.alive = true; m.broken = 0; }
  for (const t of TURRETS) { t.alive = true; t.cd = 2 + Math.random() * 4; }
  // (debug spawn slots stay dead)
  for (const m of MINES) { m.alive = !m.debug; m.fuse = 0; }
  for (const h of HUNTERS) { h.alive = !h.debug; h.s = h.home; }
  for (const b of BOATS) { b.alive = !b.debug; b.s = b.home; b.lat = b.lat0; b.dir = b.dir0; }
}

// round 18: clear the checkpoint respawn lanes of rocks (after all seeded placement, so the rest of the layout is unchanged)
for (const c of CHECKPOINTS) for (let i = ROCKS.length - 1; i >= 0; i--) if (ROCKS[i].s > c - 30 && ROCKS[i].s < c + 140) ROCKS.splice(i, 1);
