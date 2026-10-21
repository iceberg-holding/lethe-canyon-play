// LETHE / ЛЕТА — "Delivery" prototype. Game loop, flight model, shooting, shield, LETHE spotters
// and turrets, hazards, camera, HUD, adaptive quality.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, lerp, damp, smoothstep } from './util.js';
import {
  PAD_A, PAD_B, PAD_TOP, ROUTE, frame, toWorld, projectToPath, wallLat, riverHalf, bankY, maxY, narrowAt,
  ARCHES, ROCKS, ZONES, BEACONS, DRONES, MASTS, TURRETS, archBottom, archTop, zoneAt, resetLevel,
} from './world.js';
import {
  buildChunks, buildWater, buildFields, buildFoam, buildShafts, makeSky, makeTerrainMaterial, makeWaterMaterial, STATIC_GLOWS, VENTS,
} from './terrain.js';
import { Glows, Particles, Streaks, Beams, Debris, Motes, Wake } from './fx.js';
import { Ship, makeEnvMap } from './ship.js';
import { Audio } from './audio.js';
import { input, setupInput, pollInput } from './input.js';
import { Post, QualityGovernor, TIERS } from './post.js';

THREE.ColorManagement.enabled = false;
const params = new URLSearchParams(location.search);
const AUTOPILOT = params.get('autopilot') === '1';
const NOBOOST = params.get('noboost') === '1';   // autopilot at cruise speed (timing tests)
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
document.body.classList.toggle('touch', isTouch);
const qParam = { low: 'low', med: 'med', medium: 'med', high: 'high' }[params.get('q')];

// ------------------------------------------------------------------ renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: !isTouch, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);
const DEVICE_DPR = window.devicePixelRatio || 1;
renderer.info.autoReset = false;

const HOR = [0.93, 0.62, 0.46], ZEN = [0.58, 0.34, 0.3];
const FOG_AIR = new THREE.Color(0.88, 0.58, 0.44), FOG_WATER = new THREE.Color(0.071, 0.243, 0.278);   // codex-style #123e47
const FOG_D_AIR = 0.0019, FOG_D_WATER = 0.019;
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG_AIR.clone(), FOG_D_AIR);
scene.background = FOG_AIR.clone();
const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.4, 2200);

const SUN = new THREE.Vector3(0.3, 0.33, -0.9).normalize();
const SUN2 = new THREE.Vector3(-0.22, 0.42, -0.88).normalize();
const hemi = new THREE.HemisphereLight(0xffb48c, 0x6a2e1c, 1.85);
scene.add(hemi);
const sunL = new THREE.DirectionalLight(0xffd2a0, 2.6);
sunL.castShadow = true;
sunL.shadow.mapSize.set(1024, 1024);
Object.assign(sunL.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 260 });
sunL.shadow.bias = -0.0006;
sunL.shadow.normalBias = 0.04;
scene.add(sunL, sunL.target);
// orbital mirror: faint cool fill
const sun2L = new THREE.DirectionalLight(0xc4dcff, 0.85);
sun2L.position.copy(SUN2).multiplyScalar(100);
scene.add(sun2L);
// pooled flash light (muzzle flashes / explosions); always present so programs never recompile
const flashL = new THREE.PointLight(0xffa050, 0, 110, 2);
scene.add(flashL);

const sky = makeSky(SUN, SUN2, HOR, ZEN);
scene.add(sky);

const terrainMat = makeTerrainMaterial();
const chunks = buildChunks(scene, terrainMat);
const waterMat = makeWaterMaterial(SUN, SUN2, HOR, ZEN);
const waters = buildWater(scene, waterMat);
const foam = buildFoam(scene, FOG_D_AIR);
const shafts = buildShafts(scene, SUN2);
buildFields(scene, FOG_D_AIR);

const glows = new Glows(1600, FOG_D_AIR);
scene.add(glows.obj);
const sparks = new Particles(1400, true, FOG_D_AIR);
scene.add(sparks.obj);
const mist = new Particles(1400, false, FOG_D_AIR);
scene.add(mist.obj);
const streaks = new Streaks();
scene.add(streaks.obj);
const beams = new Beams(256, FOG_D_AIR);
scene.add(beams.obj);
const debris = new Debris(72);
scene.add(debris.mesh);
const motes = new Motes(isTouch ? 350 : 650);
scene.add(motes.obj);
const wake = new Wake(48);
scene.add(wake.obj);

const envMap = makeEnvMap(renderer);
const ship = new Ship(envMap);
const SHIP_SCALE = 0.85;
ship.group.scale.setScalar(SHIP_SCALE);
scene.add(ship.group);

// soft blob shadow on the water (all tiers)
const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { uA: { value: 0.4 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform float uA; varying vec2 vUv; void main(){ vec2 p = vUv * 2.0 - 1.0; float a = smoothstep(1.0, 0.2, dot(p, p)); gl_FragColor = vec4(0.0, 0.03, 0.04, a * uA); }',
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
}));
blob.rotation.x = -Math.PI / 2;
blob.renderOrder = 1;
scene.add(blob);

// ------------------------------------------------------------------ post + quality
const post = new Post(renderer, scene, camera);
let quality = qParam || (isTouch ? 'med' : 'high');
function applyQuality(name) {
  quality = name;
  post.apply(name, innerWidth, innerHeight, DEVICE_DPR);
  const T = TIERS[name];
  for (const c of chunks) for (const m of c.children) if (m.userData.detail) m.visible = T.detail;
  shafts.visible = T.name !== 'low';
  motes.obj.visible = T.name !== 'low';
  waterMat.uniforms.uGlint.value = T.glintK;
  scene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; }); });
  const q = document.getElementById('qual'); if (q) q.textContent = 'QUALITY · ' + name.toUpperCase();
}
const governor = new QualityGovernor(quality, !!qParam, (name) => applyQuality(name));
governor.max = isTouch ? 1 : 2;   // phones never auto-raise to the heavy tier
if (qParam === 'high') governor.max = 2;
applyQuality(quality);

// ------------------------------------------------------------------ targets (instanced)
function colored(g, c) {
  g = g.index ? g.toNonIndexed() : g.clone();
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set(c, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}
const tr = (g, x, y, z, rx = 0, ry = 0, rz = 0) => g.rotateX(rx).rotateY(ry).rotateZ(rz).translate(x, y, z);
const lambertVC = new THREE.MeshLambertMaterial({ vertexColors: true });
const droneGeo = mergeGeometries([
  colored(new THREE.SphereGeometry(1.15, 14, 9).scale(1, 0.62, 1.2), [0.66, 0.67, 0.68]),
  colored(tr(new THREE.TorusGeometry(2.0, 0.18, 6, 24), 0, 0, 0, Math.PI / 2), [0.2, 0.2, 0.22]),
  colored(tr(new THREE.CylinderGeometry(1.18, 1.18, 0.22, 16), 0, 0.05, 0), [0.9, 0.48, 0.12]),
  colored(tr(new THREE.BoxGeometry(4.2, 0.12, 0.3), 0, 0, 0), [0.25, 0.25, 0.27]),
  colored(tr(new THREE.BoxGeometry(0.3, 0.12, 4.2), 0, 0, 0), [0.25, 0.25, 0.27]),
  colored(tr(new THREE.CylinderGeometry(0.75, 0.75, 0.06, 12), 2.0, 0.18, 0), [0.12, 0.12, 0.13]),
  colored(tr(new THREE.CylinderGeometry(0.75, 0.75, 0.06, 12), -2.0, 0.18, 0), [0.12, 0.12, 0.13]),
  colored(tr(new THREE.CylinderGeometry(0.75, 0.75, 0.06, 12), 0, 0.18, 2.0), [0.12, 0.12, 0.13]),
  colored(tr(new THREE.CylinderGeometry(0.75, 0.75, 0.06, 12), 0, 0.18, -2.0), [0.12, 0.12, 0.13]),
  colored(tr(new THREE.ConeGeometry(0.5, 0.9, 10), 0, -0.9, 0, Math.PI), [0.3, 0.3, 0.32]),
  colored(tr(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12), 0, -0.05, -1.25, Math.PI / 2), [0.9, 0.1, 0.06]),
]);
// two spare debug drones at the end of the list (hidden unless spawned via __lethe.debug.spawnDrone)
const N_DRONE_REAL = DRONES.length;
for (let i = 0; i < 2; i++) DRONES.push({ s: -1e4, lat: 0, y: 15, amp: 6, phase: i * 2, speed: 0.5, alive: false, debug: true });
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
  colored(tr(new THREE.CylinderGeometry(0.32, 0.55, MAST_LEN, 8), 0, MAST_LEN / 2, 0), [0.62, 0.64, 0.68]),
  colored(tr(new THREE.CylinderGeometry(0.9, 0.9, 0.5, 8), 0, 0.3, 0), [0.3, 0.3, 0.32]),
  colored(tr(new THREE.TorusGeometry(1.25, 0.22, 6, 16), 0, MAST_LEN - 1.2, 0, Math.PI / 2), [0.35, 0.95, 1.0]),
  colored(tr(new THREE.TorusGeometry(0.9, 0.18, 6, 16), 0, MAST_LEN - 2.6, 0, Math.PI / 2), [0.35, 0.95, 1.0]),
  colored(tr(new THREE.ConeGeometry(0.3, 2.2, 6), 0, MAST_LEN + 1, 0), [0.8, 0.82, 0.86]),
  colored(tr(new THREE.BoxGeometry(0.1, 3, 1.4), 0, 5, 0), [0.85, 0.55, 0.15]),
]);
const masts = new THREE.InstancedMesh(mastGeo, lambertVC, MASTS.length);
scene.add(masts);

// LETHE turret head: armoured housing, twin barrels, red eye (nose along -Z)
const turretGeo = mergeGeometries([
  colored(tr(new THREE.CylinderGeometry(1.6, 1.9, 1.2, 10), 0, 0, 0), [0.28, 0.27, 0.28]),
  colored(tr(new THREE.BoxGeometry(2.6, 1.5, 2.8), 0, 1.1, 0.1), [0.36, 0.35, 0.36]),
  colored(tr(new THREE.BoxGeometry(2.7, 0.2, 1.0), 0, 1.9, 0.8), [0.7, 0.12, 0.08]),
  colored(tr(new THREE.CylinderGeometry(0.18, 0.22, 3.4, 8), 0.55, 1.0, -2.6, Math.PI / 2), [0.16, 0.16, 0.17]),
  colored(tr(new THREE.CylinderGeometry(0.18, 0.22, 3.4, 8), -0.55, 1.0, -2.6, Math.PI / 2), [0.16, 0.16, 0.17]),
  colored(tr(new THREE.SphereGeometry(0.42, 10, 8), 0, 1.35, -1.4), [1.0, 0.08, 0.05]),
]);
const turrets = new THREE.InstancedMesh(turretGeo, lambertVC, TURRETS.length);
turrets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
turrets.frustumCulled = false;
scene.add(turrets);

