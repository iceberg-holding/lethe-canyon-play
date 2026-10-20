// LETHE / ЛЕТА — "Delivery" prototype. Game loop, flight model, shooting, hazards, HUD.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, lerp, damp, smoothstep } from './util.js';
import {
  PAD_A, PAD_B, PAD_TOP, ROUTE, frame, toWorld, projectToPath, wallLat, riverHalf, bankY, maxY,
  ARCHES, ROCKS, ZONES, BEACONS, DRONES, MASTS, archBottom, archTop, zoneAt, resetLevel,
} from './world.js';
import { buildChunks, buildWater, buildFields, makeSky, makeTerrainMaterial, makeWaterMaterial, STATIC_GLOWS } from './terrain.js';
import { Glows, Particles, Streaks } from './fx.js';
import { Ship } from './ship.js';
import { Audio } from './audio.js';
import { input, setupInput, pollInput } from './input.js';

THREE.ColorManagement.enabled = false;
const params = new URLSearchParams(location.search);
const AUTOPILOT = params.get('autopilot') === '1';
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
document.body.classList.toggle('touch', isTouch);

// ------------------------------------------------------------------ renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: !isTouch, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouch ? 1.5 : 1.75));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

const HOR = [0.93, 0.62, 0.46], ZEN = [0.6, 0.36, 0.3];
const FOG_AIR = new THREE.Color(0.88, 0.58, 0.44), FOG_WATER = new THREE.Color(0.02, 0.22, 0.24);
const FOG_D_AIR = 0.0019, FOG_D_WATER = 0.04;
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG_AIR.clone(), FOG_D_AIR);
scene.background = FOG_AIR.clone();
const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.4, 2200);

const SUN = new THREE.Vector3(0.3, 0.33, -0.9).normalize();
const SUN2 = new THREE.Vector3(-0.2, 0.47, -0.86).normalize();
const hemi = new THREE.HemisphereLight(0xffb48c, 0x6a2e1c, 1.9);
scene.add(hemi);
const sunL = new THREE.DirectionalLight(0xffd2a0, 2.6);
sunL.position.copy(SUN).multiplyScalar(100);
scene.add(sunL);
const sun2L = new THREE.DirectionalLight(0xbfd8ff, 0.7);
sun2L.position.copy(SUN2).multiplyScalar(100);
scene.add(sun2L);

const sky = makeSky(SUN, SUN2, HOR, ZEN);
scene.add(sky);

const terrainMat = makeTerrainMaterial();
const chunks = buildChunks(scene, terrainMat);
const waterMat = makeWaterMaterial(SUN, HOR);
const waters = buildWater(scene, waterMat);
buildFields(scene, FOG_D_AIR);

const glows = new Glows(700, FOG_D_AIR);
scene.add(glows.obj);
const sparks = new Particles(900, true, FOG_D_AIR);
scene.add(sparks.obj);
const mist = new Particles(1100, false, FOG_D_AIR);
scene.add(mist.obj);
const streaks = new Streaks();
scene.add(streaks.obj);

const ship = new Ship();
scene.add(ship.group);

// ------------------------------------------------------------------ targets (instanced)
function colored(g, c) {
  g = g.clone();
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set(c, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
const tr = (g, x, y, z, rx = 0, ry = 0, rz = 0) => g.rotateX(rx).rotateY(ry).rotateZ(rz).translate(x, y, z);
const lambertVC = new THREE.MeshLambertMaterial({ vertexColors: true });
const droneGeo = mergeGeometries([
  colored(new THREE.SphereGeometry(1.15, 10, 7).scale(1, 0.62, 1.2), [0.62, 0.63, 0.64]),
  colored(tr(new THREE.TorusGeometry(2.0, 0.2, 5, 18), 0, 0, 0, Math.PI / 2), [0.2, 0.2, 0.22]),
  colored(tr(new THREE.CylinderGeometry(1.18, 1.18, 0.22, 12), 0, 0.05, 0), [0.9, 0.48, 0.12]),
  colored(tr(new THREE.BoxGeometry(4.2, 0.12, 0.3), 0, 0, 0), [0.25, 0.25, 0.27]),
  colored(tr(new THREE.BoxGeometry(0.3, 0.12, 4.2), 0, 0, 0), [0.25, 0.25, 0.27]),
  colored(tr(new THREE.ConeGeometry(0.5, 0.9, 8), 0, -0.9, 0, Math.PI), [0.3, 0.3, 0.32]),
]);
const drones = new THREE.InstancedMesh(droneGeo, lambertVC, DRONES.length);
drones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
drones.frustumCulled = false;
scene.add(drones);

const beaconGeo = mergeGeometries([
  colored(tr(new THREE.CylinderGeometry(0.22, 0.3, 4, 6), 0, 2, 0), [0.22, 0.22, 0.24]),
  colored(tr(new THREE.BoxGeometry(1.1, 0.9, 1.1), 0, 4.2, 0), [0.55, 0.42, 0.25]),
  colored(tr(new THREE.CylinderGeometry(0.8, 1, 0.5, 6), 0, 0.25, 0), [0.3, 0.3, 0.3]),
  colored(tr(new THREE.BoxGeometry(0.08, 1.6, 0.08), 0.3, 5.3, 0), [0.15, 0.15, 0.15]),
]);
const beacons = new THREE.InstancedMesh(beaconGeo, lambertVC, BEACONS.length);
scene.add(beacons);

const MAST_LEN = 12, MAST_LEAN = 0.44;
const mastGeo = mergeGeometries([
  colored(tr(new THREE.CylinderGeometry(0.32, 0.55, MAST_LEN, 6), 0, MAST_LEN / 2, 0), [0.62, 0.64, 0.68]),
  colored(tr(new THREE.CylinderGeometry(0.9, 0.9, 0.5, 8), 0, 0.3, 0), [0.3, 0.3, 0.32]),
  colored(tr(new THREE.TorusGeometry(1.25, 0.22, 6, 14), 0, MAST_LEN - 1.2, 0, Math.PI / 2), [0.35, 0.95, 1.0]),
  colored(tr(new THREE.TorusGeometry(0.9, 0.18, 6, 14), 0, MAST_LEN - 2.6, 0, Math.PI / 2), [0.35, 0.95, 1.0]),
  colored(tr(new THREE.ConeGeometry(0.3, 2.2, 6), 0, MAST_LEN + 1, 0), [0.8, 0.82, 0.86]),
  colored(tr(new THREE.BoxGeometry(0.1, 3, 1.4), 0, 5, 0), [0.85, 0.55, 0.15]),
]);
const masts = new THREE.InstancedMesh(mastGeo, lambertVC, MASTS.length);
scene.add(masts);

const F = { x: 0, z: 0, th: 0, tx: 0, tz: 0, rx: 0, rz: 0 };
const SF = { x: 0, z: 0, th: 0, tx: 0, tz: 0, rx: 0, rz: 0 }; // ship frame
const V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3();
const M1 = new THREE.Matrix4(), M2 = new THREE.Matrix4(), Q1 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
function pathBasis(s, m) {
  frame(s, F);
  V1.set(F.rx, 0, F.rz); V2.set(-F.tx, 0, -F.tz);
  return m.makeBasis(V1, UP, V2);
}
function placeStatic() {
  BEACONS.forEach((b, i) => {
    pathBasis(b.s, M1); toWorld(b.s, b.lat, b.y, V3); M1.setPosition(V3);
    beacons.setMatrixAt(i, b.alive ? M1 : ZERO_M);
    b.wp = toWorld(b.s, b.lat, b.y + 4.2, new THREE.Vector3());
    b.wp2 = toWorld(b.s, b.lat, b.y + 2, new THREE.Vector3());
  });
  beacons.instanceMatrix.needsUpdate = true;
  MASTS.forEach((m, i) => setMastMatrix(m, i));
}
function setMastMatrix(m, i) {
  pathBasis(m.s, M1); toWorld(m.s, m.lat, m.y, V3); M1.setPosition(V3);
  const lean = m.alive ? MAST_LEAN : MAST_LEAN + 0.9;
  M1.multiply(M2.makeRotationZ(m.side * lean));
  if (!m.alive) M1.multiply(M2.makeScale(1, 0.45, 1));
  masts.setMatrixAt(i, M1);
  masts.instanceMatrix.needsUpdate = true;
  const dl = -m.side * Math.sin(MAST_LEAN), dy = Math.cos(MAST_LEAN);
  m.pts = [0.35, 0.65, 0.92].map((t) => toWorld(m.s, m.lat + dl * MAST_LEN * t, m.y + dy * MAST_LEN * t, new THREE.Vector3()));
  m.top = m.pts[2];
}
for (const d of DRONES) d.wp = new THREE.Vector3();

// ------------------------------------------------------------------ bolts
const BOLT_SPEED = 430, BOLT_LIFE = 0.55, BOLT_N = 48;
const boltMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.22, 7), new THREE.MeshBasicMaterial({
  color: 0xffc070, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), BOLT_N);
boltMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
boltMesh.frustumCulled = false;
scene.add(boltMesh);
const bolts = [];
for (let i = 0; i < BOLT_N; i++) bolts.push({ on: false, p: new THREE.Vector3(), q: new THREE.Vector3(), d: new THREE.Vector3(), life: 0, s: 0 });

// ------------------------------------------------------------------ audio / input / HUD refs
const audio = new Audio();
setupInput(renderer.domElement);
const $ = (id) => document.getElementById(id);
const hud = {
  root: $('hud'), cargo: $('tCargo'), health: $('tHealth'), rad: $('tRad'), score: $('tScore'), speed: $('tSpeed'), dist: $('tDist'),
  bCargo: $('bCargo').firstElementChild, bHealth: $('bHealth').firstElementChild, bRad: $('bRad').firstElementChild,
  bAir: $('bAir').firstElementChild, air: $('tAir'), airBox: $('airBox'), msg: $('msg'), pop: $('pop'),
  routeShip: $('routeShip'), reticle: $('reticle'), tintUnder: $('tintUnder'), tintRad: $('tintRad'), tintHit: $('tintHit'),
  dive: $('btnDive'),
};
const zoneEls = ZONES.map((z) => {
  const el = document.createElement('div');
  el.className = 'z';
  el.style.left = ((z.s0 - PAD_A) / ROUTE) * 100 + '%';
  el.style.width = ((z.s1 - z.s0) / ROUTE) * 100 - 0.4 + '%';
  $('routeBar').appendChild(el);
  return el;
});

// ------------------------------------------------------------------ game state
let G;
function freshState() {
  return {
    phase: 'start', t: 0, s: PAD_A, lat: 0, y: PAD_TOP + 1.7, vLat: 0, vY: 0, speed: 0, boost: 0,
    cargo: 100, health: 100, air: 60, score: 0, dive: false, underwater: false, hitCd: 0, rad: 0,
    yaw: 0, pitch: 0, roll: 0, phaseT: 0, fireCd: 0, gun: 0, shake: 0, hitFlash: 0,
    kills: 0, mastsBroken: 0, outcome: null, reason: '', finalScore: 0, wasUnder: false, lastZone: null,
    msgT: 0, popT: 0, beepT: 0, airOut: false,
  };
}
G = freshState();
resetLevel();
placeStatic();

const shipPos = new THREE.Vector3(), shipFwd = new THREE.Vector3(), shipVel = new THREE.Vector3();
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), camOff = new THREE.Vector3();
let camInit = false, camUnder = false;

function showMsg(en, ru, dur = 2.2, color = '#ffe2c2') {
  hud.msg.innerHTML = `${en}<small>${ru}</small>`;
  hud.msg.style.color = color;
  hud.msg.style.opacity = 1;
  G.msgT = dur;
}
function popScore(text) {
  hud.pop.textContent = text;
  hud.pop.style.opacity = 1;
  hud.pop.style.transform = 'translate(-50%,-50%) scale(1.15)';
  G.popT = 0.9;
}

// ------------------------------------------------------------------ effects helpers
function explode(p, big = 1, cold = false) {
  for (let i = 0; i < 40 * big; i++) {
    const a = Math.random() * 6.28, e = Math.random() * 2 - 1, v = (8 + Math.random() * 22) * big;
    const c = Math.sqrt(1 - e * e);
    sparks.emit(p.x, p.y, p.z, Math.cos(a) * c * v, e * v, Math.sin(a) * c * v, 0.4 + Math.random() * 0.5, 3 * big, 0.8,
      cold ? 0.4 : 1, cold ? 0.9 : 0.55 + Math.random() * 0.3, cold ? 1 : 0.15, 1, 6, 2.5);
  }
  for (let i = 0; i < 18 * big; i++) {
    const v = 30 + Math.random() * 40;
    sparks.emit(p.x, p.y, p.z, (Math.random() - 0.5) * v, (Math.random() - 0.2) * v, (Math.random() - 0.5) * v, 0.6 + Math.random() * 0.6, 0.9, 0.3, 1, 0.85, 0.5, 1, 30, 1);
  }
  for (let i = 0; i < 10 * big; i++) {
    mist.emit(p.x + (Math.random() - 0.5) * 3, p.y + (Math.random() - 0.5) * 3, p.z + (Math.random() - 0.5) * 3,
      (Math.random() - 0.5) * 5, 2 + Math.random() * 3, (Math.random() - 0.5) * 5, 1.4 + Math.random(), 3, 9 * big, 0.25, 0.2, 0.18, 0.55, -1, 0.8);
  }
  G.flash = { p: p.clone(), t: 0.25, big, cold };
}
function sparkBurst(p, n, col = [1, 0.75, 0.35]) {
  for (let i = 0; i < n; i++) {
    const v = 10 + Math.random() * 25;
    sparks.emit(p.x, p.y, p.z, (Math.random() - 0.5) * v, Math.random() * v * 0.7, (Math.random() - 0.5) * v, 0.3 + Math.random() * 0.4, 0.8, 0.2, col[0], col[1], col[2], 1, 25, 1);
  }
}
function splash(p, n = 90, strength = 1) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.28, r = Math.random();
    const v = (4 + r * 10) * strength;
    mist.emit(p.x + Math.cos(a) * 2, 0.2, p.z + Math.sin(a) * 2, Math.cos(a) * v, (8 + Math.random() * 14) * strength, Math.sin(a) * v,
      0.8 + Math.random() * 0.8, 0.8, 3.5, 0.85, 0.96, 0.95, 0.85, 20, 0.6);
  }
  for (let i = 0; i < n / 3; i++) {
    mist.emit(p.x + (Math.random() - 0.5) * 6, 0.5 + Math.random() * 2, p.z + (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 4,
      1.4 + Math.random(), 3, 9, 0.85, 0.93, 0.92, 0.35, 0, 1);
  }
}