const F = { x: 0, z: 0, th: 0, tx: 0, tz: 0, rx: 0, rz: 0 };
const SF = { x: 0, z: 0, th: 0, tx: 0, tz: 0, rx: 0, rz: 0 }; // ship frame
const V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3(), V4 = new THREE.Vector3();
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
  TURRETS.forEach((t) => { t.wp = toWorld(t.s, t.lat, t.y + 0.6, new THREE.Vector3()); t.eye = new THREE.Vector3(); t.muzzle = new THREE.Vector3(); t.aim = new THREE.Vector3(0, 0, -1); });
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
for (const d of DRONES) d.wp = new THREE.Vector3(0, -1e4, 0);

// ------------------------------------------------------------------ bolts
const ROCKET_AMMO = 6, ROCKET_CD = 1.2, ROCKET_N = 6, ROCKET_SPLASH = 24, MAST_SPLASH = 16;
const rockets = [];
for (let i = 0; i < ROCKET_N; i++) rockets.push({ on: false, p: new THREE.Vector3(), q: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, s: 0, target: null, age: 0 });
const BOLT_SPEED = 430, BOLT_LIFE = 0.55, BOLT_N = 48;
const bolts = [];
for (let i = 0; i < BOLT_N; i++) bolts.push({ on: false, p: new THREE.Vector3(), q: new THREE.Vector3(), o: new THREE.Vector3(), d: new THREE.Vector3(), life: 0, s: 0 });
// LETHE turret bolts
const EB_SPEED = 165, EB_N = 24, EB_DMG = 9;
const ebolts = [];
for (let i = 0; i < EB_N; i++) ebolts.push({ on: false, p: new THREE.Vector3(), q: new THREE.Vector3(), o: new THREE.Vector3(), d: new THREE.Vector3(), life: 0, s: 0 });

// ------------------------------------------------------------------ audio / input / HUD refs
const audio = new Audio();
setupInput(renderer.domElement);
const $ = (id) => document.getElementById(id);
const barEls = (id) => ({ v: $(id).querySelector('.v'), g: $(id).querySelector('.ghost') });
const hud = {
  root: $('hud'), cargo: $('tCargo'), shield: $('tShield'), health: $('tHealth'), rad: $('tRad'), score: $('tScore'), speed: $('tSpeed'), dist: $('tDist'),
  bCargo: barEls('bCargo'), bShield: barEls('bShield'), bHealth: barEls('bHealth'), bRad: barEls('bRad'), bAir: barEls('bAir'), bMark: barEls('bMark'),
  rowCargo: $('rCargoRow'), rowShield: $('rShieldRow'), rowHealth: $('rHealthRow'),
  air: $('tAir'), airBox: $('airBox'), msg: $('msg'), pop: $('pop'), toast: $('toast'), markBox: $('markBox'), mark: $('tMark'), sDown: $('sDown'),
  routeShip: $('routeShip'), reticle: $('reticle'), tintUnder: $('tintUnder'), tintRad: $('tintRad'), tintHit: $('tintHit'), tintShield: $('tintShield'), tintLock: $('tintLock'),
  dive: $('btnDive'), rocketBtn: $('btnRocket'), rockets: $('tRockets'), pips: $('pips'), snd: $('snd'),
};
for (let i = 0; i < ROCKET_AMMO; i++) hud.pips.appendChild(document.createElement('i'));
const zoneEls = ZONES.map((z) => {
  const el = document.createElement('div');
  el.className = 'z';
  el.style.left = ((z.s0 - PAD_A) / ROUTE) * 100 + '%';
  el.style.width = ((z.s1 - z.s0) / ROUTE) * 100 - 0.5 + '%';
  $('routeBar').appendChild(el);
  return el;
});
const brackets = [0, 1, 2].map(() => {
  const el = document.createElement('div');
  el.className = 'brk';
  el.innerHTML = $('brackets').children.length ? '' : '<span>LETHE · СПОТТЕР</span>';
  $('brackets').appendChild(el);
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
    msgT: 0, popT: 0, beepT: 0, airOut: false, toastT: 0,
    shield: 100, shieldCd: 0, shieldOn: 1, shieldFlash: 0, shieldHit: 0, regen: false,
    mark: 0, spotters: 0, markBeep: 0, lock: { phase: 'none', t: 0, turret: null, shots: 0 }, droneHinted: false, lostSaid: false,
    turretShotsFired: 0, turretHits: 0, ebLog: [], turretKills: 0, apDiveT: 0, muzzleT: 0,
    rockets: ROCKET_AMMO, rocketCd: 0, rocketsFired: 0, recoilT: 9, dip: 0, kick: 0, jolt: 0, micro: 0,
  };
}
G = freshState();
resetLevel();
placeStatic();

const shipPos = new THREE.Vector3(), shipFwd = new THREE.Vector3(), shipVel = new THREE.Vector3();
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), camOff = new THREE.Vector3();
let camInit = false, camUnder = false, camLatAdj = 0;

function showMsg(en, ru, dur = 2, color = '#f6efe6') {
  hud.msg.innerHTML = `${en}<small>${ru}</small>`;
  hud.msg.style.color = color;
  hud.msg.style.opacity = 1;
  G.msgT = dur;
}
function popScore(text) {
  hud.pop.textContent = text;
  hud.pop.style.opacity = 1;
  hud.pop.style.transform = 'translate(-50%,-50%) scale(1.1)';
  G.popT = 0.9;
}
function toast(html, dur = 5) {
  hud.toast.innerHTML = html;
  hud.toast.classList.add('on');
  G.toastT = dur;
}
function pulseRow(el) {
  el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
}

// stereo position of a world point relative to the camera (-1 left .. 1 right)
const PAN_V = new THREE.Vector3(), PAN_R = new THREE.Vector3();
function panOf(p) {
  PAN_R.set(1, 0, 0).applyQuaternion(camera.quaternion);
  PAN_V.copy(p).sub(camera.position);
  const d = PAN_V.length() || 1;
  return clamp(PAN_V.dot(PAN_R) / d, -1, 1);
}
// ------------------------------------------------------------------ effects helpers
const flash = { t: 0, dur: 0.3, peak: 0, p: new THREE.Vector3(), col: new THREE.Color() };
function lightFlash(p, peak, dur, r, g, b) {
  if (flash.t > 0 && flash.peak * (flash.t / flash.dur) > peak) return;
  flash.p.copy(p); flash.peak = peak; flash.dur = dur; flash.t = dur; flash.col.setRGB(r, g, b);
}
function explode(p, big = 1, cold = false) {
  const hot = cold ? [0.5, 1.4, 2.0] : [2.2, 1.1, 0.35];
  // fireball: growing HDR sprites
  for (let i = 0; i < 16 * big; i++) {
    const a = Math.random() * 6.28, e = Math.random() * 2 - 1, v = (3 + Math.random() * 9) * big;
    const c = Math.sqrt(1 - e * e), k = 0.6 + Math.random() * 0.5;
    sparks.emit(p.x, p.y, p.z, Math.cos(a) * c * v, e * v, Math.sin(a) * c * v, 0.45 + Math.random() * 0.45, 2.5 * big, (9 + Math.random() * 6) * big,
      hot[0] * k, hot[1] * k * (0.7 + Math.random() * 0.4), hot[2] * k, 1, -2, 2.2);
  }
  // hot sparks
  for (let i = 0; i < 40 * big; i++) {
    const a = Math.random() * 6.28, e = Math.random() * 2 - 1, v = (14 + Math.random() * 30) * big;
    const c = Math.sqrt(1 - e * e);
    sparks.emit(p.x, p.y, p.z, Math.cos(a) * c * v, e * v + 4, Math.sin(a) * c * v, 0.4 + Math.random() * 0.7, 1.1, 0.3,
      cold ? 0.6 : 1.8, cold ? 1.4 : 1.1, cold ? 1.8 : 0.4, 1, 22, 1.5);
  }
  // debris chunks
  for (let i = 0; i < 9 * big; i++) {
    V4.set(Math.random() - 0.5, Math.random() * 0.9 + 0.1, Math.random() - 0.5).normalize().multiplyScalar((14 + Math.random() * 22) * big);
    debris.emit(p, V4, 0.25 + Math.random() * 0.5 * big, 0.6 + Math.random() * 0.4);
  }
  // smoke
  for (let i = 0; i < 12 * big; i++) {
    mist.emit(p.x + (Math.random() - 0.5) * 3, p.y + (Math.random() - 0.5) * 3, p.z + (Math.random() - 0.5) * 3,
      (Math.random() - 0.5) * 5, 2 + Math.random() * 4, (Math.random() - 0.5) * 5, 1.8 + Math.random() * 1.4, 3, 12 * big, 0.2, 0.17, 0.15, 0.6, -1.2, 0.7);
  }
  G.flash = { p: p.clone(), t: 0.28, big, cold };
  lightFlash(p, 650 * big, 0.45, cold ? 0.5 : 1, cold ? 0.85 : 0.6, cold ? 1 : 0.3);
  const near = clamp(1 - camera.position.distanceTo(p) / 180, 0, 1);
  G.shake = Math.min(1.5, G.shake + (0.25 + 0.9 * near) * big);
  audio.explosion(big, near, panOf(p));
}
function sparkBurst(p, n, col = [1.4, 0.95, 0.45]) {
  for (let i = 0; i < n; i++) {
    const v = 10 + Math.random() * 25;
    sparks.emit(p.x, p.y, p.z, (Math.random() - 0.5) * v, Math.random() * v * 0.7, (Math.random() - 0.5) * v, 0.3 + Math.random() * 0.4, 0.8, 0.2, col[0], col[1], col[2], 1, 25, 1);
  }
}
function surfaceHit(p) {
  sparkBurst(p, 12);
  sparks.emit(p.x, p.y, p.z, 0, 0, 0, 0.12, 5, 7, 2, 1.3, 0.6, 1);
  for (let i = 0; i < 4; i++) mist.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 4, 1 + Math.random() * 3, (Math.random() - 0.5) * 4, 1 + Math.random(), 1.5, 5, 0.62, 0.42, 0.3, 0.45, -0.5, 1);
  if (camera.position.distanceToSquared(p) < 160 * 160) audio.impact();
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