// ------------------------------------------------------------------ damage
function hitCargo(dmg, p) {
  if (G.hitCd > 0 || G.phase === 'result' || G.phase === 'failed') return;
  G.hitCd = 0.45;
  G.cargo = Math.max(0, G.cargo - dmg);
  G.shake = Math.min(1.4, G.shake + 0.5 + dmg * 0.04);
  G.hitFlash = 1;
  G.speed *= 0.8;
  sparkBurst(p || shipPos, 30);
  audio.hit();
  if (G.cargo <= 0) fail('CARGO TANK BREACHED', 'ЦИСТЕРНА ПРОБИТА');
  else if (G.cargo < 30) showMsg('CARGO CRITICAL', 'ГРУЗ НА ИСХОДЕ', 1.4, '#ff8a5a');
}
function fail(en, ru) {
  if (G.phase === 'failed' || G.phase === 'result') return;
  G.phase = 'failed'; G.phaseT = 0; G.outcome = 'failed'; G.reason = en + ' / ' + ru;
  G.dive = false;
  showMsg('MISSION FAILED', 'МИССИЯ ПРОВАЛЕНА', 3, '#ff7a5a');
  explode(shipPos, 0.8);
  audio.explosion(1.2);
}

// ------------------------------------------------------------------ flight
const SHIP_R = 3.2;
function toggleDive() {
  if (G.phase !== 'flight') return;
  if (!G.dive && G.air < 3) { showMsg('NO AIR', 'НЕТ ВОЗДУХА', 1.2, '#7ff'); return; }
  G.dive = !G.dive;
  audio.dive();
}

let autoFire = false;
function autopilot() {
  const look = 170;
  const wr = riverHalf(G.s + 60);
  let ty = 11, needDive = false;
  for (const a of ARCHES) {
    const d = a.s - G.s;
    if (d < -10 || d > 220) continue;
    const bot = archBottom(a, G.lat);
    if (bot > 16) ty = Math.min(ty, bot - 6);
    else if (bot > 7) ty = Math.min(ty, 2.5);
    else needDive = true;
  }
  let best = G.lat, bestC = 1e9;
  for (let c = -0.75; c <= 0.751; c += 0.075) {
    const lat = c * wr;
    let cost = Math.abs(lat - G.lat) * 0.03 + Math.abs(c) * 0.5;
    for (const r of ROCKS) {
      if (r.s < G.s - 8 || r.s > G.s + look) continue;
      if (r.h < ty - 3) continue;
      if (Math.abs(r.lat - lat) < r.r + 8) cost += 100 * (1 - (r.s - G.s) / (look * 1.5));
    }
    for (const k of [20, 60, 110, 160]) {
      const yy = Math.max(ty, 3);
      if (lat > wallLat(G.s + k, yy, 1) - 9 || -lat > wallLat(G.s + k, yy, -1) - 9) cost += 60;
    }
    if (cost < bestC) { bestC = cost; best = lat; }
  }
  input.x = clamp((best - G.lat) * 0.12 - G.vLat * 0.04, -1, 1);
  input.y = clamp((ty - G.y) * 0.2 - G.vY * 0.05, -1, 1);
  if (needDive !== G.dive && G.phase === 'flight') toggleDive();
  if (G.dive && G.y < -1) input.y = clamp((-5 - G.y) * 0.3, -1, 1);
  input.boost = !G.dive;
  input.fire = autoFire;
}

function updateFlight(dt) {
  const ctl = G.phase === 'flight';
  if (AUTOPILOT && ctl) autopilot();
  let ix = ctl ? input.x : 0, iy = ctl ? input.y : 0;
  if (ctl && input.consumeDive()) toggleDive();
  else input.consumeDive();
  const boosting = ctl && input.boost && !G.dive;
  G.boost += ((boosting ? 1 : 0) - G.boost) * damp(3, dt);

  if (G.phase === 'takeoff') {
    const t = G.phaseT;
    G.y = PAD_TOP + 1.7 + smoothstep(0.3, 2.6, t) * 9;
    G.speed = smoothstep(0.9, 2.8, t) * 45;
    if (t > 2.8) { G.phase = 'flight'; showMsg('FLY TO SETTLEMENT B', 'ЛЕТИТЕ В ПОСЕЛЕНИЕ Б', 2.4); }
  } else if (G.phase === 'landing') {
    const rem = PAD_B - G.s;
    const ts = rem > 0.5 ? clamp(rem * 0.32, 4, 64) : 0;
    G.speed += (ts - G.speed) * damp(2.2, dt);
    G.vLat = (0 - G.lat) * 1.2;
    const ty = rem > 30 ? 11 : PAD_TOP + 1.7;
    G.vY = clamp((ty - G.y) * 1.4, -6, 10);
    if (rem <= 0.6) { G.s = PAD_B; G.speed = 0; }
    if (rem < 1.2 && Math.abs(G.y - (PAD_TOP + 1.7)) < 0.25 && G.phaseT > 1) {
      G.phase = 'landed'; G.phaseT = 0; G.outcome = 'delivered';
      showMsg('TOUCHDOWN — CARGO DELIVERED', 'ПОСАДКА — ГРУЗ ДОСТАВЛЕН', 3, '#9ff2d8');
    }
  } else if (G.phase === 'landed') {
    G.speed = 0; G.vLat = 0; G.vY = 0; G.y += (PAD_TOP + 1.7 - G.y) * damp(4, dt);
  } else if (G.phase === 'failed') {
    G.speed *= Math.exp(-dt * 0.9);
    G.vLat *= Math.exp(-dt * 2);
    G.vY = G.y > 1.5 ? -6 : 0;
    if (Math.random() < 0.6) mist.emit(shipPos.x, shipPos.y + 1, shipPos.z, 0, 4, 0, 1.6, 2, 7, 0.2, 0.18, 0.17, 0.5, -1, 0.5);
  } else if (G.phase === 'flight') {
    const target = G.dive ? 34 : 62 + 32 * G.boost;
    G.speed += (target - G.speed) * damp(boosting ? 1.3 : 0.9, dt);
    const latMax = G.dive ? 15 : 30;
    G.vLat += (ix * latMax - G.vLat) * damp(5, dt);
    let vYt;
    if (G.dive) vYt = G.y > -2 ? -20 : iy * 7;
    else vYt = G.y < 0.9 ? 16 : iy * 20;
    G.vY += (vYt - G.vY) * damp(6, dt);
    if (G.s > PAD_B - 330) { G.phase = 'landing'; G.phaseT = 0; G.dive = false; showMsg('SETTLEMENT B — AUTO-LANDING', 'ПОСЕЛЕНИЕ Б — АВТОПОСАДКА', 2.5, '#9ff2d8'); }
  }

  G.s += G.speed * dt;
  G.lat += G.vLat * dt;
  if (G.phase !== 'takeoff' && G.phase !== 'landed') G.y += G.vY * dt;

  // vertical limits
  if (G.phase === 'flight' || G.phase === 'failed') {
    const wr = riverHalf(G.s);
    if (G.dive || G.y < -0.5) {
      const lim = wr * 0.8 - 3;
      if (Math.abs(G.lat) > lim) { G.lat += (Math.sign(G.lat) * lim - G.lat) * damp(6, dt); G.vLat *= 0.9; }
      if (G.y < -8.5) { G.y = -8.5; G.vY = Math.max(G.vY, 0); }
      if (G.dive && G.y < -1.8 && G.y > -2.4 && G.vY > 0) { G.y = -2.4; G.vY = 0; }
    }
    if (!G.dive && G.y > 0.9) {
      const minY = Math.max(1.2, bankY(G.s, G.lat) + 1.7);
      if (G.y < minY) { G.y = minY; G.vY = Math.max(0, G.vY); }
    }
    const my = maxY(G.s);
    if (G.y > my) { G.y += (my - G.y) * damp(4, dt); G.vY = Math.min(G.vY, 0); }
  }
  collide(dt);
}

function collide(dt) {
  if (G.phase === 'takeoff' || G.phase === 'landed') return;
  // canyon walls
  const yy = Math.max(G.y, 3);
  for (const side of [-1, 1]) {
    const wl = wallLat(G.s + 4, yy, side) - SHIP_R;
    if (side * G.lat > wl) {
      const impact = Math.max(0, side * G.vLat);
      G.lat = side * wl;
      G.vLat = -side * (impact * 0.35 + 7);
      frame(G.s, SF);
      V1.copy(shipPos).addScaledVector(V2.set(SF.rx, 0, SF.rz), side * SHIP_R);
      hitCargo(clamp(4 + impact * 0.35 + G.speed * 0.03, 4, 16), V1);
    }
  }
  // rock columns
  for (const r of ROCKS) {
    const ds = G.s - r.s;
    if (ds < -r.r - 6 || ds > r.r + 6) continue;
    if (G.y > r.h + 1) continue;
    const dl = G.lat - r.lat, rr = r.r * 0.92 + SHIP_R;
    const d2 = ds * ds + dl * dl;
    if (d2 < rr * rr) {
      const d = Math.sqrt(d2) || 1;
      if (ds < 0 && Math.abs(dl) < rr * 0.7) {
        // head-on: bounce back
        G.s = r.s - Math.sqrt(Math.max(0, rr * rr - dl * dl)) - 0.1;
        G.lat += Math.sign(dl || 1) * 1.5;
        G.vLat = Math.sign(dl || 1) * 14;
        G.speed *= 0.55;
      } else {
        G.lat = r.lat + (dl / d) * rr;
        G.vLat = Math.sign(dl) * 12;
      }
      hitCargo(9 + G.speed * 0.06);
    }
  }
  // arches
  for (const a of ARCHES) {
    const ds = G.s - a.s;
    if (Math.abs(ds) > a.ht + 3) continue;
    const bot = archBottom(a, G.lat), top = archTop(a, G.lat);
    if (G.y > bot - 1.3 && G.y < top + 1.4) {
      if (ds < -a.ht + 1 && G.y < top) {
        G.s = a.s - a.ht - 3.1; G.speed *= 0.45;
      }
      if (G.y < (bot + top) / 2) { G.y = bot - 1.4; G.vY = -6; } else { G.y = top + 1.5; G.vY = 6; }
      hitCargo(12);
    }
  }
}