// ------------------------------------------------------------------ damage (shield first)
const SHIELD_MAX = 100, SHIELD_DELAY = 3, SHIELD_REGEN = SHIELD_MAX / 4;
function shieldImpact(p) {
  ship.body.updateMatrixWorld();
  V4.copy(p);
  ship.bubble.worldToLocal(V4);
  if (V4.lengthSq() < 1e-6) V4.set(0, 0, -1);
  ship.shieldMat.uniforms.uHitDir.value.copy(V4.normalize());
  G.shieldHit = 1;
}
// returns damage that got through to the hull/cargo
function damage(amount, p, kind) {
  if (G.phase === 'result' || G.phase === 'failed') return 0;
  G.shieldCd = SHIELD_DELAY;
  let rest = amount;
  if (G.shield > 0) {
    const a = Math.min(G.shield, amount);
    G.shield -= a; rest = amount - a;
    shieldImpact(p || V4.copy(shipPos).addScaledVector(shipFwd, 6));
    G.shieldFlash = Math.min(1, G.shieldFlash + 0.5);
    audio.shieldHit();
    pulseRow(hud.rowShield);
    if (G.shield <= 0.01) {
      G.shield = 0;
      audio.shieldDown();
      hud.sDown.classList.remove('on'); void hud.sDown.offsetWidth; hud.sDown.classList.add('on');
      sparkBurst(shipPos, 30, [0.5, 1.4, 1.8]);
    }
  }
  if (rest > 0.01) {
    G.cargo = Math.max(0, G.cargo - rest);
    G.hitFlash = 1;
    pulseRow(hud.rowCargo);
    audio.hit();
    if (G.cargo <= 0) fail('CARGO TANK BREACHED', 'ЦИСТЕРНА ПРОБИТА');
    else if (G.cargo < 30) showMsg('CARGO CRITICAL', 'ГРУЗ НА ИСХОДЕ', 1.4, '#ff8a5a');
  }
  return rest;
}
function hitCargo(dmg, p) {
  if (G.hitCd > 0 || G.phase === 'result' || G.phase === 'failed') return;
  G.hitCd = 0.45;
  G.shake = Math.min(1.4, G.shake + 0.5 + dmg * 0.04);
  G.speed *= 0.8;
  sparkBurst(p || shipPos, 30);
  damage(dmg, p || shipPos, 'collision');
}
function fail(en, ru) {
  if (G.phase === 'failed' || G.phase === 'result') return;
  G.phase = 'failed'; G.phaseT = 0; G.outcome = 'failed'; G.reason = en + ' / ' + ru;
  G.dive = false;
  showMsg('MISSION FAILED', 'МИССИЯ ПРОВАЛЕНА', 3, '#ff7a5a');
  explode(shipPos, 0.8);
  audio.explosion(1.2, 1);
}

// ------------------------------------------------------------------ flight (round-1 handling, unchanged)
const SHIP_R = 3.2;
function toggleDive() {
  if (G.phase !== 'flight') return;
  if (!G.dive && G.air < 3) { showMsg('NO AIR', 'НЕТ ВОЗДУХА', 1.2, '#7ff'); return; }
  G.dive = !G.dive;
  audio.dive();
}

let autoFire = false;
function autopilot(dt) {
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
  // evade a LETHE lock by diving (the canon escape)
  G.apDiveT = Math.max(0, G.apDiveT - dt);
  if (G.lock.phase === 'laser' && G.air > 12) G.apDiveT = 2.6;
  const wantDive = needDive || G.apDiveT > 0;
  input.x = clamp((best - G.lat) * 0.12 - G.vLat * 0.04, -1, 1);
  input.y = clamp((ty - G.y) * 0.2 - G.vY * 0.05, -1, 1);
  if (wantDive !== G.dive && G.phase === 'flight') toggleDive();
  if (G.dive && G.y < -1) input.y = clamp((-5 - G.y) * 0.3, -1, 1);
  input.boost = !G.dive && !NOBOOST;
  input.fire = autoFire;
  // rockets at turrets / drones in the homing cone, only when no mast is near the target
  if (G.rockets > 0 && G.rocketCd <= 0 && !G.underwater) {
    const t = findRocketTarget(shipPos, shipFwd);
    if (t && !MASTS.some((m) => m.alive && m.pts[1].distanceTo(t.wp) < MAST_SPLASH + 30)) input.rocketPressed = true;
  }
}