// ------------------------------------------------------------------ shooting
function fire() {
  G.fireCd = 0.13;
  const m = ship.muzzles[G.gun];
  G.gun ^= 1;
  ship.body.updateMatrixWorld();
  const p = ship.body.localToWorld(V1.copy(m));
  let dir = V2.copy(shipFwd);
  // gentle aim assist toward drones / beacons only (never masts)
  let best = null, bestA = 0.075;
  const consider = (wp) => {
    V3.copy(wp).sub(p);
    const d = V3.length();
    if (d < 15 || d > 240) return;
    const a = Math.acos(clamp(V3.dot(shipFwd) / d, -1, 1));
    if (a < bestA) { bestA = a; best = wp; }
  };
  for (const d of DRONES) if (d.alive && Math.abs(d.s - G.s) < 260) consider(d.wp);
  for (const b of BEACONS) if (b.alive && Math.abs(b.s - G.s) < 260) consider(b.wp);
  if (best) dir = V2.copy(best).sub(p).normalize();
  const b = bolts.find((x) => !x.on);
  if (!b) return;
  b.on = true; b.p.copy(p); b.q.copy(p); b.d.copy(dir); b.life = BOLT_LIFE; b.s = G.s;
  sparks.emit(p.x, p.y, p.z, shipVel.x, shipVel.y, shipVel.z, 0.06, 3.5, 2, 1, 0.75, 0.35, 1);
  audio.shot();
}
function segSphere(a, b, c, r) {
  // distance from c to segment ab
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz || 1;
  const t = clamp(((c.x - a.x) * abx + (c.y - a.y) * aby + (c.z - a.z) * abz) / l2, 0, 1);
  const dx = a.x + abx * t - c.x, dy = a.y + aby * t - c.y, dz = a.z + abz * t - c.z;
  return dx * dx + dy * dy + dz * dz < r * r;
}
function killTarget(kind, obj) {
  obj.alive = false;
  G.kills++;
  const pts = kind === 'drone' ? 150 : 100;
  G.score += pts;
  explode(kind === 'drone' ? obj.wp : obj.wp, kind === 'drone' ? 1 : 0.8);
  audio.explosion(kind === 'drone' ? 0.8 : 0.6);
  audio.score();
  popScore(`+${pts} ${kind === 'drone' ? 'DRONE / ДРОН' : 'BEACON / МАЯК'}`);
  if (kind === 'beacon') { beacons.setMatrixAt(BEACONS.indexOf(obj), ZERO_M); beacons.instanceMatrix.needsUpdate = true; }
}
function breakMast(m) {
  m.alive = false;
  G.mastsBroken++;
  G.score = Math.max(0, G.score - 300);
  m.zone.shielded = false;
  explode(m.top, 1.1, true);
  audio.explosion(1); audio.collapse();
  setMastMatrix(m, MASTS.indexOf(m));
  showMsg('MAST HIT — SHIELD DOWN', 'МАЧТА СБИТА — ПОЛЕ СНЯТО', 2.6, '#ff8a5a');
  popScore('−300 MAST / МАЧТА');
  zoneEls[ZONES.indexOf(m.zone)].classList.add('off');
}
function updateBolts(dt) {
  let n = 0;
  for (const b of bolts) {
    if (!b.on) continue;
    b.q.copy(b.p);
    b.p.addScaledVector(b.d, BOLT_SPEED * dt);
    b.life -= dt;
    let dead = b.life <= 0;
    if (!dead) {
      for (const d of DRONES) {
        if (!d.alive || Math.abs(d.s - b.s) > 40) continue;
        if (segSphere(b.q, b.p, d.wp, 3.4)) { killTarget('drone', d); dead = true; break; }
      }
    }
    if (!dead) for (const t of BEACONS) {
      if (!t.alive || Math.abs(t.s - b.s) > 40) continue;
      if (segSphere(b.q, b.p, t.wp, 2.4) || segSphere(b.q, b.p, t.wp2, 1.6)) { killTarget('beacon', t); dead = true; break; }
    }
    if (!dead) for (const m of MASTS) {
      if (!m.alive || Math.abs(m.s - b.s) > 40) continue;
      if (m.pts.some((pt) => segSphere(b.q, b.p, pt, 2.1))) { breakMast(m); dead = true; break; }
    }
    if (!dead) {
      const pr = projectToPath(b.p.x, b.p.z, b.s);
      b.s = pr.s;
      const y = b.p.y;
      const side = pr.lat > 0 ? 1 : -1;
      if (side * pr.lat > wallLat(b.s, y, side)) { sparkBurst(b.p, 8); dead = true; }
      else if (y < 0) { splash(b.p, 6, 0.4); dead = true; }
      else {
        for (const r of ROCKS) if (Math.abs(r.s - b.s) < r.r + 2 && y < r.h && Math.abs(r.lat - pr.lat) < r.r) { sparkBurst(b.p, 8); dead = true; break; }
        for (const a of ARCHES) if (Math.abs(a.s - b.s) < a.ht && y > archBottom(a, pr.lat) && y < archTop(a, pr.lat)) { sparkBurst(b.p, 8); dead = true; break; }
      }
    }
    if (dead) { b.on = false; continue; }
    M1.lookAt(V1.set(0, 0, 0), b.d, UP);
    Q1.setFromRotationMatrix(M1);
    M1.compose(b.p, Q1, V3.set(1, 1, 1));
    boltMesh.setMatrixAt(n++, M1);
    glows.add(b.p.x, b.p.y, b.p.z, 1, 0.65, 0.3, 0.9, 2.2);
  }
  boltMesh.count = n;
  boltMesh.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------------ targets & fields
function updateTargets(dt, time) {
  for (let i = 0; i < DRONES.length; i++) {
    const d = DRONES[i];
    if (!d.alive) { drones.setMatrixAt(i, ZERO_M); continue; }
    const near = d.s > G.s - 120 && d.s < G.s + 1300;
    if (!near) { drones.setMatrixAt(i, ZERO_M); d.wp.set(0, -1e4, 0); continue; }
    const s = d.s + Math.sin(time * 0.4 + d.phase) * 6;
    let lat = d.lat + Math.sin(time * d.speed + d.phase) * d.amp;
    const y = d.y + Math.sin(time * 1.3 + d.phase * 2) * 1.8;
    const wl = Math.min(wallLat(s, y, 1), wallLat(s, y, -1)) - 6;
    lat = clamp(lat, -wl, wl);
    toWorld(s, lat, y, d.wp);
    pathBasis(s, M1);
    M1.multiply(M2.makeRotationY(time * 0.6 + d.phase)).multiply(M2.makeRotationZ(Math.sin(time * d.speed + d.phase) * 0.25));
    M1.setPosition(d.wp);
    drones.setMatrixAt(i, M1);
    const blink = 0.6 + 0.4 * Math.sin(time * 9 + d.phase);
    glows.add(d.wp.x, d.wp.y - 0.2, d.wp.z, 1, 0.3, 0.12, blink, 2.6);
  }
  drones.instanceMatrix.needsUpdate = true;
  for (const b of BEACONS) {
    if (!b.alive || b.s < G.s - 100 || b.s > G.s + 1300) continue;
    const on = Math.sin(time * 5 + b.phase) > 0.2 ? 1 : 0.12;
    glows.add(b.wp.x, b.wp.y + 0.2, b.wp.z, 1, 0.42, 0.1, on, 5.5);
  }
  for (const m of MASTS) {
    if (m.s < G.s - 100 || m.s > G.s + 1300) continue;
    if (m.alive) {
      const pu = 0.75 + 0.25 * Math.sin(time * 3 + m.s);
      glows.add(m.top.x, m.top.y + 1.2, m.top.z, 0.35, 0.95, 1, pu, 8);
    } else if (Math.random() < dt * 6) {
      sparkBurst(m.pts[1], 3, [0.5, 0.9, 1]);
    }
  }
  for (const z of ZONES) {
    if (!z.mesh) continue;
    const u = z.mesh.material.uniforms;
    u.uTime.value = time;
    if (!z.shielded) {
      z.collapse += dt;
      const k = z.collapse;
      u.uAlpha.value = Math.max(0, 1 - k / 1.8);
      u.uFlick.value = k < 1.8 ? (Math.random() < 0.5 ? 0.15 : 1.6) : 0;
      if (k > 1.9) z.mesh.visible = false;
    }
  }
  for (const g of STATIC_GLOWS) {
    const a = g.blink < 0 ? 0.8 : (Math.sin(time * 3 + g.blink * 4) > 0 ? 1 : 0.2);
    glows.add(g.p.x, g.p.y, g.p.z, g.c[0], g.c[1], g.c[2], a, g.size);
  }
}

// ------------------------------------------------------------------ hazards
function updateHazards(dt) {
  const flying = G.phase === 'flight' || G.phase === 'landing';
  G.underwater = G.y < -0.6;
  if (flying) {
    if (G.underwater) {
      G.air = Math.max(0, G.air - dt);
      if (G.air < 15) {
        G.beepT -= dt;
        if (G.beepT <= 0) { audio.beep(G.air < 6 ? 1100 : 880); G.beepT = G.air < 6 ? 0.45 : 1; }
      }
      if (G.air <= 0) {
        if (!G.airOut) { G.airOut = true; showMsg('OUT OF AIR — SURFACING', 'ВОЗДУХ КОНЧИЛСЯ — ВСПЛЫТИЕ', 2, '#7ff'); }
        G.dive = false;
        G.health -= 8 * dt;
      }
    } else {
      G.air = Math.min(60, G.air + 14 * dt);
      G.airOut = false;
    }
    const z = zoneAt(G.s);
    const exposed = !!(z && !z.shielded);
    const dose = exposed ? (G.underwater ? 0.12 : 1) : 0;
    G.rad += (dose - G.rad) * damp(4, dt);
    G.health -= G.rad * 5.5 * dt;
    if (exposed && z !== G.lastZone) showMsg('NO SHIELD — RADIATION', 'НЕТ ПОЛЯ — РАДИАЦИЯ · НЫРЯЙТЕ', 2.4, '#ff6a4a');
    G.lastZone = exposed ? z : null;
    if (G.rad > 0.02 && audio.ctx) {
      const rate = 4 + 55 * G.rad;
      let k = rate * dt;
      while (Math.random() < k) { audio.click(); k -= 1; }
    }
    if (G.health <= 0) { G.health = 0; fail('PILOT INCAPACITATED', 'ПИЛОТ ПОТЕРЯЛ СОЗНАНИЕ'); }
  } else {
    G.rad *= Math.exp(-dt * 3);
  }
  // splash on entry / exit
  if (G.underwater !== G.wasUnder && G.phase !== 'start') {
    splash(shipPos, 110, 1.1);
    audio.splash();
    G.shake = Math.min(1, G.shake + 0.35);
  }
  G.wasUnder = G.underwater;
}

// ------------------------------------------------------------------ ship transform + fx
const nozW = new THREE.Vector3();
function updateShipVisual(dt, time) {
  frame(G.s, SF);
  toWorld(G.s, G.lat, G.y, shipPos);
  const yawT = -Math.atan2(G.vLat, Math.max(G.speed, 10)) * 0.8;
  const pitchT = Math.atan2(G.vY, Math.max(G.speed, 12)) * 0.8;
  const rollT = clamp(-G.vLat * 0.028, -0.75, 0.75);
  G.yaw += (yawT - G.yaw) * damp(8, dt);
  G.pitch += (pitchT - G.pitch) * damp(8, dt);
  G.roll += (rollT - G.roll) * damp(6, dt);
  const bob = G.phase === 'start' ? 0 : Math.sin(time * 2.1) * 0.08;
  ship.group.position.copy(shipPos).y += bob;
  ship.group.rotation.set(G.pitch, -SF.th + G.yaw, G.roll + Math.sin(time * 1.3) * 0.015, 'YXZ');
  ship.animate(dt, G.dive || G.underwater, G.boost, time);
  shipFwd.set(0, 0, -1).applyQuaternion(ship.group.quaternion);
  shipVel.set(SF.tx * G.speed + SF.rx * G.vLat, G.vY, SF.tz * G.speed + SF.rz * G.vLat);

  ship.group.updateMatrixWorld();
  const gc = ship.glowColor;
  const running = G.phase !== 'start' && G.phase !== 'landed' && G.phase !== 'result';
  const power = running ? 1 + G.boost * 0.6 : 0.35;
  for (const nz of ship.nozzles) {
    nozW.copy(nz).applyMatrix4(ship.body.matrixWorld);
    glows.add(nozW.x, nozW.y, nozW.z, gc.r, gc.g, gc.b, 0.85 * power, 3.4 * power);
    glows.add(nozW.x, nozW.y, nozW.z, gc.r, gc.g * 0.8, gc.b * 0.6, 0.3 * power, 8 * power);
    if (!running) continue;
    if (G.underwater) {
      if (Math.random() < 0.8) mist.emit(nozW.x + (Math.random() - 0.5), nozW.y, nozW.z + (Math.random() - 0.5), shipVel.x * 0.2, 1 + Math.random() * 2, shipVel.z * 0.2, 1.4, 0.3, 0.9, 0.7, 1, 1, 0.75, -6, 1.5);
    } else {
      sparks.emit(nozW.x, nozW.y, nozW.z, shipVel.x * 0.4 - shipFwd.x * 20, shipVel.y * 0.4 - shipFwd.y * 20, shipVel.z * 0.4 - shipFwd.z * 20,
        0.12 + G.boost * 0.1, 2.6, 0.6, gc.r, gc.g * 0.75, gc.b * 0.5, 0.7, 0, 0);
    }
  }
  // spray / wake when skimming low over the water
  const skim = !G.underwater && G.y < 5 && running ? (1 - G.y / 5) * Math.min(G.speed / 60, 1.4) : 0;
  G.skim = skim;
  if (skim > 0.05) {
    const n = Math.ceil(skim * 7);
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1;
      const ox = shipPos.x + SF.rx * side * (2.5 + Math.random() * 2) + SF.tx * (2 + Math.random() * 6);
      const oz = shipPos.z + SF.rz * side * (2.5 + Math.random() * 2) + SF.tz * (2 + Math.random() * 6);
      const out = 5 + Math.random() * 8;
      mist.emit(ox, 0.3, oz, SF.rx * side * out + SF.tx * G.speed * 0.25, 5 + Math.random() * 9 * skim, SF.rz * side * out + SF.tz * G.speed * 0.25,
        0.6 + Math.random() * 0.6, 0.9, 3.4, 0.86, 0.96, 0.95, 0.7 * skim + 0.15, 16, 0.5);
    }
    if (Math.random() < skim) mist.emit(shipPos.x - SF.tx * 9, 0.6, shipPos.z - SF.tz * 9, (Math.random() - 0.5) * 3, 3 + Math.random() * 5, (Math.random() - 0.5) * 3,
      1.5, 2, 8, 0.85, 0.94, 0.93, 0.35 * skim, 2, 1);
  }
  if (G.underwater && Math.random() < 0.5) {
    mist.emit(shipPos.x + (Math.random() - 0.5) * 30, -8 + Math.random() * 8, shipPos.z + (Math.random() - 0.5) * 30, 0, 0.8, 0, 3, 0.25, 0.5, 0.6, 1, 1, 0.4, -1, 0);
  }
}