function updateFlight(dt) {
  const ctl = G.phase === 'flight';
  if (AUTOPILOT && ctl) autopilot(dt);
  const ix = ctl ? input.x : 0, iy = ctl ? input.y : 0;
  if (ctl && input.consumeDive()) toggleDive();
  else input.consumeDive();
  const boosting = ctl && input.boost && !G.dive;
  G.boost += ((boosting ? 1 : 0) - G.boost) * damp(3, dt);

  if (G.phase === 'takeoff') {
    const t = G.phaseT;
    G.y = PAD_TOP + 1.7 + smoothstep(0.3, 2.6, t) * 9;
    G.speed = smoothstep(0.9, 2.8, t) * 45;
    if (t > 2.8) { G.phase = 'flight'; showMsg('FLY TO SETTLEMENT B', 'ЛЕТИТЕ В ПОСЕЛЕНИЕ Б', 2); }
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

  // rocket recoil: brief ~13 % dip of forward progress (fast attack, ~0.3 s hold, smooth recovery).
  // G.speed itself (and thus the handling model) is untouched.
  G.recoilT += dt;
  const rt = G.recoilT;
  const env = rt < 0.06 ? rt / 0.06 : rt < 0.3 ? 1 : 1 - smoothstep(0.3, 0.85, rt);
  G.dip = 0.13 * env;
  G.s += G.speed * (1 - G.dip) * dt;
  G.lat += G.vLat * dt;
  if (G.phase !== 'takeoff' && G.phase !== 'landed') G.y += G.vY * dt;

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
  const yy = Math.max(G.y, 3);
  for (const side of [-1, 1]) {
    const wl = wallLat(G.s + 4, yy, side) - SHIP_R;
    if (side * G.lat > wl) {
      const impact = Math.max(0, side * G.vLat);
      G.lat = side * wl;
      G.vLat = -side * (impact * 0.35 + 7);
      frame(G.s, SF);
      V1.copy(shipPos).addScaledVector(V2.set(SF.rx, 0, SF.rz), side * SHIP_R);
      hitCargo(clamp(4 + impact * 0.35 + G.speed * 0.03, 4, 16), V1.clone());
    }
  }
  for (const r of ROCKS) {
    const ds = G.s - r.s;
    if (ds < -r.r - 6 || ds > r.r + 6) continue;
    if (G.y > r.h + 1) continue;
    const dl = G.lat - r.lat, rr = r.r * 0.92 + SHIP_R;
    const d2 = ds * ds + dl * dl;
    if (d2 < rr * rr) {
      const d = Math.sqrt(d2) || 1;
      if (ds < 0 && Math.abs(dl) < rr * 0.7) {
        G.s = r.s - Math.sqrt(Math.max(0, rr * rr - dl * dl)) - 0.1;
        G.lat += Math.sign(dl || 1) * 1.5;
        G.vLat = Math.sign(dl || 1) * 14;
        G.speed *= 0.55;
      } else {
        G.lat = r.lat + (dl / d) * rr;
        G.vLat = Math.sign(dl) * 12;
      }
      hitCargo(9 + G.speed * 0.06, V1.copy(shipPos).addScaledVector(shipFwd, 5).clone());
    }
  }
  for (const a of ARCHES) {
    const ds = G.s - a.s;
    if (Math.abs(ds) > a.ht + 3) continue;
    const bot = archBottom(a, G.lat), top = archTop(a, G.lat);
    if (G.y > bot - 1.3 && G.y < top + 1.4) {
      if (ds < -a.ht + 1 && G.y < top) {
        G.s = a.s - a.ht - 3.1; G.speed *= 0.45;
      }
      const under = G.y < (bot + top) / 2;
      if (under) { G.y = bot - 1.4; G.vY = -6; } else { G.y = top + 1.5; G.vY = 6; }
      hitCargo(12, V1.copy(shipPos).add(V2.set(0, under ? 3 : -3, 0)).addScaledVector(shipFwd, 4).clone());
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
  // gentle aim assist toward drones / beacons only (never masts or turrets)
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
  b.on = true; b.p.copy(p); b.q.copy(p); b.o.copy(p); b.d.copy(dir); b.life = BOLT_LIFE; b.s = G.s;
  // muzzle flash: HDR sprite burst + brief light
  sparks.emit(p.x, p.y, p.z, shipVel.x, shipVel.y, shipVel.z, 0.07, 4.5, 2.5, 2.4, 1.5, 0.6, 1);
  for (let i = 0; i < 3; i++) sparks.emit(p.x, p.y, p.z, shipVel.x + dir.x * 40 + (Math.random() - 0.5) * 12, shipVel.y + dir.y * 40 + (Math.random() - 0.5) * 12, shipVel.z + dir.z * 40 + (Math.random() - 0.5) * 12, 0.1, 0.6, 0.2, 2, 1.3, 0.5, 1);
  G.muzzleT = 0.06; G.muzzleP = p.clone();
  lightFlash(p, 90, 0.08, 1, 0.7, 0.35);
  // micro-recoil only: tiny camera tremor + ship mesh jolt, never a slowdown
  G.micro = Math.min(0.1, G.micro + 0.05);
  G.jolt = 0.14;
  audio.shot();
}

// ------------------------------------------------------------------ rockets (heavy weapon)
function rocketTargetOK(wp, from, dir, cosMin, range) {
  V3.copy(wp).sub(from);
  const d = V3.length();
  if (d < 12 || d > range) return -1;
  const c = V3.dot(dir) / d;
  return c > cosMin ? c : -1;
}
function findRocketTarget(from, dir) {
  // narrow homing cone toward drones / turrets only — never masts or beacons
  let best = null, bc = 0;
  for (const d of DRONES) if (d.alive && Math.abs(d.s - G.s) < 400) { const c = rocketTargetOK(d.wp, from, dir, 0.975, 380); if (c > bc) { bc = c; best = d; } }
  for (const t of TURRETS) if (t.alive && Math.abs(t.s - G.s) < 400) { const c = rocketTargetOK(t.wp, from, dir, 0.975, 380); if (c > bc) { bc = c; best = t; } }
  return best;
}
function fireRocket() {
  if (G.rocketCd > 0) return;
  if (G.rockets <= 0) { audio.empty(); popScore('NO ROCKETS / НЕТ РАКЕТ'); G.rocketCd = 0.4; return; }
  const r = rockets.find((x) => !x.on);
  if (!r) return;
  G.rockets--; G.rocketsFired++; G.rocketCd = ROCKET_CD;
  ship.body.updateMatrixWorld();
  const p = ship.body.localToWorld(V1.set(0, -1.15, -5.5));
  r.on = true; r.p.copy(p); r.q.copy(p); r.life = 3.2; r.s = G.s; r.age = 0;
  r.v.copy(shipVel).addScaledVector(shipFwd, 25);
  r.target = findRocketTarget(p, shipFwd);
  // recoil: forward dip, nose kick, camera push-back + short shake
  G.recoilT = 0; G.kick = 1;
  G.shake = Math.min(1.4, G.shake + 0.42);
  for (let i = 0; i < 14; i++) mist.emit(p.x, p.y, p.z, shipVel.x * 0.3 + (Math.random() - 0.5) * 8, (Math.random() - 0.3) * 5, shipVel.z * 0.3 + (Math.random() - 0.5) * 8, 1 + Math.random(), 2, 7, 0.75, 0.72, 0.7, 0.55, -0.5, 1.2);
  sparks.emit(p.x, p.y, p.z, shipVel.x, shipVel.y, shipVel.z, 0.12, 6, 4, 2.4, 1.3, 0.5, 1);
  lightFlash(p, 260, 0.18, 1, 0.65, 0.3);
  audio.rocket();
}
function detonateRocket(r, direct) {
  const p = r.p;
  r.on = false;
  explode(p, 1.6);
  // splash damage: everything near the blast — including the force-field masts (risky!)
  for (const d of DRONES) if (d.alive && d.wp.distanceTo(p) < ROCKET_SPLASH) killTarget('drone', d);
  for (const b of BEACONS) if (b.alive && b.wp.distanceTo(p) < ROCKET_SPLASH) killTarget('beacon', b);
  for (const t of TURRETS) if (t.alive && t.wp.distanceTo(p) < ROCKET_SPLASH) killTarget('turret', t);
  for (const m of MASTS) if (m.alive && m.pts.some((pt) => pt.distanceTo(p) < MAST_SPLASH)) breakMast(m);
  if (p.y < 1.5) splash(p, 120, 1.3);
  const ds = p.distanceTo(shipPos);
  if (ds < 14 && G.phase === 'flight') damage(18 * (1 - ds / 14), p.clone(), 'blast');
}
function updateRockets(dt) {
  for (const r of rockets) {
    if (!r.on) continue;
    r.age += dt; r.life -= dt;
    // accelerate to ~190 m/s, light homing (≤ 1.3 rad/s) toward the locked drone/turret
    const sp = Math.min(190, r.v.length() + 260 * dt);
    V3.copy(r.v).normalize();
    if (r.target && r.target.alive) {
      V4.copy(r.target.wp).sub(r.p).normalize();
      const ang = Math.acos(clamp(V3.dot(V4), -1, 1));
      if (ang > 1e-4) V3.lerp(V4, Math.min(1, (1.3 * dt) / ang)).normalize();
    }
    r.v.copy(V3).multiplyScalar(sp);
    r.q.copy(r.p);
    r.p.addScaledVector(r.v, dt);
    let hit = r.life <= 0;
    if (!hit) for (const d of DRONES) if (d.alive && Math.abs(d.s - r.s) < 50 && segSphere(r.q, r.p, d.wp, 3.2)) { hit = true; break; }
    if (!hit) for (const t of TURRETS) if (t.alive && Math.abs(t.s - r.s) < 50 && segSphere(r.q, r.p, t.wp, 3)) { hit = true; break; }
    if (!hit) for (const b of BEACONS) if (b.alive && Math.abs(b.s - r.s) < 50 && segSphere(r.q, r.p, b.wp, 2.4)) { hit = true; break; }
    if (!hit) for (const m of MASTS) if (m.alive && Math.abs(m.s - r.s) < 50 && m.pts.some((pt) => segSphere(r.q, r.p, pt, 2.1))) { hit = true; break; }
    if (!hit && r.age > 0.08) {
      // terrain / water
      const pr = projectToPath(r.p.x, r.p.z, r.s);
      r.s = pr.s;
      const side = pr.lat > 0 ? 1 : -1;
      if (side * pr.lat > wallLat(r.s, r.p.y, side) || r.p.y < 0) hit = true;
      else for (const k of ROCKS) if (Math.abs(k.s - r.s) < k.r + 2 && r.p.y < k.h && Math.abs(k.lat - pr.lat) < k.r) { hit = true; break; }
      if (!hit) for (const a of ARCHES) if (Math.abs(a.s - r.s) < a.ht && r.p.y > archBottom(a, pr.lat) && r.p.y < archTop(a, pr.lat)) { hit = true; break; }
    }
    if (hit) { detonateRocket(r); continue; }
    // visible smoke trail + orange exhaust glow + flame
    V3.copy(r.v).normalize();
    const tail = V4.copy(r.p).addScaledVector(V3, -1.2);
    beams.add(tail.x - V3.x * 3.5, tail.y - V3.y * 3.5, tail.z - V3.z * 3.5, tail.x, tail.y, tail.z, 0.8, 2.4, 1.0, 0.3, 1);
    glows.add(tail.x, tail.y, tail.z, 2.2, 1.1, 0.35, 1, 3.6);
    glows.add(tail.x, tail.y, tail.z, 1.4, 0.6, 0.2, 0.35, 9);
    for (let k = 0; k < 2; k++) {
      const f = Math.random();
      mist.emit(r.q.x + (r.p.x - r.q.x) * f, r.q.y + (r.p.y - r.q.y) * f, r.q.z + (r.p.z - r.q.z) * f,
        (Math.random() - 0.5) * 2, 0.6 + Math.random(), (Math.random() - 0.5) * 2, 1.8 + Math.random() * 1.4, 1.4, 8, 0.8, 0.77, 0.74, 0.6, -0.4, 0.8);
    }
  }
}
function segSphere(a, b, c, r) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz || 1;
  const t = clamp(((c.x - a.x) * abx + (c.y - a.y) * aby + (c.z - a.z) * abz) / l2, 0, 1);
  const dx = a.x + abx * t - c.x, dy = a.y + aby * t - c.y, dz = a.z + abz * t - c.z;
  return dx * dx + dy * dy + dz * dz < r * r;
}
function killTarget(kind, obj) {
  obj.alive = false;
  G.kills++;
  const pts = kind === 'drone' ? 150 : kind === 'turret' ? 250 : 100;
  G.score += pts;
  explode(kind === 'turret' ? obj.wp : obj.wp, kind === 'beacon' ? 0.8 : kind === 'turret' ? 1.3 : 1);
  audio.score();
  const label = { drone: 'SPOTTER / ДРОН', beacon: 'BEACON / МАЯК', turret: 'TURRET / ТУРЕЛЬ' }[kind];
  popScore(`+${pts} ${label}`);
  if (kind === 'beacon') { beacons.setMatrixAt(BEACONS.indexOf(obj), ZERO_M); beacons.instanceMatrix.needsUpdate = true; }
  if (kind === 'drone' && obj.spotting) {
    // killing the spotter wipes the mark and breaks a pending lock
    G.mark = 0;
    if (G.lock.phase === 'laser') G.lock.phase = 'none';
    obj.spotting = false;
    showMsg('SPOTTER DOWN — MARK CLEARED', 'СПОТТЕР СБИТ — МЕТКА СНЯТА', 1.6, '#9ff2d8');
  }
  if (kind === 'turret') { G.turretKills++; if (G.lock.turret === obj) G.lock.phase = 'none'; }
}
function breakMast(m) {
  m.alive = false;
  G.mastsBroken++;
  G.score = Math.max(0, G.score - 300);
  m.zone.shielded = false;
  explode(m.top, 1.1, true);
  audio.collapse();
  setMastMatrix(m, MASTS.indexOf(m));
  showMsg('MAST HIT — FIELD DOWN', 'МАЧТА СБИТА — ПОЛЕ СНЯТО', 2.6, '#ff8a5a');
  popScore('−300 MAST / МАЧТА');
  zoneEls[ZONES.indexOf(m.zone)].classList.add('off');
}
// world collision of a moving bolt: returns true if it hit terrain/water (and spawns the effect)
function boltWorldHit(b) {
  const pr = projectToPath(b.p.x, b.p.z, b.s);
  b.s = pr.s;
  const y = b.p.y;
  const side = pr.lat > 0 ? 1 : -1;
  if (side * pr.lat > wallLat(b.s, y, side)) { surfaceHit(b.p); return true; }
  if (y < 0) { splash(b.p, 10, 0.5); sparks.emit(b.p.x, 0.3, b.p.z, 0, 0, 0, 0.15, 3, 5, 0.9, 1.4, 1.4, 1); return true; }
  for (const r of ROCKS) if (Math.abs(r.s - b.s) < r.r + 2 && y < r.h && Math.abs(r.lat - pr.lat) < r.r) { surfaceHit(b.p); return true; }
  for (const a of ARCHES) if (Math.abs(a.s - b.s) < a.ht && y > archBottom(a, pr.lat) && y < archTop(a, pr.lat)) { surfaceHit(b.p); return true; }
  return false;
}
function updateBolts(dt) {
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
    if (!dead) for (const t of TURRETS) {
      if (!t.alive || Math.abs(t.s - b.s) > 40) continue;
      if (segSphere(b.q, b.p, t.wp, 2.6)) { killTarget('turret', t); dead = true; break; }
    }
    if (!dead) dead = boltWorldHit(b);
    if (dead) { b.on = false; continue; }
    // glowing tracer: bright core + additive glow + short trail
    const tl = Math.min(11, b.p.distanceTo(b.o));
    V3.copy(b.p).addScaledVector(b.d, -tl);
    beams.add(V3.x, V3.y, V3.z, b.p.x, b.p.y, b.p.z, 0.55, 2.2, 1.15, 0.4, 1);
    glows.add(b.p.x, b.p.y, b.p.z, 1.6, 0.9, 0.35, 0.9, 2.4);
  }
}

// ------------------------------------------------------------------ LETHE: spotters, mark, turrets
const LOS_P = new THREE.Vector3();
function lineOfSight(a, b, sA) {
  for (let k = 1; k < 6; k++) {
    LOS_P.lerpVectors(a, b, k / 6);
    const pr = projectToPath(LOS_P.x, LOS_P.z, sA + (k / 6) * 60);
    const side = pr.lat > 0 ? 1 : -1;
    if (side * pr.lat > wallLat(pr.s, Math.max(3, LOS_P.y), side) - 1) return false;
    for (const ar of ARCHES) if (Math.abs(ar.s - pr.s) < ar.ht && LOS_P.y > archBottom(ar, pr.lat) && LOS_P.y < archTop(ar, pr.lat)) return false;
  }
  return true;
}
function fireTurret(t, target, accurate) {
  const b = ebolts.find((x) => !x.on);
  if (!b) return;
  b.on = true; b.p.copy(t.muzzle); b.q.copy(t.muzzle); b.o.copy(t.muzzle);
  b.d.copy(target).sub(t.muzzle).normalize();
  b.life = 3; b.s = t.s; b.accurate = accurate; b.minD = 1e9;
  G.turretShotsFired++;
  sparks.emit(t.muzzle.x, t.muzzle.y, t.muzzle.z, 0, 0, 0, 0.12, 6, 3, 2.4, 0.4, 0.2, 1);
  lightFlash(t.muzzle, 160, 0.12, 1, 0.25, 0.15);
  audio.turretShot(panOf(t.muzzle) * 0.8);
}
// predict where the ship will be along the (curving) canyon when the bolt arrives
function leadTarget(from, out) {
  let tf = from.distanceTo(shipPos) / EB_SPEED;
  for (let k = 0; k < 3; k++) {
    toWorld(G.s + G.speed * tf, G.lat + G.vLat * tf * 0.8, Math.max(1.2, G.y + G.vY * tf * 0.5), out);
    tf = from.distanceTo(out) / EB_SPEED;
  }
  return out;
}
function updateLethe(dt, time) {
  const active = G.phase === 'flight';
  const L = G.lock;
  // --- spotters
  G.spotters = 0;
  let nb = 0;
  for (const d of DRONES) {
    d.spotting = false;
    if (!active || !d.alive || G.underwater) continue;
    const ds = d.s - G.s;
    if (ds < -30 || ds > 250) continue;
    if (d.wp.distanceTo(shipPos) > 250) continue;
    if (!lineOfSight(d.wp, shipPos, d.s)) continue;
    d.spotting = true;
    G.spotters++;
    if (!G.droneHinted) {
      G.droneHinted = true;
      toast('<b>Drones = LETHE\'s eyes.</b> Shoot them before they mark you — or dive.<br><i>Дроны — глаза ЛЕТЫ: сбей или ныряй.</i>', 5);
    }
    if (nb < brackets.length) {
      V3.copy(d.wp).project(camera);
      const el = brackets[nb++];
      if (V3.z < 1 && Math.abs(V3.x) < 0.9 && Math.abs(V3.y) < 0.85) {
        const sc = 0.85 + 0.25 * Math.sin(time * 12) + 0.3 * (1 - G.mark);
        el.style.display = 'block';
        el.style.transform = `translate(${(V3.x * 0.5 + 0.5) * innerWidth}px,${(-V3.y * 0.5 + 0.5) * innerHeight}px) scale(${sc})`;
        el.style.opacity = 0.65 + 0.35 * Math.sin(time * 14);
      } else el.style.display = 'none';
    }
  }
  for (let i = nb; i < brackets.length; i++) brackets[i].style.display = 'none';
  // --- mark meter
  if (G.spotters > 0) G.mark = Math.min(1, G.mark + dt / 3.4);
  else G.mark = Math.max(0, G.mark - dt * (G.underwater ? 1.4 : 0.28));
  if (G.spotters > 0 && G.mark < 1) {
    G.markBeep -= dt;
    if (G.markBeep <= 0) { audio.lockTick(G.mark); G.markBeep = lerp(0.42, 0.09, G.mark); }
  }
  // --- lock sequence: laser designation -> accurate volley -> cooldown
  if (L.phase === 'none' && G.mark >= 1 && active) {
    let best = null, bd = 1e9;
    for (const t of TURRETS) {
      if (!t.alive) continue;
      const ds = t.s - G.s;
      if (ds < -90 || ds > 450) continue;
      const d = Math.abs(ds - 120);
      if (d < bd) { bd = d; best = t; }
    }
    if (best) {
      L.phase = 'laser'; L.t = 1.35; L.turret = best; L.shots = 0; G.lostSaid = false;
      audio.lockOn(); audio.laser();
      showMsg('LETHE LOCK — DIVE OR DODGE', 'ЗАХВАТ ЛЕТЫ — НЫРЯЙ', 1.6, '#ff6a50');
    }
  }
  if (L.phase === 'laser') {
    L.t -= dt;
    if (G.underwater || !active) {
      L.phase = 'none'; G.mark = Math.min(G.mark, 0.5);
      if (!G.lostSaid && active) { G.lostSaid = true; toast('LETHE: <i>“…and I lost him.”</i> &nbsp;/&nbsp; ЛЕТА: <i>«…и я потеряла его.»</i>', 3.5); audio.lost(); }
    } else if (L.t <= 0) { L.phase = 'volley'; L.t = 0; L.shots = 0; }
  } else if (L.phase === 'volley') {
    L.t -= dt;
    if (L.t <= 0 && L.turret.alive) {
      fireTurret(L.turret, leadTarget(L.turret.muzzle, V4), true);
      L.shots++; L.t = 0.22;
      if (L.shots >= 3) { L.phase = 'cool'; L.t = 2.2; G.mark = 0.35; }
    } else if (!L.turret.alive) { L.phase = 'cool'; L.t = 1; }
  } else if (L.phase === 'cool') {
    L.t -= dt;
    if (L.t <= 0) L.phase = 'none';
  }
  // --- turrets: track the ship, rare inaccurate harassment when unmarked
  for (let i = 0; i < TURRETS.length; i++) {
    const t = TURRETS[i];
    const near = t.s > G.s - 150 && t.s < G.s + 1300;
    if (!near) { turrets.setMatrixAt(i, ZERO_M); continue; }
    if (!t.alive) {
      pathBasis(t.s, M1);
      M1.multiply(M2.makeRotationX(0.5)).multiply(M2.makeRotationZ(t.side * 0.7));
      M1.setPosition(V3.copy(t.wp).add(V2.set(0, -0.8, 0)));
      turrets.setMatrixAt(i, M1);
      if (Math.random() < dt * 4) mist.emit(t.wp.x, t.wp.y + 1, t.wp.z, 0, 3, 0, 2.5, 2, 9, 0.15, 0.13, 0.12, 0.45, -0.6, 0.3);
      continue;
    }
    // aim (smoothly) at the ship
    V3.copy(shipPos).sub(t.wp).normalize();
    t.aim.lerp(V3, damp(L.turret === t && L.phase !== 'none' ? 8 : 2.5, dt)).normalize();
    M1.lookAt(V1.set(0, 0, 0), t.aim, UP);
    M1.setPosition(t.wp);
    turrets.setMatrixAt(i, M1);
    t.muzzle.set(0, 1.0, -4.3).applyMatrix4(M1);
    t.eye.set(0, 1.35, -1.6).applyMatrix4(M1);
    const locked = L.turret === t && (L.phase === 'laser' || L.phase === 'volley');
    glows.add(t.eye.x, t.eye.y, t.eye.z, 2.2, 0.15, 0.08, locked ? 1 : 0.55 + 0.35 * Math.sin(time * 4 + i), locked ? 5 : 3);
    if (!active || G.underwater) continue;
    const ds = t.s - G.s;
    if (!locked && ds > -40 && ds < 360 && G.mark < 0.5) {
      t.cd -= dt;
      if (t.cd <= 0) {
        t.cd = 6 + Math.random() * 5;
        V4.copy(shipPos).add(V2.set((Math.random() - 0.5) * 28, 4 + Math.random() * 10, (Math.random() - 0.5) * 28));
        if (lineOfSight(t.wp, shipPos, t.s)) fireTurret(t, V4, false);
      }
    }
  }
  turrets.instanceMatrix.needsUpdate = true;
  // targeting laser
  if (L.phase === 'laser' && L.turret) {
    const m = L.turret.muzzle;
    const jit = (1 - L.t / 1.35);
    V3.copy(shipPos).add(V2.set((Math.random() - 0.5) * 3 * (1 - jit), (Math.random() - 0.5) * 2 * (1 - jit), 0));
    const fl = 0.7 + 0.3 * Math.sin(time * 60);
    beams.add(m.x, m.y, m.z, V3.x, V3.y, V3.z, 0.18 + 0.12 * jit, 2.4, 0.15, 0.08, fl);
    glows.add(m.x, m.y, m.z, 2, 0.2, 0.1, 1, 6);
    glows.add(V3.x, V3.y, V3.z, 2, 0.3, 0.15, 0.6 + 0.4 * jit, 3);
  }
  // --- enemy bolts
  for (const b of ebolts) {
    if (!b.on) continue;
    b.q.copy(b.p);
    b.p.addScaledVector(b.d, EB_SPEED * dt);
    b.life -= dt;
    b.minD = Math.min(b.minD, b.p.distanceTo(shipPos));
    let dead = b.life <= 0;
    if (!dead && G.phase !== 'result' && segSphere(b.q, b.p, shipPos, 3.8)) {
      G.turretHits++;
      const through = damage(EB_DMG, b.p.clone(), 'bolt');
      G.shake = Math.min(1.4, G.shake + 0.45);
      sparkBurst(b.p, 18, through > 0 ? [1.8, 0.9, 0.4] : [0.6, 1.5, 2]);
      explodeSmall(b.p);
      dead = true;
    }
    if (!dead && b.life < 2.9) { dead = boltWorldHit(b); if (dead) b.why = 'world'; }
    if (dead) { b.on = false; if (b.accurate) G.ebLog.push((b.why || 'x') + ':' + b.minD.toFixed(1) + '@' + (3 - b.life).toFixed(2)); b.why = null; continue; }
    const tl = Math.min(9, b.p.distanceTo(b.o));
    V3.copy(b.p).addScaledVector(b.d, -tl);
    beams.add(V3.x, V3.y, V3.z, b.p.x, b.p.y, b.p.z, 0.75, 2.4, 0.3, 0.15, 1);
    glows.add(b.p.x, b.p.y, b.p.z, 2.2, 0.35, 0.15, 1, 3.4);
  }
}
function explodeSmall(p) {
  for (let i = 0; i < 6; i++) sparks.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, 0.35, 2, 5, 2, 0.7, 0.3, 1, 0, 2);
  lightFlash(p, 220, 0.2, 1, 0.5, 0.25);
}