// ------------------------------------------------------------------ camera
let fovCur = 68;
function updateCamera(dt, time) {
  const under = G.underwater;
  const dist = (G.phase === 'start' ? 20 : 16.5) + G.boost * 2.2 - (under ? 2.5 : 0);
  const hgt = under ? 3.6 : 6.2 + G.boost * 0.6;
  // behind the ship along its heading
  V1.set(-Math.sin(SF.th - G.yaw * 0.6), 0, Math.cos(SF.th - G.yaw * 0.6));
  // smooth the offset relative to the ship (rotational lag, no along-track lag)
  V2.copy(V1).multiplyScalar(dist);
  V2.y = hgt - G.pitch * 6;
  if (!camInit) { camOff.copy(V2); camInit = true; }
  camOff.x += (V2.x - camOff.x) * damp(5, dt);
  camOff.z += (V2.z - camOff.z) * damp(5, dt);
  camOff.y += (V2.y - camOff.y) * damp(4, dt);
  camPos.copy(shipPos).add(camOff);
  // keep the camera inside the canyon and on the correct side of the surface
  const pr = projectToPath(camPos.x, camPos.z, G.s - dist);
  const cy = camPos.y;
  for (const side of [-1, 1]) {
    const wl = wallLat(pr.s, Math.max(cy, 3), side) - 2;
    if (side * pr.lat > wl) {
      toWorld(pr.s, side * wl, cy, V3);
      camPos.x = V3.x; camPos.z = V3.z;
    }
  }
  if (G.y < -0.6) camPos.y = Math.min(camPos.y, -1.1);
  else if (G.y > 0.3) camPos.y = Math.max(camPos.y, 1.0 + Math.max(0, bankY(pr.s, pr.lat)));
  camera.position.copy(camPos);
  // shake
  G.shake = Math.max(0, G.shake - dt * 1.8);
  const sh = G.shake * G.shake * 0.9 + (G.phase === 'flight' ? G.speed / 95 * 0.04 + G.boost * 0.07 : 0);
  camera.position.x += (Math.random() - 0.5) * sh;
  camera.position.y += (Math.random() - 0.5) * sh;
  camera.position.z += (Math.random() - 0.5) * sh;
  camLook.copy(shipPos).addScaledVector(shipFwd, 26);
  camLook.y = shipPos.y + 1.5 + (under ? 0 : 0.5);
  camera.lookAt(camLook);
  camera.rotateZ(G.roll * 0.22);
  const fovT = 66 + clamp((G.speed - 60) * 0.18, -6, 8) + G.boost * 12;
  fovCur += (fovT - fovCur) * damp(3, dt);
  if (Math.abs(camera.fov - fovCur) > 0.05) { camera.fov = fovCur; camera.updateProjectionMatrix(); }

  // underwater look
  const cu = camera.position.y < 0;
  if (cu !== camUnder) {
    camUnder = cu;
    scene.fog.color.copy(cu ? FOG_WATER : FOG_AIR);
    scene.fog.density = cu ? FOG_D_WATER : FOG_D_AIR;
    scene.background.copy(cu ? FOG_WATER : FOG_AIR);
    sky.visible = !cu;
    const fd = cu ? FOG_D_WATER : FOG_D_AIR;
    glows.mat.uniforms.uFogD.value = fd; sparks.out.mat.uniforms.uFogD.value = fd; mist.out.mat.uniforms.uFogD.value = fd;
    mist.out.mat.uniforms.uFogCol.value.copy(scene.fog.color);
    for (const z of ZONES) if (z.mesh) z.mesh.material.uniforms.uFogD.value = fd;
    hemi.intensity = cu ? 1.2 : 1.9;
    hud.tintUnder.style.opacity = cu ? 1 : 0;
  }
  // speed streaks / dust
  const su = streaks.mat.uniforms;
  su.uCenter.value.copy(camera.position).addScaledVector(shipFwd, 40);
  su.uVel.value.copy(shipVel);
  su.uLen.value = cu ? 0.012 : 0.035 + G.boost * 0.05;
  su.uOp.value = cu ? 0.35 : (G.phase === 'flight' ? 0.18 + G.boost * 0.45 : 0.05);
  su.uCol.value.setRGB(cu ? 0.4 : 1, cu ? 0.9 : 0.82, cu ? 0.85 : 0.62);
}

// ------------------------------------------------------------------ HUD
let hudT = 0;
const reticleV = new THREE.Vector3();
function updateHUD(dt) {
  hud.bCargo.style.transform = `scaleX(${G.cargo / 100})`;
  hud.bHealth.style.transform = `scaleX(${Math.max(0, G.health) / 100})`;
  hud.bRad.style.transform = `scaleX(${G.rad})`;
  hud.bAir.style.transform = `scaleX(${G.air / 60})`;
  hud.airBox.style.opacity = G.underwater || G.air < 59.5 ? 1 : 0;
  hud.airBox.classList.toggle('low', G.air < 15);
  hud.routeShip.style.left = clamp((G.s - PAD_A) / ROUTE, 0, 1) * 100 + '%';
  hud.tintRad.style.opacity = G.rad > 0.01 ? G.rad * (0.75 + 0.25 * Math.random()) : 0;
  G.hitFlash = Math.max(0, G.hitFlash - dt * 2.5);
  hud.tintHit.style.opacity = G.hitFlash;
  hud.dive.classList.toggle('under', G.dive);
  if (G.msgT > 0) { G.msgT -= dt; if (G.msgT <= 0) hud.msg.style.opacity = 0; }
  if (G.popT > 0) {
    G.popT -= dt;
    hud.pop.style.transform = `translate(-50%,${-50 - (0.9 - G.popT) * 40}%)`;
    if (G.popT <= 0) hud.pop.style.opacity = 0;
  }
  // reticle
  reticleV.copy(shipPos).addScaledVector(shipFwd, 140).project(camera);
  const vis = G.phase === 'flight' && !G.underwater && reticleV.z < 1;
  hud.reticle.style.display = vis ? 'block' : 'none';
  if (vis) hud.reticle.style.transform = `translate(${(reticleV.x * 0.5 + 0.5) * innerWidth}px,${(-reticleV.y * 0.5 + 0.5) * innerHeight}px)`;
  hudT -= dt;
  if (hudT > 0) return;
  hudT = 0.1;
  hud.cargo.textContent = Math.ceil(G.cargo) + '%';
  hud.health.textContent = Math.ceil(Math.max(0, G.health)) + '%';
  hud.rad.textContent = G.rad > 0.05 ? (G.rad * 4.2).toFixed(1) + ' Sv/h' : 'SHIELDED';
  hud.rad.style.color = G.rad > 0.05 ? '#ff6a4a' : '#9ff';
  hud.score.textContent = G.score;
  hud.speed.textContent = Math.round(G.speed * 3.6);
  hud.dist.textContent = (Math.max(0, PAD_B - G.s) / 1000).toFixed(2);
  hud.air.textContent = Math.ceil(G.air) + 's';
}