// ------------------------------------------------------------------ targets & fields
function updateTargets(dt, time) {
  for (let i = 0; i < DRONES.length; i++) {
    const d = DRONES[i];
    if (!d.alive) { drones.setMatrixAt(i, ZERO_M); d.wp.set(0, -1e4, 0); continue; }
    const near = d.s > G.s - 120 && d.s < G.s + 1300;
    if (!near) { drones.setMatrixAt(i, ZERO_M); d.wp.set(0, -1e4, 0); continue; }
    const s = d.s + Math.sin(time * 0.4 + d.phase) * 6;
    let lat = d.lat + Math.sin(time * d.speed + d.phase) * d.amp;
    const y = d.y + Math.sin(time * 1.3 + d.phase * 2) * 1.8;
    const wl = Math.min(wallLat(s, y, 1), wallLat(s, y, -1)) - 6;
    lat = clamp(lat, -wl, wl);
    toWorld(s, lat, y, d.wp);
    pathBasis(s, M1);
    if (d.spotting) {
      // the spotter turns its red lens to face the ship
      V3.copy(shipPos).sub(d.wp); V3.y = 0;
      M1.lookAt(V1.set(0, 0, 0), V3.normalize(), UP);
    } else M1.multiply(M2.makeRotationY(time * 0.6 + d.phase));
    M1.multiply(M2.makeRotationZ(Math.sin(time * d.speed + d.phase) * 0.25));
    M1.setPosition(d.wp);
    drones.setMatrixAt(i, M1);
    const blink = d.spotting ? 1 : 0.6 + 0.4 * Math.sin(time * 9 + d.phase);
    glows.add(d.wp.x, d.wp.y - 0.2, d.wp.z, 1.8, 0.25, 0.1, blink, d.spotting ? 4 : 2.6);
    for (let k = 0; k < 4; k++) {
      const a = time * 0.6 + d.phase + k * Math.PI / 2;
      // rotor shimmer
      glows.add(d.wp.x + Math.cos(a) * 2, d.wp.y + 0.2, d.wp.z + Math.sin(a) * 2, 0.6, 0.55, 0.5, 0.18, 2.2);
    }
  }
  drones.instanceMatrix.needsUpdate = true;
  for (const b of BEACONS) {
    if (!b.alive || b.s < G.s - 100 || b.s > G.s + 1300) continue;
    const on = Math.sin(time * 5 + b.phase) > 0.2 ? 1 : 0.12;
    glows.add(b.wp.x, b.wp.y + 0.2, b.wp.z, 1.8, 0.7, 0.15, on, 5.5);
  }
  for (const m of MASTS) {
    if (m.s < G.s - 100 || m.s > G.s + 1300) continue;
    if (m.alive) {
      const pu = 0.75 + 0.25 * Math.sin(time * 3 + m.s);
      glows.add(m.top.x, m.top.y + 1.2, m.top.z, 0.5, 1.5, 1.7, pu, 8);
      glows.add(m.pts[1].x, m.pts[1].y, m.pts[1].z, 0.3, 1.0, 1.2, 0.35 * pu, 4);
    } else if (Math.random() < dt * 6) {
      sparkBurst(m.pts[1], 3, [0.6, 1.4, 1.8]);
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
      u.uFlick.value = k < 1.8 ? (Math.random() < 0.5 ? 0.15 : 1.8) : 0;
      if (k > 1.9) z.mesh.visible = false;
    }
  }
  const cx = camera.position.x, cz = camera.position.z;
  for (const g of STATIC_GLOWS) {
    const dx = g.p.x - cx, dz = g.p.z - cz;
    if (dx * dx + dz * dz > 1500 * 1500) continue;
    const a = g.blink < 0 ? 0.8 : (Math.sin(time * 3 + g.blink * 4) > 0 ? 1 : 0.2);
    glows.add(g.p.x, g.p.y, g.p.z, g.c[0], g.c[1], g.c[2], a, g.size);
  }
  // steam / smoke from the settlements
  for (const v of VENTS) {
    if (v.p.distanceToSquared(camera.position) > 700 * 700) continue;
    if (Math.random() < dt * 9) {
      const c = v.k ? [0.3, 0.27, 0.25] : [0.92, 0.9, 0.88];
      mist.emit(v.p.x + (Math.random() - 0.5) * 2, v.p.y, v.p.z + (Math.random() - 0.5) * 2, 1 + Math.random(), 3 + Math.random() * 2, (Math.random() - 0.5),
        4 + Math.random() * 2, 3, 14, c[0], c[1], c[2], v.k ? 0.45 : 0.35, -0.4, 0.2);
    }
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
    // the ship's shield soaks ~50 % of the dose while charged, and is slowly drained by it
    let soak = 1;
    if (G.rad > 0.02 && G.shield > 0) {
      soak = 0.5;
      G.shield = Math.max(0, G.shield - G.rad * 7 * dt);
      G.shieldCd = Math.max(G.shieldCd, 1.2);
      if (G.shield <= 0) { audio.shieldDown(); hud.sDown.classList.remove('on'); void hud.sDown.offsetWidth; hud.sDown.classList.add('on'); }
    }
    G.health -= G.rad * 5.5 * soak * dt;
    if (exposed && z !== G.lastZone) showMsg('NO FIELD — RADIATION', 'НЕТ ПОЛЯ — РАДИАЦИЯ · НЫРЯЙТЕ', 2.4, '#ff6a4a');
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
  // shield regeneration
  G.shieldCd -= dt;
  const wasRegen = G.regen;
  G.regen = false;
  if (G.shieldCd <= 0 && G.shield < SHIELD_MAX && G.phase !== 'failed') {
    G.shield = Math.min(SHIELD_MAX, G.shield + SHIELD_REGEN * dt);
    if (!wasRegen && G.shield < 85) audio.shieldUp();   // soft rising tone as regeneration kicks in
    G.regen = true;
  }
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
  G.kick = Math.max(0, G.kick - dt * 3.2);
  const kickA = 0.16 * Math.sin(Math.min(1, 1 - G.kick) * Math.PI) * (G.kick > 0 ? 1 : 0);   // nose-up kick (visual only)
  ship.group.rotation.set(G.pitch + kickA, -SF.th + G.yaw, G.roll + Math.sin(time * 1.3) * 0.015, 'YXZ');
  G.jolt = Math.max(0, G.jolt - dt * 2.2);
  ship.body.position.z = G.jolt * G.jolt * 3 + Math.sin(Math.min(1, 1 - G.kick) * Math.PI) * (G.kick > 0 ? 0.5 : 0);
  const running = G.phase !== 'start' && G.phase !== 'landed' && G.phase !== 'result';
  const power = running ? 1 + G.boost * 0.6 : 0.35;
  ship.animate(dt, G.dive || G.underwater, G.boost, time, running ? 1 : 0.25);
  shipFwd.set(0, 0, -1).applyQuaternion(ship.group.quaternion);
  const fwdV = G.speed * (1 - G.dip);
  shipVel.set(SF.tx * fwdV + SF.rx * G.vLat, G.vY, SF.tz * fwdV + SF.rz * G.vLat);

  // shield bubble
  const su = ship.shieldMat.uniforms;
  G.shieldHit = Math.max(0, G.shieldHit - dt * 2.2);
  G.shieldFlash = Math.max(0, G.shieldFlash - dt * 3);
  const on = G.shield > 0 ? 1 : 0;
  G.shieldOn += (on - G.shieldOn) * damp(on ? 3 : 10, dt);
  const flick = G.shield > 0 ? (G.shield < 25 ? (Math.random() < 0.15 ? 0.3 : 1) : 1) : (Math.random() < 0.08 ? 0.6 : 0);
  su.uTime.value = time; su.uCharge.value = 0.4 + 0.6 * G.shield / SHIELD_MAX; su.uHit.value = G.shieldHit;
  su.uFlash.value = G.shieldFlash; su.uOn.value = Math.max(G.shieldOn, G.shieldHit) * flick;
  su.uRegen.value = G.regen ? 0.5 + 0.5 * Math.sin(time * 8) : 0;
  ship.bubble.visible = !camUnder || G.shieldHit > 0;

  ship.group.updateMatrixWorld();
  const gc = ship.glowColor;
  for (const nz of ship.nozzles) {
    nozW.copy(nz).applyMatrix4(ship.body.matrixWorld);
    glows.add(nozW.x, nozW.y, nozW.z, gc.r, gc.g * 0.85, gc.b * 0.7, 0.5 * power, 2.0 * power);
    glows.add(nozW.x, nozW.y, nozW.z, gc.r, gc.g * 0.7, gc.b * 0.5, 0.12 * power, 5.5 * power);
    if (!running) continue;
    if (G.underwater) {
      if (Math.random() < 0.8) mist.emit(nozW.x + (Math.random() - 0.5), nozW.y, nozW.z + (Math.random() - 0.5), shipVel.x * 0.2, 1 + Math.random() * 2, shipVel.z * 0.2, 1.4, 0.3, 0.9, 0.7, 1, 1, 0.75, -6, 1.5);
    } else {
      sparks.emit(nozW.x, nozW.y, nozW.z, shipVel.x * 0.4 - shipFwd.x * 20, shipVel.y * 0.4 - shipFwd.y * 20, shipVel.z * 0.4 - shipFwd.z * 20,
        0.12 + G.boost * 0.1, 1.6, 0.5, gc.r, gc.g * 0.75, gc.b * 0.5, 0.35, 0, 0);
    }
  }
  // wing-tip nav lights
  if (running) for (let i = 0; i < 2; i++) {
    nozW.copy(ship.navLights[i]).applyMatrix4(ship.wings[i].matrixWorld);
    const on = Math.sin(time * 6 + i * 3) > 0.6;
    glows.add(nozW.x, nozW.y, nozW.z, i ? 0.3 : 2, i ? 2 : 0.3, 0.3, on ? 1 : 0.15, 1.4);
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
  const wk = running && !G.underwater ? clamp((7 - G.y) / 6, 0, 1) * Math.min(1, G.speed / 40) : 0;
  wake.update(dt, shipPos.x, shipPos.z, SF.rx, SF.rz, wk);
  wake.mat.uniforms.uTime.value = time;
  if (G.underwater && Math.random() < 0.5) {
    mist.emit(shipPos.x + (Math.random() - 0.5) * 30, -8 + Math.random() * 8, shipPos.z + (Math.random() - 0.5) * 30, 0, 0.8, 0, 3, 0.25, 0.5, 0.6, 1, 1, 0.4, -1, 0);
  }
  // blob shadow projected along the sun onto the water
  const bh = Math.max(0, G.y);
  blob.visible = G.y > -0.3 && bh < 40;
  blob.position.set(shipPos.x - SUN.x / SUN.y * bh * 0.6, 0.04, shipPos.z - SUN.z / SUN.y * bh * 0.6);
  blob.scale.set(9 + bh * 0.25, 12 + bh * 0.3, 1);
  blob.rotation.z = SF.th;
  blob.material.uniforms.uA.value = 0.42 * clamp(1 - bh / 40, 0, 1);
  // shadow camera follows the ship
  sunL.target.position.copy(shipPos);
  sunL.position.copy(shipPos).addScaledVector(SUN, 120);
}

// ------------------------------------------------------------------ camera
let fovCur = 68;
const CAM_MARGIN = 5;
function updateCamera(dt, time) {
  const under = G.underwater;
  const start = G.phase === 'start';
  const wide = clamp((camera.aspect - 1.7) / 0.6, 0, 1);   // phones in landscape: a touch further
  // slightly tighter in the narrow slots so the near wall doesn't fill the frame
  G.camNarrow = (G.camNarrow || 0) + (narrowAt(G.s) - (G.camNarrow || 0)) * damp(1.5, dt);
  const dist = (start ? 30 : 30 * (1 - 0.17 * G.camNarrow)) + G.boost * 2.6 - (under ? 6 : 0) + G.dip * 22;
  const hgt = under ? 4.6 : (start ? 9 : 10.6 + wide * 0.6 + G.boost * 0.8);
  // behind the ship along its heading (start screen: slow cinematic orbit)
  const orbit = start ? 0.45 + Math.sin(time * 0.12) * 0.25 : 0;
  V1.set(-Math.sin(SF.th - G.yaw * 0.6 + orbit), 0, Math.cos(SF.th - G.yaw * 0.6 + orbit));
  V2.copy(V1).multiplyScalar(dist);
  V2.y = hgt - G.pitch * 7;
  if (!camInit) { camOff.copy(V2); camInit = true; camLatAdj = 0; }
  camOff.x += (V2.x - camOff.x) * damp(5, dt);
  camOff.z += (V2.z - camOff.z) * damp(5, dt);
  camOff.y += (V2.y - camOff.y) * damp(4, dt);
  camPos.copy(shipPos).add(camOff);
  // keep the camera inside the canyon walls (analytic wall function) with a margin, smoothed
  const pr = projectToPath(camPos.x, camPos.z, G.s - dist);
  const cs = pr.s, cl = pr.lat;
  const cy = Math.max(camPos.y, 3);
  const lo = -(wallLat(cs, cy, -1) - CAM_MARGIN), hi = wallLat(cs, cy, 1) - CAM_MARGIN;
  let want = clamp(cl, lo, hi) - cl;
  // also keep the camera->ship sight line off the inner wall of tight bends
  V3.lerpVectors(camPos, shipPos, 0.5);
  const pm = projectToPath(V3.x, V3.z, G.s - dist * 0.5);
  const my = Math.max(3, V3.y);
  const ml = -(wallLat(pm.s, my, -1) - 2), mh = wallLat(pm.s, my, 1) - 2;
  if (pm.lat > mh) want += (mh - pm.lat) * 2; else if (pm.lat < ml) want += (ml - pm.lat) * 2;
  camLatAdj += (want - camLatAdj) * damp(9, dt);
  let lat = cl + camLatAdj;
  lat = clamp(lat, -(wallLat(cs, cy, -1) - 1.5), wallLat(cs, cy, 1) - 1.5);   // hard guarantee
  toWorld(cs, lat, camPos.y, camPos);
  if (G.y < -0.6) camPos.y = Math.min(camPos.y, -1.1);
  else if (G.y > 0.3) camPos.y = Math.max(camPos.y, 1.0 + Math.max(0, bankY(cs, lat)));
  camera.position.copy(camPos);
  // shake
  G.shake = Math.max(0, G.shake - dt * 1.8);
  G.micro = Math.max(0, G.micro - dt * 0.9);
  const sh = G.shake * G.shake * 0.9 + G.micro + (G.phase === 'flight' ? G.speed / 95 * 0.04 + G.boost * 0.07 : 0);
  camera.position.x += (Math.random() - 0.5) * sh;
  camera.position.y += (Math.random() - 0.5) * sh;
  camera.position.z += (Math.random() - 0.5) * sh;
  camLook.copy(shipPos).addScaledVector(shipFwd, 40);
  camLook.y = shipPos.y + 2.6 + (under ? -1 : 0.5);
  if (start) {
    // frame the ship low in the gap between the title and the brief
    V3.copy(shipPos).sub(camPos); V3.y = 0; V3.normalize();
    V2.crossVectors(V3, UP).normalize();
    camLook.copy(shipPos).addScaledVector(V2, 6.5).add(V3.set(0, 6, 0));
  }
  camera.lookAt(camLook);
  camera.rotateZ(G.roll * 0.22);
  const fovT = 64 + clamp((G.speed - 60) * 0.18, -6, 8) + G.boost * 12;
  fovCur += (fovT - fovCur) * damp(3, dt);
  if (Math.abs(camera.fov - fovCur) > 0.05) { camera.fov = fovCur; camera.updateProjectionMatrix(); }

  // underwater look (codex-style teal fog, shorter distance)
  const cu = camera.position.y < 0;
  if (cu !== camUnder) {
    camUnder = cu;
    scene.fog.color.copy(cu ? FOG_WATER : FOG_AIR);
    scene.fog.density = cu ? FOG_D_WATER : FOG_D_AIR;
    scene.background.copy(cu ? FOG_WATER : FOG_AIR);
    sky.visible = !cu;
    shafts.visible = !cu && quality !== 'low';
    const fd = cu ? FOG_D_WATER : FOG_D_AIR;
    for (const m of [glows.mat, sparks.out.mat, mist.out.mat, beams.mat, foam.material, wake.mat]) m.uniforms.uFogD.value = fd;
    mist.out.mat.uniforms.uFogCol.value.copy(scene.fog.color);
    for (const z of ZONES) if (z.mesh) z.mesh.material.uniforms.uFogD.value = fd;
    hemi.intensity = cu ? 1.3 : 1.85;
    sunL.intensity = cu ? 1.2 : 2.6;
    hud.tintUnder.style.opacity = cu ? 1 : 0;
    post.grade.uniforms.uTintK.value = 0;
  }
  // speed streaks / dust
  const su = streaks.mat.uniforms;
  su.uCenter.value.copy(camera.position).addScaledVector(shipFwd, 40);
  su.uVel.value.copy(shipVel);
  su.uLen.value = cu ? 0.012 : 0.035 + G.boost * 0.05;
  su.uOp.value = cu ? 0.35 : (G.phase === 'flight' ? 0.18 + G.boost * 0.45 : 0.05);
  su.uCol.value.setRGB(cu ? 0.4 : 1, cu ? 0.9 : 0.82, cu ? 0.85 : 0.62);
  const mu = motes.mat.uniforms;
  mu.uCenter.value.copy(camera.position); mu.uTime.value = time;
  mu.uCol.value.setRGB(cu ? 0.5 : 1, cu ? 0.95 : 0.85, cu ? 0.9 : 0.65);
  mu.uOp.value = cu ? 0.7 : 0.55;
}

// ------------------------------------------------------------------ HUD
let hudT = 0;
const reticleV = new THREE.Vector3();
const disp = { cargo: 100, shield: 100, health: 100, gc: 100, gs: 100, gh: 100 };
function setBar(b, v, ghost) {
  b.v.style.transform = `scaleX(${clamp(v, 0, 1)})`;
  if (b.g && ghost !== undefined) b.g.style.transform = `scaleX(${clamp(ghost, 0, 1)})`;
}
function tweenTo(k, gk, target, dt) {
  disp[k] += (target - disp[k]) * damp(10, dt);
  disp[gk] = target > disp[gk] ? target : disp[gk] + (target - disp[gk]) * damp(1.6, dt);
}
function updateHUD(dt, time) {
  tweenTo('cargo', 'gc', G.cargo, dt); tweenTo('shield', 'gs', G.shield, dt); tweenTo('health', 'gh', Math.max(0, G.health), dt);
  setBar(hud.bCargo, disp.cargo / 100, disp.gc / 100);
  setBar(hud.bShield, disp.shield / 100, disp.gs / 100);
  setBar(hud.bHealth, disp.health / 100, disp.gh / 100);
  setBar(hud.bRad, G.rad);
  setBar(hud.bAir, G.air / 60);
  setBar(hud.bMark, G.mark);
  hud.rowShield.classList.toggle('regen', G.regen);
  hud.rowShield.classList.toggle('down', G.shield <= 0);
  hud.markBox.style.opacity = G.mark > 0.01 || G.lock.phase === 'laser' ? 1 : 0;
  const locked = G.lock.phase === 'laser' || G.lock.phase === 'volley';
  hud.markBox.classList.toggle('lock', G.mark >= 1 || locked);
  hud.tintLock.style.opacity = locked ? 0.6 + 0.4 * Math.sin(time * 20) : G.mark * 0.35;
  hud.airBox.style.opacity = G.underwater || G.air < 59.5 ? 1 : 0;
  hud.airBox.classList.toggle('low', G.air < 15);
  hud.routeShip.style.left = clamp((G.s - PAD_A) / ROUTE, 0, 1) * 100 + '%';
  hud.tintRad.style.opacity = G.rad > 0.01 ? G.rad * (0.75 + 0.25 * Math.random()) : 0;
  G.hitFlash = Math.max(0, G.hitFlash - dt * 2.5);
  hud.tintHit.style.opacity = G.hitFlash;
  hud.tintShield.style.opacity = Math.max(G.shieldFlash, G.shieldHit * 0.5);
  hud.dive.classList.toggle('under', G.dive);
  const pips = hud.pips.children;
  for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('off', i >= G.rockets);
  hud.pips.classList.toggle('cd', G.rocketCd > 0);
  hud.rocketBtn.classList.toggle('empty', G.rockets <= 0);
  hud.rocketBtn.classList.toggle('cd', G.rocketCd > 0);
  const rdt = realDt;
  if (G.msgT > 0) { G.msgT -= rdt; if (G.msgT <= 0) hud.msg.style.opacity = 0; }
  if (G.toastT > 0) { G.toastT -= rdt; if (G.toastT <= 0) hud.toast.classList.remove('on'); }
  if (G.popT > 0) {
    G.popT -= rdt;
    hud.pop.style.transform = `translate(-50%,${-50 - (0.9 - G.popT) * 40}%)`;
    if (G.popT <= 0) hud.pop.style.opacity = 0;
  }
  reticleV.copy(shipPos).addScaledVector(shipFwd, 140).project(camera);
  const vis = G.phase === 'flight' && !G.underwater && reticleV.z < 1;
  hud.reticle.style.display = vis ? 'block' : 'none';
  if (vis) hud.reticle.style.transform = `translate(${(reticleV.x * 0.5 + 0.5) * innerWidth}px,${(-reticleV.y * 0.5 + 0.5) * innerHeight}px)`;
  hudT -= dt;
  if (hudT > 0) return;
  hudT = 0.1;
  hud.cargo.textContent = Math.ceil(G.cargo) + '%';
  hud.shield.textContent = G.shield > 0 ? Math.ceil(G.shield) + '%' : 'DOWN';
  hud.health.textContent = Math.ceil(Math.max(0, G.health)) + '%';
  hud.rad.textContent = G.rad > 0.05 ? (G.rad * 4.2).toFixed(1) + ' Sv/h' : 'SHIELDED';
  hud.rad.style.color = G.rad > 0.05 ? '#ff6a4a' : '#9ff';
  hud.mark.textContent = locked ? 'LOCK' : Math.round(G.mark * 100) + '%';
  hud.score.textContent = G.score;
  hud.speed.textContent = Math.round(G.speed * (1 - G.dip) * 3.6);
  hud.dist.textContent = (Math.max(0, PAD_B - G.s) / 1000).toFixed(2);
  hud.air.textContent = Math.ceil(G.air) + 's';
  hud.rockets.textContent = G.rockets;
}

// ------------------------------------------------------------------ result / screens
function showResult() {
  G.phase = 'result';
  const ok = G.outcome === 'delivered';
  const timeBonus = ok ? Math.max(0, Math.round((200 - G.t) * 15)) : 0;
  G.finalScore = Math.max(0, G.score + (ok ? Math.round(G.cargo) * 20 + Math.round(G.health) * 10 + timeBonus : 0));
  $('rTitle').textContent = ok ? 'Water delivered.' : 'Mission failed.';
  $('rTitle').className = ok ? '' : 'bad';
  $('rSub').textContent = ok ? 'ДОСТАВЛЕНО · SETTLEMENT B HAS WATER TONIGHT' : 'МИССИЯ ПРОВАЛЕНА · ' + G.reason;
  const mm = Math.floor(G.t / 60), ss = (G.t % 60).toFixed(1).padStart(4, '0');
  $('rTime').textContent = `${mm}:${ss}`;
  $('rCargo').textContent = Math.round(G.cargo) + '%';
  $('rHealth').textContent = Math.round(Math.max(0, G.health)) + '%';
  $('rTargets').textContent = `${G.kills} / ${N_DRONE_REAL + BEACONS.length + TURRETS.length}`;
  $('rMasts').textContent = `${G.mastsBroken}`;
  $('rHits').textContent = `${G.turretHits} / ${G.turretShotsFired}`;
  $('rScore').textContent = G.finalScore + (ok ? ` (+${timeBonus})` : '');
  $('result').classList.remove('hide');
  document.body.classList.remove('playing');
}

function reset() {
  resetLevel();
  for (let i = N_DRONE_REAL; i < DRONES.length; i++) DRONES[i].alive = false;
  G = freshState();
  for (const b of bolts) b.on = false;
  for (const b of ebolts) b.on = false;
  for (const r of rockets) r.on = false;
  ship.body.position.z = 0;
  sparks.clear(); mist.clear(); debris.clear(); wake.clear();
  placeStatic();
  for (const z of ZONES) { z.mesh.visible = true; z.mesh.material.uniforms.uAlpha.value = 1; z.mesh.material.uniforms.uFlick.value = 1; }
  zoneEls.forEach((e) => e.classList.remove('off'));
  ship.diveT = 0;
  camInit = false;
  hud.toast.classList.remove('on');
}

function startGame() {
  if (G.phase !== 'start') return;
  if (!navigator.userActivation || navigator.userActivation.isActive) audio.init();
  $('start').classList.add('hide');
  $('result').classList.add('hide');
  document.body.classList.add('playing');
  G.phase = 'takeoff'; G.phaseT = 0; G.t = 0;
  showMsg('TAKEOFF — SETTLEMENT A', 'ВЗЛЁТ — ПОСЕЛЕНИЕ А', 2.2);
}
$('start').addEventListener('click', () => {
  try {
    const el = document.documentElement;
    if (isTouch && el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen({ navigationUI: 'hide' }).then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
  } catch (e) { /* ignore */ }
  startGame();
});
$('retry').addEventListener('click', (e) => { e.stopPropagation(); reset(); startGame(); });
function syncSnd(muted) {
  hud.snd.classList.toggle('muted', muted);
  hud.snd.querySelector('.x').style.display = muted ? '' : 'none';
  hud.snd.querySelector('.w1').style.display = hud.snd.querySelector('.w2').style.display = muted ? 'none' : '';
}
audio.listeners.push(syncSnd);
syncSnd(audio.muted);
hud.snd.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); audio.init(); audio.toggleMute(); });
addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !e.repeat) audio.toggleMute();
  if (e.code === 'Enter' || e.code === 'Space') {
    if (G.phase === 'start') startGame();
    else if (G.phase === 'result') { reset(); startGame(); }
  }
});
const unlock = () => audio.init();
addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);