// ------------------------------------------------------------------ result
function showResult() {
  G.phase = 'result';
  const ok = G.outcome === 'delivered';
  const timeBonus = ok ? Math.max(0, Math.round((200 - G.t) * 15)) : 0;
  G.finalScore = Math.max(0, G.score + (ok ? Math.round(G.cargo) * 20 + Math.round(G.health) * 10 + timeBonus : 0));
  $('rTitle').textContent = ok ? 'DELIVERED' : 'MISSION FAILED';
  $('rTitle').className = 'title ' + (ok ? 'ok' : 'bad');
  $('rSub').textContent = ok ? 'ДОСТАВЛЕНО · SETTLEMENT B HAS WATER' : 'МИССИЯ ПРОВАЛЕНА · ' + G.reason;
  const mm = Math.floor(G.t / 60), ss = (G.t % 60).toFixed(1).padStart(4, '0');
  $('rTime').textContent = `${mm}:${ss}`;
  $('rCargo').textContent = Math.round(G.cargo) + '%';
  $('rHealth').textContent = Math.round(Math.max(0, G.health)) + '%';
  $('rTargets').textContent = `${G.kills} / ${DRONES.length + BEACONS.length}`;
  $('rMasts').textContent = `${G.mastsBroken}`;
  $('rScore').textContent = G.finalScore + (ok ? `  (+${timeBonus} time)` : '');
  $('result').style.display = 'flex';
  hud.root.style.display = 'none';
  document.body.classList.remove('playing');
}

function reset() {
  resetLevel();
  G = freshState();
  for (const b of bolts) b.on = false;
  sparks.clear(); mist.clear();
  placeStatic();
  for (const z of ZONES) { z.mesh.visible = true; z.mesh.material.uniforms.uAlpha.value = 1; z.mesh.material.uniforms.uFlick.value = 1; }
  zoneEls.forEach((e) => e.classList.remove('off'));
  ship.diveT = 0;
  camInit = false;
}

function startGame() {
  if (G.phase !== 'start') return;
  if (!navigator.userActivation || navigator.userActivation.isActive) audio.init();
  $('start').style.display = 'none';
  $('result').style.display = 'none';
  hud.root.style.display = 'block';
  document.body.classList.add('playing');
  G.phase = 'takeoff'; G.phaseT = 0; G.t = 0;
  showMsg('TAKEOFF — SETTLEMENT A', 'ВЗЛЁТ — ПОСЕЛЕНИЕ А', 2.2);
}
$('startBtn').parentElement.addEventListener('click', () => {
  try {
    const el = document.documentElement;
    if (isTouch && el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen({ navigationUI: 'hide' }).then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
  } catch (e) { /* ignore */ }
  startGame();
});
$('retry').addEventListener('click', () => { reset(); startGame(); });
addEventListener('keydown', (e) => {
  if (e.code === 'Enter' || e.code === 'Space') {
    if (G.phase === 'start') startGame();
    else if (G.phase === 'result') { reset(); startGame(); }
  }
});
// unlock audio on the first gesture (needed for ?autostart=1)
const unlock = () => audio.init();
addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ------------------------------------------------------------------ main loop
const clock = new THREE.Clock();
let time = 0, fps = 60, fpsAcc = 0, fpsN = 0;
const portraitMQ = matchMedia('(orientation: portrait) and (max-width: 900px)');
function loop() {
  requestAnimationFrame(loop);
  let dt = Math.min(clock.getDelta(), 0.05);
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  if (portraitMQ.matches && G.phase !== 'start' && G.phase !== 'result') dt = 0;
  time += dt;
  pollInput();
  if (G.phase !== 'start' && G.phase !== 'result') {
    G.phaseT += dt;
    if (G.phase !== 'landed' && G.phase !== 'failed') G.t += dt;
  }
  G.hitCd -= dt;
  G.fireCd -= dt;

  glows.begin();
  updateFlight(dt);
  updateShipVisual(dt, time);
  // shooting
  autoFire = false;
  if (AUTOPILOT && G.phase === 'flight') {
    for (const d of DRONES) if (d.alive && d.s - G.s > 30 && d.s - G.s < 200) {
      V3.copy(d.wp).sub(shipPos).normalize();
      if (V3.dot(shipFwd) > 0.994) autoFire = true;
    }
    for (const m of MASTS) if (m.alive && m.s - G.s > 0 && m.s - G.s < 300) autoFire = false;
    input.fire = autoFire;
  }
  if (G.phase === 'flight' && input.fire && !G.underwater && G.fireCd <= 0) fire();
  updateBolts(dt);
  updateTargets(dt, time);
  updateHazards(dt);
  if (G.phase === 'landed' && G.phaseT > 1.6) showResult();
  if (G.phase === 'failed' && G.phaseT > 2.6) showResult();
  updateCamera(dt, time);

  if (G.flash && G.flash.t > 0) {
    const f = G.flash; f.t -= dt;
    glows.add(f.p.x, f.p.y, f.p.z, f.cold ? 0.5 : 1, f.cold ? 0.9 : 0.6, f.cold ? 1 : 0.25, Math.max(0, f.t / 0.25), 30 * f.big);
  }
  sparks.update(dt);
  mist.update(dt);
  glows.end();

  // chunk streaming / culling by path distance
  const s0 = G.s - 320, s1 = G.s + 1350;
  for (const c of chunks) c.visible = c.userData.sB > s0 && c.userData.sA < s1;
  for (const w of waters) w.visible = w.userData.sB > s0 && w.userData.sA < s1;
  for (const z of ZONES) if (z.mesh && z.shielded) z.mesh.visible = z.s1 > s0 && z.s0 < s1;

  waterMat.uniforms.uTime.value = time;
  sky.position.copy(camera.position);
  const ps = renderer.getPixelRatio() * innerHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
  glows.mat.uniforms.uScale.value = ps; sparks.out.mat.uniforms.uScale.value = ps; mist.out.mat.uniforms.uScale.value = ps;

  updateHUD(dt);
  audio.update(G.speed, G.boost, camUnder, G.skim || 0, G.phase !== 'start' && G.phase !== 'result');
  renderer.render(scene, camera);
}

// ------------------------------------------------------------------ test hook
window.__lethe = {
  state: () => ({
    t: +G.t.toFixed(2), speed: +G.speed.toFixed(2), distToB: +Math.max(0, PAD_B - G.s).toFixed(1), cargo: +G.cargo.toFixed(1),
    health: +Math.max(0, G.health).toFixed(1), air: +G.air.toFixed(1), score: G.phase === 'result' ? G.finalScore : G.score,
    underwater: G.underwater, phase: G.phase, outcome: G.outcome, s: +G.s.toFixed(1), lat: +G.lat.toFixed(2), y: +G.y.toFixed(2),
    dive: G.dive, radiation: +G.rad.toFixed(3), mastsBroken: G.mastsBroken, kills: G.kills, fps: Math.round(fps),
    camDist: +camera.position.distanceTo(shipPos).toFixed(2), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
  }),
  start: startGame,
  retry: () => { reset(); startGame(); },
  warp: (s) => { G.s = s; camInit = false; },
  input,
  debug: { breakMast: (i) => breakMast(MASTS[i]), masts: () => MASTS.map((m) => ({ s: m.s, alive: m.alive })) },
};

if (params.get('autostart') === '1') startGame();
loop();