addEventListener('resize', () => {
  post.resize(innerWidth, innerHeight, DEVICE_DPR);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ------------------------------------------------------------------ positional audio inputs
function updateAudioScene() {
  if (!audio.ctx) return;
  // wall / arch proximity -> doppler-ish engine & wind swell
  let prox = 0;
  if (G.phase === 'flight') {
    const yy = Math.max(3, G.y);
    const gap = Math.min(wallLat(G.s, yy, 1) - G.lat, wallLat(G.s, yy, -1) + G.lat);
    prox = clamp(1 - (gap - 4) / 12, 0, 1);
    for (const a of ARCHES) {
      const ds = Math.abs(a.s - G.s);
      if (ds < 35) prox = Math.max(prox, 1 - ds / 35);
    }
  }
  G.prox = prox;
  // nearest drone whine: distance gain, stereo pan, doppler from closing speed
  let best = null, bd = 230;
  for (const d of DRONES) {
    if (!d.alive || Math.abs(d.s - G.s) > 240) continue;
    const dd = d.wp.distanceTo(camera.position);
    if (dd < bd) { bd = dd; best = d; }
  }
  if (best && !camUnder) {
    V3.copy(best.wp).sub(shipPos).normalize();
    const vApp = shipVel.dot(V3);
    const g = Math.pow(1 - bd / 230, 2) * (best.spotting ? 1.4 : 1);
    audio.droneVoice(g, panOf(best.wp), clamp(1 + vApp / 343, 0.75, 1.25));
  } else audio.droneVoice(0, 0, 1);
}

// ------------------------------------------------------------------ main loop
const clock = new THREE.Clock();
let realDt = 0.016, time = 0, fps = 60, fpsAcc = 0, fpsN = 0, frames = 0;
const portraitMQ = matchMedia('(orientation: portrait) and (max-width: 900px)');
function loop() {
  requestAnimationFrame(loop);
  const rawDt = clock.getDelta();
  realDt = Math.min(rawDt, 0.25);
  let dt = Math.min(rawDt, 0.05);
  fpsAcc += rawDt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  governor.frame(rawDt);
  if (portraitMQ.matches && G.phase !== 'start' && G.phase !== 'result') dt = 0;
  time += dt;
  pollInput();
  if (G.phase !== 'start' && G.phase !== 'result') {
    G.phaseT += dt;
    if (G.phase !== 'landed' && G.phase !== 'failed') G.t += dt;
  }
  G.hitCd -= dt;
  G.fireCd -= dt;
  G.rocketCd -= dt;

  glows.begin();
  beams.begin();
  updateFlight(dt);
  updateShipVisual(dt, time);
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
  if (input.consumeRocket() && G.phase === 'flight') { if (G.underwater) audio.empty(); else fireRocket(); }
  updateBolts(dt);
  updateRockets(dt);
  updateTargets(dt, time);
  updateLethe(dt, time);
  updateHazards(dt);
  if (G.phase === 'landed' && G.phaseT > 1.6) showResult();
  if (G.phase === 'failed' && G.phaseT > 2.6) showResult();
  updateCamera(dt, time);

  if (G.flash && G.flash.t > 0) {
    const f = G.flash; f.t -= dt;
    const k = Math.max(0, f.t / 0.28);
    glows.add(f.p.x, f.p.y, f.p.z, f.cold ? 0.8 : 2.2, f.cold ? 1.6 : 1.3, f.cold ? 2 : 0.6, k, 34 * f.big * (1.3 - k * 0.3));
  }
  if (G.muzzleT > 0) {
    G.muzzleT -= dt;
    const p = G.muzzleP;
    beams.add(p.x, p.y, p.z, p.x + shipFwd.x * 3, p.y + shipFwd.y * 3, p.z + shipFwd.z * 3, 0.9, 2.4, 1.4, 0.5, G.muzzleT / 0.06);
  }
  // pooled flash light
  if (flash.t > 0) {
    flash.t -= dt;
    const k = Math.max(0, flash.t / flash.dur);
    flashL.position.copy(flash.p);
    flashL.color.copy(flash.col);
    flashL.intensity = flash.peak * k * k;
  } else flashL.intensity = 0;
  debris.update(dt,
    (it) => sparks.emit(it.p.x, it.p.y, it.p.z, 0, 0, 0, 0.35, 0.9 * it.hot + 0.3, 0.2, 1.8, 0.8, 0.3, it.hot, 0, 0),
    (it) => splash(it.p, 8, 0.4));
  sparks.update(dt);
  mist.update(dt);
  glows.end();
  beams.end();

  // chunk streaming / culling by path distance
  const s0 = G.s - 320, s1 = G.s + 1350;
  for (const c of chunks) c.visible = c.userData.sB > s0 && c.userData.sA < s1;
  for (const w of waters) w.visible = w.userData.sB > s0 && w.userData.sA < s1;
  for (const z of ZONES) if (z.mesh && z.shielded) z.mesh.visible = z.s1 > s0 && z.s0 < s1;

  waterMat.uniforms.uTime.value = time;
  foam.material.uniforms.uTime.value = time;
  shafts.material.uniforms.uTime.value = time;
  sky.material.uniforms.uTime.value = time;
  sky.material.uniforms.uCam.value.copy(camera.position);
  sky.position.copy(camera.position);
  const ps = renderer.getPixelRatio() * innerHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
  glows.mat.uniforms.uScale.value = ps; sparks.out.mat.uniforms.uScale.value = ps; mist.out.mat.uniforms.uScale.value = ps; motes.mat.uniforms.uScale.value = ps;

  updateHUD(dt, time);
  updateAudioScene();
  audio.update(G.speed * (1 - G.dip), G.boost, camUnder, G.skim || 0, G.phase !== 'start' && G.phase !== 'result', G.prox || 0, G.y);
  renderer.info.reset();
  post.render(time);
  if (++frames === 2) document.getElementById('fade').classList.add('off');
}

// ------------------------------------------------------------------ test hook
function shipFrac() {
  ship.group.updateMatrixWorld();
  const a = ship.navLights[0].clone().applyMatrix4(ship.wings[0].matrixWorld).project(camera);
  const b = ship.navLights[1].clone().applyMatrix4(ship.wings[1].matrixWorld).project(camera);
  return +(Math.abs(a.x - b.x) / 2).toFixed(3);
}
function camGap() {
  const c = camera.position, pr = projectToPath(c.x, c.z, G.s - 20), y = Math.max(3, c.y);
  return +Math.min(wallLat(pr.s, y, 1) - pr.lat, wallLat(pr.s, y, -1) + pr.lat).toFixed(2);
}
window.__lethe = {
  state: () => ({
    t: +G.t.toFixed(2), speed: +G.speed.toFixed(2), distToB: +Math.max(0, PAD_B - G.s).toFixed(1), cargo: +G.cargo.toFixed(1), hull: +G.cargo.toFixed(1),
    health: +Math.max(0, G.health).toFixed(1), air: +G.air.toFixed(1), score: G.phase === 'result' ? G.finalScore : G.score,
    underwater: G.underwater, phase: G.phase, outcome: G.outcome, s: +G.s.toFixed(1), lat: +G.lat.toFixed(2), y: +G.y.toFixed(2),
    dive: G.dive, radiation: +G.rad.toFixed(3), mastsBroken: G.mastsBroken, kills: G.kills,
    rockets: G.rockets, rocketsFired: G.rocketsFired, recoilDip: +G.dip.toFixed(3), muted: audio.muted, volume: audio.vol,
    shield: +G.shield.toFixed(1), mark: +G.mark.toFixed(3), spotters: G.spotters, lock: G.lock.phase,
    turretShotsFired: G.turretShotsFired, ebLog: G.ebLog.slice(-6), turretHits: G.turretHits, quality, fps: Math.round(fps),
    camDist: +camera.position.distanceTo(shipPos).toFixed(2), shipFrac: shipFrac(), camWallGap: camGap(), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
  }),
  start: startGame,
  retry: () => { reset(); startGame(); },
  warp: (s) => { G.s = s; camInit = false; },
  input,
  debug: {
    breakMast: (i) => breakMast(MASTS[i]),
    masts: () => MASTS.map((m) => ({ s: m.s, alive: m.alive })),
    spawnDrone: (ahead = 110, lat = 0, y = 18) => {
      const d = DRONES.find((x) => x.debug && !x.alive) || DRONES[DRONES.length - 1];
      Object.assign(d, { s: G.s + ahead, lat, y, amp: 3, alive: true });
      return DRONES.indexOf(d);
    },
    forceMark: (v = 1) => { G.mark = v; },
    damageShield: (n = 30) => damage(n, V4.copy(shipPos).addScaledVector(shipFwd, 6).clone(), 'debug'),
    setQuality: (q) => applyQuality(q),
    post, scene,
    turrets: () => TURRETS.map((t) => ({ s: +t.s.toFixed(0), alive: t.alive })),
    shipCam: () => ({ ship: shipPos.toArray(), cam: camera.position.toArray() }),
  },
};

if (params.get('autostart') === '1') startGame();
loop();
