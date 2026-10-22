// LETHE / ЛЕТА — "Delivery" prototype. Game loop, flight model, shooting, shield, LETHE spotters
// and turrets, hazards, camera, HUD, adaptive quality.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, lerp, damp, smoothstep } from './util.js';
import {
  PAD_A, PAD_B, PAD_TOP, ROUTE, frame, toWorld, projectToPath, wallLat, riverHalf, bankY, maxY, narrowAt,
  ARCHES, ROCKS, ZONES, BEACONS, DRONES, MASTS, TURRETS, archBottom, archTop, zoneAt, zoneLinked, resetLevel,
  MINES, HUNTERS, BOATS, bedY, underLim,
} from './world.js';
import {
  buildMines, buildHunters, buildBoats, buildTurretGeo, buildTurretMountGeo, rimMaterial, BOAT_HL, BOAT_HW, BOAT_KEEL, BOAT_TOP,
} from './naval.js';
import {
  buildChunks, buildWater, buildFields, buildFoam, buildShafts, makeSky, makeTerrainMaterial, makeWaterMaterial, STATIC_GLOWS, VENTS,
} from './terrain.js';
import { Glows, Particles, Streaks, Beams, Debris, Motes, Wake } from './fx.js';
import { Ship, makeEnvMap } from './ship.js';
import { Audio, ENGINES } from './audio.js';
import { input, setupInput, pollInput } from './input.js';
import { Post, QualityGovernor, TIERS } from './post.js';

THREE.ColorManagement.enabled = false;
const params = new URLSearchParams(location.search);
const AUTOPILOT = params.get('autopilot') === '1';
const NOBOOST = params.get('noboost') === '1';   // autopilot at cruise speed (timing tests)
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
document.body.classList.toggle('touch', isTouch);
// Round 6: water as reaction mass. The air-breathing plasma engines flash cargo water into steam/plasma when the
// air is not enough: on BOOST, and in thin air over a sector whose mast was shot. Rates in cargo-% per second.
const BURN_BOOST = 0.15;     // × G.boost (0..1): ~60–100 s of boost over the 2:36 route ≈ 9–15 % of the tank
const BURN_THIN = 0.35;      // extra auto-draw in thin air (mast down), above water only
const BURN_THIN_BOOST = 1.6; // boost burn multiplier in thin air
const BURN_FLOOR = 5;        // burn alone never drains the tank below this (damage still can)
const THIN_SINK = 2.5;       // m/s gentle sink in thin air when the pilot isn't climbing
const SHIP_BURN_MUL = 1.0;   // Cormorant / Баклан. Future ship types: Tern / Крачка 1.3, Pelican / Пеликан 0.6
const TANK_L = 6000;         // Cormorant tank, litres
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

// Round 4: both suns sit ahead along the dominant route heading (≈ 8° east of -Z) so they are in frame often:
// the real sun low (10.5°) a little right of the heading, the orbital mirror higher (15.5°) and ~18° further right.
// (The brief asked for ~25–35°, but the chase camera's top edge sits at ≈ 26° and the HUD band covers the top
// ~110 px, so above ~18° the mirror was hardly ever in view — that is why it went unnoticed. See README.)
const dirAzEl = (az, el) => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
const DEG = Math.PI / 180;
const SUN = dirAzEl(10 * DEG, 10.5 * DEG);
const SUN2 = dirAzEl(28 * DEG, 15.5 * DEG);
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
const beams = new Beams(384, FOG_D_AIR);
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

// LETHE relay (round 5; the old "beacon"): a thin dark antenna mast with a dish facing the canyon (+X), a red-striped
// equipment box, a whip antenna and a red top light (glow sprite). Dark + red so it never reads as a cyan field mast.
const RELAY_TOP = 8.7;
const relayGeo = mergeGeometries([
  colored(tr(new THREE.CylinderGeometry(0.8, 1, 0.5, 6), 0, 0.25, 0), [0.26, 0.26, 0.28]),
  colored(tr(new THREE.CylinderGeometry(0.12, 0.2, 6.2, 5), 0, 3.1, 0), [0.2, 0.2, 0.22]),
  colored(tr(new THREE.BoxGeometry(1.0, 0.06, 0.06), 0, 1.4, 0, 0, 0, 0.6), [0.24, 0.24, 0.26]),
  colored(tr(new THREE.BoxGeometry(1.0, 0.06, 0.06), 0, 3.4, 0, 0, 0, -0.6), [0.24, 0.24, 0.26]),
  colored(tr(new THREE.BoxGeometry(0.9, 0.8, 0.9), 0, 2.0, 0), [0.34, 0.15, 0.12]),
  colored(tr(new THREE.BoxGeometry(0.94, 0.14, 0.94), 0, 2.25, 0), [0.85, 0.12, 0.07]),
  colored(tr(new THREE.CylinderGeometry(1.15, 0.25, 0.35, 12), 0.45, 4.3, 0, 0, 0, -Math.PI / 2), [0.6, 0.58, 0.56]),
  colored(tr(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 4), 1.05, 4.3, 0, 0, 0, Math.PI / 2), [0.3, 0.3, 0.3]),
  colored(tr(new THREE.BoxGeometry(0.18, 0.18, 0.18), 1.6, 4.3, 0), [0.8, 0.12, 0.07]),
  colored(tr(new THREE.BoxGeometry(0.3, 0.12, 0.3), 0, 5.6, 0), [0.85, 0.12, 0.07]),
  colored(tr(new THREE.CylinderGeometry(0.025, 0.05, 2.5, 4), 0, 7.4, 0), [0.15, 0.15, 0.16]),
  colored(tr(new THREE.SphereGeometry(0.16, 8, 6), 0, RELAY_TOP, 0), [1.0, 0.15, 0.08]),
]);
const beacons = new THREE.InstancedMesh(relayGeo, lambertVC, BEACONS.length);
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

// LETHE turret head (round 4: dark gunmetal, light edge trims + fresnel rim, big red eye; nose along -Z)
const turretMat = rimMaterial([1.0, 0.8, 0.6], 0.75);
const turrets = new THREE.InstancedMesh(buildTurretGeo(), turretMat, TURRETS.length);
turrets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
turrets.frustumCulled = false;
scene.add(turrets);
const turretMounts = new THREE.InstancedMesh(buildTurretMountGeo(), turretMat, TURRETS.length);
const TUR_LIVE = new THREE.Color(1, 1, 1), TUR_BLIND = new THREE.Color(0.5, 0.46, 0.46);
scene.add(turretMounts);

// ------------------------------------------------------------------ naval layer (round 4): mines, hunter-subs, boats
// spare debug slots at the end of each list (hidden unless spawned via __lethe.debug)
const N_MINE_REAL = MINES.length, N_HUNTER_REAL = HUNTERS.length, N_BOAT_REAL = BOATS.length;
for (let i = 0; i < 3; i++) MINES.push({ s: -1e4, lat: 0, y: -2, phase: i * 2, alive: false, fuse: 0, debug: true });
for (let i = 0; i < 3; i++) HUNTERS.push({ s: -1e4, home: -1e4, lat: 0, y: -4, phase: i * 2, alive: false, debug: true });
for (let i = 0; i < 2; i++) BOATS.push({ s: -1e4, home: -1e4, lat: 0, lat0: 0, type: 'patrol', dir: 1, dir0: 1, speed: 0, alive: false, debug: true });
const navalMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const mineM = buildMines(MINES.length, navalMat);
scene.add(mineM.mines, mineM.chains, mineM.sinkers);
const hunterMesh = buildHunters(HUNTERS.length, navalMat);
scene.add(hunterMesh);
const boatM = buildBoats(BOATS.length, rimMaterial([0.85, 0.85, 0.8], 0.35));
scene.add(boatM.pF, boatM.pB, boatM.sF, boatM.sB, boatM.panels);
for (const m of MINES) { m.wp = new THREE.Vector3(0, -1e4, 0); m.anchor = new THREE.Vector3(); }
for (const h of HUNTERS) { h.wp = new THREE.Vector3(0, -1e4, 0); h.nose = new THREE.Vector3(); h.fwd = new THREE.Vector3(0, 0, -1); }
for (const b of BOATS) { b.wp = new THREE.Vector3(0, -1e4, 0); b.deck = new THREE.Vector3(0, -1e4, 0); b.gun = new THREE.Vector3(); b.M = new THREE.Matrix4(); }
const MINE_TRIG = 4.6, MINE_DMG = 34, MINE_PTS = 120, HUNTER_PTS = 180, BOAT_PTS = { patrol: 400, smuggler: 300 }, BOAT_HP = 6;
const HUNT_SP = 44, HB_SPEED = 78, PB_SPEED = 125;
const spouts = [];
const BOAT_PANEL = { patrol: new THREE.Color(0.5, 2.2, 2.6), smuggler: new THREE.Color(2.8, 1.25, 0.35) };

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
    pathBasis(b.s, M1);
    if (b.side > 0) M1.multiply(M2.makeRotationY(Math.PI));   // dish faces the canyon
    toWorld(b.s, b.lat, b.y, V3); M1.setPosition(V3);
    beacons.setMatrixAt(i, b.alive ? M1 : ZERO_M);
    b.wp = toWorld(b.s, b.lat, b.y + 4.2, new THREE.Vector3());
    b.wp2 = toWorld(b.s, b.lat, b.y + 2, new THREE.Vector3());
    b.top = toWorld(b.s, b.lat, b.y + RELAY_TOP, new THREE.Vector3());
  });
  beacons.instanceMatrix.needsUpdate = true;
  MASTS.forEach((m, i) => setMastMatrix(m, i));
  TURRETS.forEach((t, i) => {
    t.wp = toWorld(t.s, t.lat, t.y + 0.6, new THREE.Vector3()); t.eye = new THREE.Vector3(); t.muzzle = new THREE.Vector3(); t.aim = new THREE.Vector3(0, 0, -1);
    pathBasis(t.s, M1);
    if (t.side > 0) M1.multiply(M2.makeRotationY(Math.PI));   // backplate against the wall
    M1.setPosition(t.wp);
    turretMounts.setMatrixAt(i, M1);
  });
  turretMounts.instanceMatrix.needsUpdate = true;
  TURRETS.forEach((t, i) => { t.blind = false; turrets.setColorAt(i, TUR_LIVE); });
  turrets.instanceColor.needsUpdate = true;
  initNaval();
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
for (let i = 0; i < BOLT_N; i++) bolts.push({ on: false, p: new THREE.Vector3(), q: new THREE.Vector3(), o: new THREE.Vector3(), d: new THREE.Vector3(), life: 0, s: 0, lat: 0, under: false, wet: false });
// underwater the cannon still works, with slower turquoise bolts and a short range (~70 m)
const UW_BOLT_SPEED = 260, UW_BOLT_LIFE = 0.28, UW_RANGE = UW_BOLT_SPEED * UW_BOLT_LIFE;
// LETHE turret bolts
// (round 4: the pool is shared with patrol-boat and hunter bolts; each bolt carries its speed, colour, damage, radius)
const EB_SPEED = 165, EB_N = 32, EB_DMG = 9;
const EB_RED = [2.4, 0.3, 0.15], EB_BLUE = [0.7, 1.3, 2.6], EB_CYAN = [0.3, 1.8, 1.9];
const ebolts = [];
for (let i = 0; i < EB_N; i++) ebolts.push({ on: false, p: new THREE.Vector3(), q: new THREE.Vector3(), o: new THREE.Vector3(), d: new THREE.Vector3(), life: 0, s: 0,
  sp: EB_SPEED, col: EB_RED, dmg: EB_DMG, rad: 3.8, under: false, src: 'turret' });

// ------------------------------------------------------------------ audio / input / HUD refs
const audio = new Audio();
setupInput(renderer.domElement);
const $ = (id) => document.getElementById(id);
const barEls = (id) => ({ v: $(id).querySelector('.v'), g: $(id).querySelector('.ghost') });
const hud = {
  root: $('hud'), cargo: $('tCargo'), shield: $('tShield'), health: $('tHealth'), rad: $('tRad'), score: $('tScore'), speed: $('tSpeed'), dist: $('tDist'),
  bCargo: barEls('bCargo'), bShield: barEls('bShield'), bHealth: barEls('bHealth'), bRad: barEls('bRad'), bAir: barEls('bAir'), bMark: barEls('bMark'),
  rowCargo: $('rCargoRow'), burnTag: $('burnTag'), rowShield: $('rShieldRow'), rowHealth: $('rHealthRow'),
  air: $('tAir'), airBox: $('airBox'), msg: $('msg'), pop: $('pop'), toast: $('toast'), markBox: $('markBox'), markLbl: document.querySelector('#markBox .lbl span'), mark: $('tMark'), sDown: $('sDown'),
  routeShip: $('routeShip'), reticle: $('reticle'), tintUnder: $('tintUnder'), tintRad: $('tintRad'), tintHit: $('tintHit'), tintShield: $('tintShield'), tintLock: $('tintLock'),
  dive: $('btnDive'), rocketBtn: $('btnRocket'), rockets: $('tRockets'), pips: $('pips'), snd: $('snd'), hitx: $('hitx'), keys: $('keys'), engBtn: $('engBtn'),
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
    msgT: 0, popT: 0, beepT: 0, airOut: false, toastT: 0, toastQ: [], seen: {}, rkLog: [], turretHinted: false, legendT: 20,
    shield: 100, shieldCd: 0, shieldOn: 1, shieldFlash: 0, shieldHit: 0, regen: false,
    mark: 0, spotters: 0, markBeep: 0, lock: { phase: 'none', t: 0, turret: null, shots: 0 }, droneHinted: false, lostSaid: false,
    turretShotsFired: 0, turretHits: 0, ebLog: [], turretKills: 0, apDiveT: 0, muzzleT: 0,
    rockets: ROCKET_AMMO, rocketCd: 0, rocketsFired: 0, recoilT: 9, dip: 0, kick: 0, jolt: 0, micro: 0,
    mineKills: 0, mineHits: 0, hunterKills: 0, hunterRams: 0, hunterShots: 0, boatKills: 0, navalHits: 0, boatShots: 0, ricochets: 0, armorT: 0,
    mineHinted: false, hunterHinted: false, boatHinted: false,
    relayKills: 0, relayHinted: false, blindSaid: false, noRelay: false, blockLogged: false, lockLog: [], beamSegs: 0, beamTurret: -1,
    waterBurned: 0, waterSpilled: 0, burnRate: 0, thinAir: false, steam: 0, burnHinted: false, thinHinted: false,
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
// toasts queue up (a hint never wipes another one); `now` replaces the current one (engine switch)
function toast(html, dur = 5, now = false) {
  if (G.toastT > 0 && !now) { G.toastQ.push([html, dur]); return; }
  hud.toast.innerHTML = html;
  hud.toast.classList.add('on');
  G.toastT = dur;
}
function hitMarker() {
  const el = hud.hitx;
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on', 'kill');
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
    G.waterSpilled += Math.min(G.cargo, rest);
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
  // low (skimming / diving): steer around mines and boat hulls too
  const low = ty < 7 || needDive || G.dive || G.apDiveT > 0 || G.y < 5;
  for (let c = -0.75; c <= 0.751; c += 0.075) {
    const lat = c * wr;
    let cost = Math.abs(lat - G.lat) * 0.03 + Math.abs(c) * 0.5;
    if (low) {
      for (const m of MINES) {
        if (!m.alive || m.s < G.s - 6 || m.s > G.s + 140) continue;
        if (Math.abs(m.lat - lat) < 8) cost += 90 * (1 - (m.s - G.s) / 210);
      }
      for (const b of BOATS) {
        if (!b.alive || b.s < G.s - 10 || b.s > G.s + 160) continue;
        if (Math.abs(b.lat - lat) < BOAT_HW + 7) cost += 80;
      }
    }
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
    // round 6: thin air (mast down) — a gentle sink when not climbing, fading out near the water (no bounce)
    if (G.thinAir && !G.dive && iy <= 0.1 && G.y >= 0.9) vYt -= THIN_SINK * clamp((G.y - 3) / 4, 0, 1);
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
  const at = aimTarget(p);
  if (at) dir = V2.copy(at.wp).sub(p).normalize();
  const b = bolts.find((x) => !x.on);
  if (!b) return;
  const uw = G.underwater;
  b.on = true; b.p.copy(p); b.q.copy(p); b.o.copy(p); b.d.copy(dir); b.life = uw ? UW_BOLT_LIFE : BOLT_LIFE; b.s = G.s; b.lat = G.lat;
  b.under = uw; b.wet = false;
  // muzzle flash: HDR sprite burst + brief light (turquoise + bubbles underwater)
  const mc = uw ? [0.5, 1.9, 1.8] : [2.4, 1.5, 0.6];
  sparks.emit(p.x, p.y, p.z, shipVel.x, shipVel.y, shipVel.z, 0.07, 4.5, 2.5, mc[0], mc[1], mc[2], 1);
  for (let i = 0; i < 3; i++) sparks.emit(p.x, p.y, p.z, shipVel.x + dir.x * 40 + (Math.random() - 0.5) * 12, shipVel.y + dir.y * 40 + (Math.random() - 0.5) * 12, shipVel.z + dir.z * 40 + (Math.random() - 0.5) * 12, 0.1, 0.6, 0.2, mc[0] * 0.8, mc[1] * 0.8, mc[2] * 0.8, 1);
  if (uw) for (let i = 0; i < 3; i++) mist.emit(p.x, p.y, p.z, shipVel.x * 0.5 + dir.x * 8 + (Math.random() - 0.5) * 3, 1 + Math.random() * 2, shipVel.z * 0.5 + dir.z * 8 + (Math.random() - 0.5) * 3, 0.9, 0.3, 0.8, 0.7, 1, 1, 0.7, -5, 2);
  G.muzzleT = 0.06; G.muzzleP = p.clone();
  lightFlash(p, 90, 0.08, uw ? 0.3 : 1, uw ? 0.9 : 0.7, uw ? 0.85 : 0.35);
  // micro-recoil only: tiny camera tremor + ship mesh jolt, never a slowdown
  G.micro = Math.min(0.1, G.micro + 0.05);
  G.jolt = 0.14;
  audio.shot();
}

// aim assist: drones / beacons inside a ~6° cone; rim turrets inside a horizontal cone with generous vertical
// reach (bolts angle up to the ledges). Only with a clear line of fire; never toward a mast, and never when a mast
// sits on the line of fire.
const AIM_CONE = 0.105, AIM_TURRET_H = 0.2, AIM_TURRET_UP = 0.62, AIM_RANGE = 240;
const AIM_H = new THREE.Vector3(), AIM_D = new THREE.Vector3();
const aimHit = { obj: null, kind: '', wp: null };
function mastOnLine(p, wp) {
  for (const m of MASTS) {
    if (!m.alive || Math.abs(m.s - G.s) > 300) continue;
    for (const pt of m.pts) {
      AIM_D.copy(wp).sub(p);
      const l2 = AIM_D.lengthSq() || 1;
      const t = clamp(((pt.x - p.x) * AIM_D.x + (pt.y - p.y) * AIM_D.y + (pt.z - p.z) * AIM_D.z) / l2, 0, 1);
      if (V4.copy(p).addScaledVector(AIM_D, t).distanceToSquared(pt) < 4.5 * 4.5) return true;
    }
  }
  return false;
}
function aimTarget(p, widen = 1) {
  if (G.phase !== 'flight') return null;
  const uw = G.underwater;
  AIM_H.set(shipFwd.x, 0, shipFwd.z).normalize();
  const fwdEl = Math.asin(clamp(shipFwd.y, -1, 1));
  let best = null, bestK = '', bestScore = 1e9;
  const consider = (o, kind) => {
    V3.copy(o.wp).sub(p);
    const d = V3.length();
    const naval = kind === 'mine' || kind === 'hunter' || kind === 'boat';
    if (naval ? (d < 4 || d > (uw ? UW_RANGE + 6 : 50)) : (d < 15 || d > AIM_RANGE)) return;
    let score;
    if (naval) {
      if (kind === 'mine' && !uw) {
        // shallow mine from above: horizontal cone with generous downward reach (bolts angle down into the water)
        const hl = Math.hypot(V3.x, V3.z) || 1;
        const ah = Math.acos(clamp((V3.x * AIM_H.x + V3.z * AIM_H.z) / hl, -1, 1));
        const ev = Math.atan2(V3.y, hl) - fwdEl;
        if (ah > AIM_TURRET_H * widen || ev > 0.05 || ev < -0.4) return;
        score = ah * 0.5 + Math.abs(ev) * 0.1;
      } else {
        const a = Math.acos(clamp(V3.dot(shipFwd) / d, -1, 1));
        if (a > AIM_CONE * 1.3 * widen) return;
        score = a * 0.4;   // close naval threats take priority over distant rim targets
      }
      if (score >= bestScore || !viewLOS(p, o.wp, G.s)) return;
      bestScore = score; best = o; bestK = kind;
      return;
    } else if (kind === 'turret') {
      const hl = Math.hypot(V3.x, V3.z) || 1;
      const ah = Math.acos(clamp((V3.x * AIM_H.x + V3.z * AIM_H.z) / hl, -1, 1));
      const ev = Math.atan2(V3.y, hl) - fwdEl;
      if (ah > AIM_TURRET_H * widen || ev < -0.12 || ev > AIM_TURRET_UP) return;
      score = ah * 1.4 + Math.abs(ev) * 0.25;
    } else {
      const a = Math.acos(clamp(V3.dot(shipFwd) / d, -1, 1));
      if (a > AIM_CONE * widen) return;
      score = a;
    }
    if (score >= bestScore || mastOnLine(p, o.wp) || !viewLOS(p, o.wp, G.s)) return;
    bestScore = score; best = o; bestK = kind;
  };
  if (uw) {
    // underwater: mines, hunters and the glowing belly of boats
    for (const m of MINES) if (m.alive && Math.abs(m.s - G.s) < 90) consider(m, 'mine');
    for (const h of HUNTERS) if (h.alive && h.vis && Math.abs(h.ps - G.s) < 90) consider(h, 'hunter');
    for (const b of BOATS) if (b.alive && Math.abs(b.s - G.s) < 90) consider(b, 'boat');
  } else {
    for (const d of DRONES) if (d.alive && Math.abs(d.s - G.s) < 260) consider(d, 'drone');
    for (const b of BEACONS) if (b.alive && Math.abs(b.s - G.s) < 260) consider(b, 'beacon');
    for (const t of TURRETS) if (t.alive && Math.abs(t.s - G.s) < 260) consider(t, 'turret');
    // mines just under the surface can be shot from above at very close range
    if (G.y < 8) for (const m of MINES) if (m.alive && m.y > -2.6 && m.s > G.s && m.s - G.s < 55) consider(m, 'mine');
  }
  if (!best) return null;
  aimHit.obj = best; aimHit.kind = bestK; aimHit.wp = best.wp;
  return aimHit;
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
  return best && viewLOS(from, best.wp, G.s) ? best : null;
}
function fireRocket() {
  if (G.rocketCd > 0) return;
  if (G.rockets <= 0) { audio.empty(); popScore('NO ROCKETS / НЕТ РАКЕТ'); G.rocketCd = 0.4; return; }
  const r = rockets.find((x) => !x.on);
  if (!r) return;
  G.rockets--; G.rocketsFired++; G.rocketCd = ROCKET_CD;
  ship.body.updateMatrixWorld();
  const p = ship.body.localToWorld(V1.set(0, -1.15, -5.5));
  r.on = true; r.p.copy(p); r.q.copy(p); r.life = 3.2; r.s = G.s; r.age = 0; r.from = `${G.s.toFixed(0)}/${G.lat.toFixed(0)}/${G.y.toFixed(0)}`;
  const at = aimTarget(p, 1.4);   // rockets are deliberate: a slightly wider lock than the cannon
  r.target = at && at.kind !== 'beacon' ? at.obj : findRocketTarget(p, shipFwd);
  // rim turret lock: launch straight along the line of fire (a pursuit curve would graze the wall below the ledge);
  // otherwise inherit the ship's velocity plus a forward kick
  if (r.target && TURRETS.includes(r.target)) r.v.copy(r.target.wp).sub(p).normalize().multiplyScalar(shipVel.length() + 25);
  else r.v.copy(shipVel).addScaledVector(shipFwd, 25);
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
  let nt = 1e9; for (const t of TURRETS) if (t.alive) nt = Math.min(nt, t.wp.distanceTo(p));
  G.rkLog.push(`${direct || ''}age${r.age.toFixed(2)} s${r.s.toFixed(0)} y${p.y.toFixed(1)} turret${nt.toFixed(0)}m tgt:${r.target ? (r.target.s.toFixed(0) + '/' + r.target.lat.toFixed(0) + '/' + r.target.y.toFixed(0)) : '-'} from:${r.from}`);
  // splash damage: everything near the blast — including the force-field masts (risky!)
  for (const d of DRONES) if (d.alive && d.wp.distanceTo(p) < ROCKET_SPLASH) killTarget('drone', d);
  for (const b of BEACONS) if (b.alive && b.wp.distanceTo(p) < ROCKET_SPLASH) killTarget('beacon', b);
  for (const t of TURRETS) if (t.alive && t.wp.distanceTo(p) < ROCKET_SPLASH) killTarget('turret', t);
  for (const m of MASTS) if (m.alive && m.pts.some((pt) => pt.distanceTo(p) < MAST_SPLASH)) breakMast(m);
  // naval: the blast reaches mines and hunters just under the surface; boats are armoured against it
  for (const m of MINES) if (m.alive && m.wp.distanceTo(p) < 15) { m.fuse = 0.05 + m.wp.distanceTo(p) * 0.01; m.cause = 'rocket'; }
  for (const h of HUNTERS) if (h.alive && h.wp.distanceTo(p) < 10) killHunter(h);
  if (direct === 'boat ') armoredTag(p);
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
      const rate = TURRETS.includes(r.target) ? 2.4 : 1.3;   // turrets sit high on the ledges: steeper climb
      if (ang > 1e-4) V3.lerp(V4, Math.min(1, (rate * dt) / ang)).normalize();
    }
    r.v.copy(V3).multiplyScalar(sp);
    r.q.copy(r.p);
    r.p.addScaledVector(r.v, dt);
    let hit = r.life <= 0 ? 'timeout ' : false;
    if (!hit) for (const d of DRONES) if (d.alive && Math.abs(d.s - r.s) < 50 && segSphere(r.q, r.p, d.wp, 3.2)) { hit = true; break; }
    if (!hit) for (const t of TURRETS) if (t.alive && Math.abs(t.s - r.s) < 50 && segSphere(r.q, r.p, t.wp, 3)) { hit = 'turret '; break; }
    if (!hit) for (const b of BEACONS) if (b.alive && Math.abs(b.s - r.s) < 50 && segSphere(r.q, r.p, b.wp, 2.4)) { hit = true; break; }
    if (!hit) for (const m of MASTS) if (m.alive && Math.abs(m.s - r.s) < 50 && m.pts.some((pt) => segSphere(r.q, r.p, pt, 2.1))) { hit = true; break; }
    if (!hit && r.p.y < BOAT_TOP + 0.5) for (const bt of BOATS) if (bt.alive && Math.abs(bt.s - r.s) < 30 && inBoat(bt, r.p, 0.6)) { hit = 'boat '; break; }
    if (!hit && r.age > 0.08) {
      // terrain / water
      const pr = projectToPath(r.p.x, r.p.z, r.s);
      r.s = pr.s;
      const side = pr.lat > 0 ? 1 : -1;
      if (side * pr.lat > wallLat(r.s, r.p.y, side) || r.p.y < 0) hit = 'world ';
      else for (const k of ROCKS) if (Math.abs(k.s - r.s) < k.r + 2 && r.p.y < k.h && Math.abs(k.lat - pr.lat) < k.r) { hit = true; break; }
      if (!hit) for (const a of ARCHES) if (Math.abs(a.s - r.s) < a.ht && r.p.y > archBottom(a, pr.lat) && r.p.y < archTop(a, pr.lat)) { hit = true; break; }
    }
    if (hit) { detonateRocket(r, hit === true ? '' : hit); continue; }
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
  // a relay kill that cuts its section's last link pays a bonus
  const blinds = kind === 'beacon' && !zoneLinked(obj.zone);
  const pts = kind === 'drone' ? 150 : kind === 'turret' ? 250 : RELAY_PTS + (blinds ? RELAY_BLIND_PTS : 0);
  G.score += pts;
  explode(kind === 'turret' ? obj.wp : obj.wp, kind === 'beacon' ? 0.8 : kind === 'turret' ? 1.3 : 1);
  audio.hitTick(); audio.score();
  hitMarker();
  const label = { drone: 'SPOTTER / ДРОН', beacon: 'RELAY / РЕТРАНСЛЯТОР', turret: 'TURRET / ТУРЕЛЬ' }[kind];
  popScore(`+${pts} ${label}`);
  if (kind === 'beacon') { beacons.setMatrixAt(BEACONS.indexOf(obj), ZERO_M); beacons.instanceMatrix.needsUpdate = true; relayDown(obj, blinds); }
  if (kind === 'drone' && obj.spotting) {
    // killing the spotter wipes the mark and breaks a pending lock
    G.mark = 0;
    if (G.lock.phase === 'laser') G.lock.phase = 'none';
    obj.spotting = false;
    showMsg('SPOTTER DOWN — MARK CLEARED', 'СПОТТЕР СБИТ — МЕТКА СНЯТА', 1.6, '#9ff2d8');
  }
  if (kind === 'turret') { G.turretKills++; if (G.lock.turret === obj) G.lock.phase = 'none'; }
}
// ---- LETHE relays (round 5): a dead relay cuts its section's turrets off from the drones' mark
const RELAY_PTS = 200, RELAY_BLIND_PTS = 150;
function relayDown(r, blinds) {
  G.relayKills++;
  sparkBurst(r.top, 14, [2.2, 0.3, 0.15]);
  if (!blinds) {
    const left = r.zone.relays.filter((x) => x.alive).length;
    toast(`<b>RELAY DOWN</b> — sector still linked (${left} left)<br><i>РЕТРАНСЛЯТОР СБИТ — сектор ещё на связи (осталось ${left})</i>`, 3.5, true);
    return;
  }
  // the section goes blind: break a lock held by one of its turrets
  const L = G.lock;
  if (L.turret && L.turret.zone === r.zone && (L.phase === 'laser' || L.phase === 'volley')) { L.phase = 'cool'; L.t = 0.6; }
  showMsg('RELAY DOWN — TURRETS BLIND', 'РЕТРАНСЛЯТОР СБИТ — ТУРЕЛИ ОСЛЕПЛИ', 2, '#ffb070');
  toast('<b>RELAY DOWN — turrets blind</b><br><i>РЕТРАНСЛЯТОР СБИТ — турели ослепли</i>', 3.5, true);
  if (!G.blindSaid) {
    G.blindSaid = true;
    toast('LETHE: <em>“…link lost. Sector blind.”</em> &nbsp;/&nbsp; ЛЕТА: <em>«…связь потеряна. Сектор слеп.»</em>', 4);
  }
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
    b.p.addScaledVector(b.d, (b.under ? UW_BOLT_SPEED : BOLT_SPEED) * dt);
    b.life -= dt;
    let dead = b.life <= 0;
    if (b.under) {
      // underwater: mines, hunters, boat bellies; dies at the surface, the banks and the bed
      if (!dead) dead = navalBoltHit(b, true);
      if (!dead) dead = uwBoltWorld(b);
    } else {
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
      if (!dead) dead = navalBoltHit(b, false);   // boats: armoured from above (ricochet)
      // entering the water: the bolt carries a few metres down — enough for mines just under the surface
      if (!dead && b.p.y < 0 && b.q.y >= 0) {
        V4.lerpVectors(b.q, b.p, b.q.y / Math.max(1e-4, b.q.y - b.p.y));   // water entry point
        V3.copy(V4).addScaledVector(b.d, Math.min(22, 3.2 / Math.max(0.05, -b.d.y)));
        for (const m of MINES) if (m.alive && Math.abs(m.s - b.s) < 40 && segSphere(V4, V3, m.wp, 2.0)) { killMine(m, 'shot'); break; }
      }
      if (!dead) dead = boltWorldHit(b);
    }
    if (dead) { b.on = false; continue; }
    // glowing tracer: bright core + additive glow + short trail (turquoise underwater)
    const tl = Math.min(b.under ? 7 : 11, b.p.distanceTo(b.o));
    V3.copy(b.p).addScaledVector(b.d, -tl);
    if (b.under) {
      beams.add(V3.x, V3.y, V3.z, b.p.x, b.p.y, b.p.z, 0.5, 0.25, 1.6, 1.45, 1);
      glows.add(b.p.x, b.p.y, b.p.z, 0.3, 1.4, 1.3, 0.9, 2.2);
      if (Math.random() < 0.5) mist.emit(b.p.x, b.p.y, b.p.z, 0, 1 + Math.random(), 0, 0.7, 0.25, 0.6, 0.75, 1, 1, 0.6, -4, 2);
    } else {
      beams.add(V3.x, V3.y, V3.z, b.p.x, b.p.y, b.p.z, 0.55, 2.2, 1.15, 0.4, 1);
      glows.add(b.p.x, b.p.y, b.p.z, 1.6, 0.9, 0.35, 0.9, 2.4);
    }
  }
}
// underwater bolt vs the world: surface (from below), banks, bed, rock columns
function uwBoltWorld(b) {
  const pr = projectToPath(b.p.x, b.p.z, b.s);
  b.s = pr.s; b.lat = pr.lat;
  const p = b.p;
  if (p.y > -0.2) {
    for (let i = 0; i < 6; i++) mist.emit(p.x, 0.2, p.z, (Math.random() - 0.5) * 3, 2 + Math.random() * 4, (Math.random() - 0.5) * 3, 0.6, 0.6, 2, 0.85, 0.96, 0.95, 0.6, 12, 0.5);
    return true;
  }
  let hit = Math.abs(pr.lat) > riverHalf(pr.s) * 0.97 || p.y < bedY(pr.s, pr.lat);
  if (!hit) for (const r of ROCKS) if (Math.abs(r.s - b.s) < r.r + 1 && Math.abs(r.lat - pr.lat) < r.r) { hit = true; break; }
  if (hit) {
    sparks.emit(p.x, p.y, p.z, 0, 0, 0, 0.14, 2.5, 4, 0.4, 1.4, 1.3, 1);
    for (let i = 0; i < 5; i++) mist.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3, 1.2, 0.3, 1, 0.7, 0.95, 0.95, 0.6, -5, 1.5);
  }
  return hit;
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
function enemyBolt(from, target, s, sp, col, dmg, rad, src, under = false, life = 3) {
  const b = ebolts.find((x) => !x.on);
  if (!b) return null;
  b.on = true; b.p.copy(from); b.q.copy(from); b.o.copy(from);
  b.d.copy(target).sub(from).normalize();
  b.life = life; b.life0 = life; b.s = s; b.accurate = false; b.minD = 1e9;
  b.sp = sp; b.col = col; b.dmg = dmg; b.rad = rad; b.src = src; b.under = under;
  return b;
}
function fireTurret(t, target, accurate) {
  const b = enemyBolt(t.muzzle, target, t.s, EB_SPEED, EB_RED, EB_DMG, 3.8, 'turret');
  if (!b) return;
  b.accurate = accurate;
  G.turretShotsFired++;
  threat(t, t.wp);
  sparks.emit(t.muzzle.x, t.muzzle.y, t.muzzle.z, 0, 0, 0, 0.12, 6, 3, 2.4, 0.4, 0.2, 1);
  lightFlash(t.muzzle, 160, 0.12, 1, 0.25, 0.15);
  audio.turretShot(panOf(t.muzzle) * 0.8);
}
// predict where the ship will be along the (curving) canyon when the bolt arrives
function leadTarget(from, out, sp = EB_SPEED, under = false) {
  let tf = from.distanceTo(shipPos) / sp;
  for (let k = 0; k < 3; k++) {
    const y = G.y + G.vY * tf * 0.5;
    toWorld(G.s + G.speed * tf, G.lat + G.vLat * tf * 0.8, under ? Math.min(-1, y) : Math.max(1.2, y), out);
    tf = from.distanceTo(out) / sp;
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
    threat(d, d.wp);
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
  // --- relays (round 5): the mark reaches the turrets only through a live relay of the ship's section
  for (const t of TURRETS) t.blind = !zoneLinked(t.zone);
  const shipZone = zoneAt(G.s);
  G.noRelay = active && !zoneLinked(shipZone);
  // --- mark meter
  if (G.spotters > 0) G.mark = Math.min(1, G.mark + dt / 3.4);
  else G.mark = Math.max(0, G.mark - dt * (G.underwater ? 1.4 : 0.28));
  if (G.spotters > 0 && G.mark < 1 && !G.noRelay) {
    G.markBeep -= dt;
    if (G.markBeep <= 0) { audio.lockTick(G.mark); G.markBeep = lerp(0.42, 0.09, G.mark); }
  }
  // --- lock sequence: laser designation -> accurate volley -> cooldown
  const cand = G.noRelay ? null : pickLockTurret();
  if (L.phase === 'none' && G.mark >= 1 && active) {
    if (cand) {
      L.phase = 'laser'; L.t = 1.35; L.turret = cand; L.shots = 0; G.lostSaid = false; L.relay = true;
      logLock(cand, true);
      audio.lockOn(); audio.laser();
      showMsg('LETHE LOCK — DIVE OR DODGE', 'ЗАХВАТ ЛЕТЫ — НЫРЯЙ', 1.6, '#ff6a50');
    } else if (G.noRelay && !G.blockLogged) { G.blockLogged = true; logLock(null, false); }
  }
  if (G.mark < 0.5) G.blockLogged = false;
  // a lock can't survive its section going blind (also covers a relay killed by a rocket splash)
  if ((L.phase === 'laser' || L.phase === 'volley') && L.turret && L.turret.blind) { L.phase = 'cool'; L.t = 0.6; }
  if ((L.phase === 'laser' || L.phase === 'volley') && L.turret) threat(L.turret, L.turret.wp);
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
  // --- turrets: track the ship, rare inaccurate harassment when unmarked; blind ones scan slowly and rarely fire wild
  let colDirty = false;
  for (let i = 0; i < TURRETS.length; i++) {
    const t = TURRETS[i];
    if (t.blind !== t.wasBlind) { t.wasBlind = t.blind; turrets.setColorAt(i, t.blind ? TUR_BLIND : TUR_LIVE); colDirty = true; }
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
    // aim (smoothly) at the ship — a blind turret sweeps the canyon instead
    if (t.blind) toWorld(t.s + 70 * Math.sin(time * 0.35 + i * 1.7), -t.side * 10, 8 + 6 * Math.sin(time * 0.5 + i), V3).sub(t.wp).normalize();
    else V3.copy(shipPos).sub(t.wp).normalize();
    t.aim.lerp(V3, damp(L.turret === t && L.phase !== 'none' ? 8 : 2.5, dt)).normalize();
    M1.lookAt(V1.set(0, 0, 0), t.aim, UP);
    M1.setPosition(t.wp);
    turrets.setMatrixAt(i, M1);
    t.muzzle.set(0, 1.0, -5.4).applyMatrix4(M1);
    t.eye.set(0, 1.4, -3.15).applyMatrix4(M1);
    const locked = L.turret === t && (L.phase === 'laser' || L.phase === 'volley');
    // red sensor eye: bloom sprite with a distance-scaled minimum size (stays a readable dot far away; fog-compensated).
    // The sprites are depth-tested, so walls still hide turrets around a bend.
    if (!camUnder && t.blind) {
      // blind: a dull, steady dark-red ember, no fog compensation and no lock pulse
      const minS = (7 * t.eye.distanceTo(camera.position)) / pxScale;
      glows.add(t.eye.x, t.eye.y, t.eye.z, 0.55, 0.12, 0.1, 0.55, Math.max(2.2, minS));
    } else if (!camUnder) {
      const dc = t.eye.distanceTo(camera.position);
      const fd = dc * scene.fog.density, fogK = Math.exp(-fd * fd);
      const minS = (16 * dc) / pxScale;
      const base = locked ? 0.85 + 0.15 * Math.sin(time * 30) : 0.55 + 0.3 * Math.sin(time * 4 + i);
      const a = Math.min(3.5, base / Math.max(0.3, fogK));
      glows.add(t.eye.x, t.eye.y, t.eye.z, 2.4, 0.14, 0.07, a, Math.max(locked ? 6 : 3.4, minS * (locked ? 1.7 : 1)));
      glows.add(t.eye.x, t.eye.y, t.eye.z, 1.8, 0.08, 0.04, a * (locked ? 0.45 : 0.22), Math.max(locked ? 16 : 9, minS * 3));
    }
    if (!active || G.underwater) continue;
    const ds = t.s - G.s;
    if (!locked && ds > -40 && ds < 360 && (G.mark < 0.5 || t.blind)) {
      t.cd -= dt;
      if (t.cd <= 0) {
        const wild = t.blind ? 2.2 : 1;
        t.cd = (6 + Math.random() * 5) * (t.blind ? 2.6 : 1);
        V4.copy(shipPos).add(V2.set((Math.random() - 0.5) * 28 * wild, 4 + Math.random() * 10 * wild, (Math.random() - 0.5) * 28 * wild));
        if (lineOfSight(t.wp, shipPos, t.s)) fireTurret(t, V4, false);
      }
    }
  }
  turrets.instanceMatrix.needsUpdate = true;
  if (colDirty) turrets.instanceColor.needsUpdate = true;
  dataBeams(time, cand);
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
    b.p.addScaledVector(b.d, b.sp * dt);
    b.life -= dt;
    b.minD = Math.min(b.minD, b.p.distanceTo(shipPos));
    let dead = b.life <= 0;
    if (!dead && G.phase !== 'result' && segSphere(b.q, b.p, shipPos, b.rad)) {
      if (b.src === 'turret') G.turretHits++; else G.navalHits++;
      const through = damage(b.dmg, b.p.clone(), 'bolt');
      G.shake = Math.min(1.4, G.shake + 0.45);
      sparkBurst(b.p, 18, through > 0 ? [1.8, 0.9, 0.4] : [0.6, 1.5, 2]);
      explodeSmall(b.p);
      dead = true;
    }
    if (!dead && b.life < b.life0 - 0.1) { dead = b.under ? uwBoltWorld(b) : boltWorldHit(b); if (dead) b.why = 'world'; }
    if (dead) { b.on = false; if (b.accurate) G.ebLog.push((b.why || 'x') + ':' + b.minD.toFixed(1) + '@' + (3 - b.life).toFixed(2)); b.why = null; continue; }
    const tl = Math.min(9, b.p.distanceTo(b.o)), c = b.col;
    V3.copy(b.p).addScaledVector(b.d, -tl);
    beams.add(V3.x, V3.y, V3.z, b.p.x, b.p.y, b.p.z, 0.75, c[0], c[1], c[2], 1);
    glows.add(b.p.x, b.p.y, b.p.z, c[0] * 0.9, c[1] * 0.9 + 0.1, c[2] * 0.9, 1, 3.4);
  }
}
// the turret a full mark would hand over to: a live, linked turret in the window ahead (nearest to ~120 m ahead)
function pickLockTurret() {
  let best = null, bd = 1e9;
  for (const t of TURRETS) {
    if (!t.alive || t.blind) continue;
    const ds = t.s - G.s;
    if (ds < -90 || ds > 450) continue;
    const d = Math.abs(ds - 120);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}
function logLock(t, relay) {
  G.lockLog.push({ t: +G.t.toFixed(2), s: Math.round(G.s), turret: t ? TURRETS.indexOf(t) : -1, zone: zoneAt(G.s)?.idx ?? -1, relay, locked: !!t });
  if (G.lockLog.length > 20) G.lockLog.shift();
}
// DATA BEAM: while the mark builds / holds, faint red-amber packets run marking drone -> relay -> locking turret
const DB_SEG = { low: 6, med: 11, high: 16 };
function dataSeg(a, b, time, k, alpha) {
  const len = a.distanceTo(b);
  if (len < 1) return;
  const n = Math.min(DB_SEG[quality] || 11, Math.ceil(len / 9)), dl = Math.min(2.6, (len / n) * 0.4);
  // faint carrier line, then dashed packets travelling a -> b
  beams.add(a.x, a.y, a.z, b.x, b.y, b.z, 0.12, 1.7, 0.36, 0.1, alpha * (0.4 + 0.12 * Math.sin(time * 9 + k)));
  const ph = (time * 1.6 + k * 0.37) % 1;
  for (let j = 0; j < n; j++) {
    const u = (j + ph) / n, u0 = Math.max(0, u - dl / len);
    const fl = alpha * (0.55 + 0.45 * Math.sin(time * 14 + j * 2.1 + k));
    beams.add(a.x + (b.x - a.x) * u0, a.y + (b.y - a.y) * u0, a.z + (b.z - a.z) * u0,
      a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u, 0.3, 2.6, 0.7, 0.16, fl);
  }
  G.beamSegs++;
}
function dataBeams(time, cand) {
  G.beamSegs = 0; G.beamTurret = -1;
  const L = G.lock, holding = L.phase === 'laser' || L.phase === 'volley';
  if (camUnder || G.phase !== 'flight' || (!holding && (G.spotters === 0 || G.mark < 0.02))) return;
  const t = holding ? L.turret : cand;
  if (!t || t.blind || !t.alive) return;
  let drone = null, dd = 1e9;
  for (const d of DRONES) if (d.spotting) { const x = d.wp.distanceTo(shipPos); if (x < dd) { dd = x; drone = d; } }
  // the relay of the turret's section nearest to the marking drone (or to the ship)
  const from = drone ? drone.wp : shipPos;
  let relay = null, rd = 1e9;
  for (const r of t.relays) if (r.alive) { const x = r.top.distanceTo(from); if (x < rd) { rd = x; relay = r; } }
  if (!relay) return;
  const a = holding ? 1 : 0.35 + 0.65 * G.mark;
  if (drone) dataSeg(drone.wp, relay.top, time, 0, a);
  dataSeg(relay.top, t.eye, time, 1, a);
  // the relay's top light flares while it is passing the mark
  glows.add(relay.top.x, relay.top.y, relay.top.z, 2.4, 0.5, 0.15, 0.6 + 0.4 * Math.sin(time * 18), 7);
  G.beamTurret = TURRETS.indexOf(t);
}
function explodeSmall(p) {
  for (let i = 0; i < 6; i++) sparks.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, 0.35, 2, 5, 2, 0.7, 0.3, 1, 0, 2);
  lightFlash(p, 220, 0.2, 1, 0.5, 0.25);
}

// ------------------------------------------------------------------ naval layer (round 4): mines, hunter-subs, boats
function initNaval() {
  for (const m of MINES) { m.bed = bedY(m.s, m.lat); toWorld(m.s, m.lat, m.bed, m.anchor); m.cause = null; }
  for (const h of HUNTERS) {
    h.ps = h.s; h.pl = h.lat; h.py = h.y; h.vs = 0; h.vl = 0; h.vy = 0; h.mode = 'patrol'; h.cd = 0; h.charge = 0; h.huntT = 0; h.vis = false;
    toWorld(h.ps, h.pl, h.py, h.wp);
  }
  for (const b of BOATS) {
    b.hp = BOAT_HP; b.head = b.dir > 0 ? 0 : Math.PI; b.sinkT = 0; b.cd = 2 + Math.random() * 2; b.fire = 'idle'; b.ft = 0; b.shots = 0; b.flashT = 0;
    toWorld(b.s, b.lat, BOAT_KEEL - 0.05, b.wp); toWorld(b.s, b.lat, 2.4, b.deck);
    boatM.panels.setColorAt(BOATS.indexOf(b), BOAT_PANEL[b.type]);
  }
  boatM.panels.instanceColor.needsUpdate = true;
  spouts.length = 0;
}
// is world point p inside a boat's hull box (path space; boats run along the river)
function inBoat(bt, p, m = 0) {
  if (p.y < BOAT_KEEL - 0.5 - m || p.y > BOAT_TOP + m) return false;
  const pr = projectToPath(p.x, p.z, bt.s);
  const c = Math.abs(Math.cos(bt.head)), sn = Math.abs(Math.sin(bt.head));
  return Math.abs(pr.s - bt.s) < c * BOAT_HL + sn * BOAT_HW + m && Math.abs(pr.lat - bt.lat) < c * BOAT_HW + sn * BOAT_HL + m;
}
// player bolt vs naval targets; returns true if the bolt is used up
function navalBoltHit(b, under) {
  if (under) {
    for (const m of MINES) if (m.alive && Math.abs(m.s - b.s) < 30 && segSphere(b.q, b.p, m.wp, 1.9)) { killMine(m, 'shot'); return true; }
    for (const h of HUNTERS) if (h.alive && Math.abs(h.ps - b.s) < 30 && segSphere(b.q, b.p, h.wp, 1.8)) { killHunter(h); return true; }
  }
  for (const bt of BOATS) {
    if (!bt.alive || Math.abs(bt.s - b.s) > 24 || !inBoat(bt, b.p, 0.3)) continue;
    if (under && b.p.y < 0.2) hitBoat(bt, b.p);
    else if (!under && b.p.y > -0.3) ricochet(bt, b.p, b.d);
    else continue;
    return true;
  }
  return false;
}
function navalKill(pts, label) {
  G.score += pts;
  audio.hitTick(); audio.score();
  hitMarker();
  popScore(`+${pts} ${label}`);
}
// ---- mines
function killMine(m, cause) { m.cause = cause; detonateMine(m); }
function detonateMine(m) {
  if (!m.alive) return;
  m.alive = false; m.fuse = 0;
  const p = V4.copy(m.wp).clone();
  underwaterBlast(p, 1.15);
  const contact = m.cause === 'contact';
  if (!contact) { G.mineKills++; navalKill(MINE_PTS, 'MINE / МИНА'); }
  const d = p.distanceTo(shipPos);
  if (contact) {
    G.mineHits++;
    damage(MINE_DMG, p, 'mine');
    G.hitFlash = 1; G.shake = Math.min(1.6, G.shake + 1.1); G.speed *= 0.7; G.vY += G.y > 0 ? 9 : 4;
    showMsg('MINE!', 'МИНА!', 1.2, '#ff8a5a');
  } else if (d < 11 && (G.phase === 'flight' || G.phase === 'landing')) {
    damage(MINE_DMG * 0.7 * (1 - d / 11), p, 'mine');
    G.shake = Math.min(1.5, G.shake + 0.6);
  }
  // sympathetic detonation of neighbours, shock kills hunters nearby
  for (const o of MINES) if (o.alive && !o.fuse && o.wp.distanceTo(p) < 10) { o.fuse = 0.16 + Math.random() * 0.1; o.cause = 'chain'; }
  for (const h of HUNTERS) if (h.alive && h.wp.distanceTo(p) < 9) killHunter(h);
}
// underwater shockwave + flash + bubbles, and a big water spout column breaking the surface
function underwaterBlast(p, big = 1) {
  for (let i = 0; i < 44; i++) {
    const a = (i / 44) * 6.283, v = (22 + Math.random() * 6) * big;
    mist.emit(p.x, p.y, p.z, Math.cos(a) * v, (Math.random() - 0.5) * 3, Math.sin(a) * v, 0.75, 1.2, 4.5, 0.78, 0.97, 1, 0.75, 0, 3.4);
  }
  for (let i = 0; i < 40 * big; i++) {
    mist.emit(p.x + (Math.random() - 0.5) * 3, p.y + (Math.random() - 0.5) * 2, p.z + (Math.random() - 0.5) * 3,
      (Math.random() - 0.5) * 9, 2 + Math.random() * 7, (Math.random() - 0.5) * 9, 1.3 + Math.random() * 1.2, 0.4, 1.4, 0.8, 1, 1, 0.75, -7, 1.6);
  }
  sparks.emit(p.x, p.y, p.z, 0, 0, 0, 0.3, 10 * big, 30 * big, 1.3, 1.9, 2.1, 1);
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * 6.28, e = Math.random() * 2 - 1, v = 10 + Math.random() * 18, c = Math.sqrt(1 - e * e);
    sparks.emit(p.x, p.y, p.z, Math.cos(a) * c * v, e * v, Math.sin(a) * c * v, 0.3 + Math.random() * 0.3, 1, 0.3, 1.8, 1.2, 0.6, 1, 0, 3);
  }
  lightFlash(p, 520 * big, 0.45, 0.7, 0.95, 1);
  G.flash = { p: p.clone(), t: 0.28, big: big * 0.8, cold: true };
  if (p.y < 0.5) spouts.push({ x: p.x, z: p.z, t: 0, dur: 0.75, big, delay: Math.max(0, -p.y) * 0.025 });
  const near = clamp(1 - camera.position.distanceTo(p) / 180, 0, 1);
  G.shake = Math.min(1.5, G.shake + (0.2 + 0.8 * near) * big);
  audio.explosion(big * 0.9, near, panOf(p));
  audio.splash();
}
function updateSpouts(dt) {
  for (let i = spouts.length - 1; i >= 0; i--) {
    const sp = spouts[i];
    if (sp.delay > 0) { sp.delay -= dt; continue; }
    if (sp.t === 0) splash(V3.set(sp.x, 0, sp.z), 120, 1.5 * sp.big);
    sp.t += dt;
    const k = 1 - sp.t / sp.dur;
    let n = 520 * sp.big * dt * (0.4 + k);
    while (n > 0 && Math.random() < n) {
      n -= 1;
      const r = Math.random() * 1.8, a = Math.random() * 6.28;
      mist.emit(sp.x + Math.cos(a) * r, 0.4, sp.z + Math.sin(a) * r, Math.cos(a) * 2.5, (26 + Math.random() * 22) * sp.big * (0.6 + 0.4 * k), Math.sin(a) * 2.5,
        1.3 + Math.random() * 0.9, 1.6, 7 + Math.random() * 4, 0.9, 0.96, 0.96, 0.85, 24, 0.35);
    }
    if (sp.t >= sp.dur) spouts.splice(i, 1);
  }
}
// ---- hunters
function killHunter(h) {
  if (!h.alive) return;
  h.alive = false;
  G.hunterKills++;
  const p = h.wp;
  // bubble burst + cold flash
  for (let i = 0; i < 46; i++) {
    const a = Math.random() * 6.28, e = Math.random() * 2 - 1, v = 4 + Math.random() * 12, c = Math.sqrt(1 - e * e);
    mist.emit(p.x, p.y, p.z, Math.cos(a) * c * v, e * v + 2, Math.sin(a) * c * v, 1 + Math.random() * 1.4, 0.35, 1.3, 0.8, 1, 1, 0.8, -8, 2.2);
  }
  sparks.emit(p.x, p.y, p.z, 0, 0, 0, 0.22, 6, 16, 0.6, 1.9, 2.1, 1);
  for (let i = 0; i < 18; i++) sparks.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 0.3, 0.9, 0.3, 0.5, 1.8, 2, 1, 0, 3);
  for (let i = 0; i < 4; i++) { V4.set(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5).normalize().multiplyScalar(6 + Math.random() * 6); debris.emit(p, V4, 0.2 + Math.random() * 0.2, 0.2); }
  lightFlash(p, 300, 0.3, 0.4, 0.95, 1);
  audio.explosion(0.5, clamp(1 - camera.position.distanceTo(p) / 120, 0, 1), panOf(p));
  navalKill(HUNTER_PTS, 'HUNTER / ОХОТНИК');
}
// ---- boats
function hitBoat(bt, p) {
  bt.hp--; bt.flashT = 0.15;
  const c = bt.type === 'patrol' ? [0.6, 1.8, 2] : [2, 1.1, 0.4];
  for (let i = 0; i < 10; i++) sparks.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 14, -Math.random() * 6, (Math.random() - 0.5) * 14, 0.3, 0.9, 0.3, c[0], c[1], c[2], 1, 0, 3);
  for (let i = 0; i < 6; i++) mist.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 3, 1 + Math.random() * 3, (Math.random() - 0.5) * 3, 1, 0.3, 1, 0.8, 1, 1, 0.6, -6, 1.5);
  audio.impact();
  if (bt.hp <= 0) killBoat(bt);
}
function killBoat(bt) {
  if (!bt.alive) return;
  bt.alive = false; bt.sinkT = 0;
  G.boatKills++;
  explode(V4.copy(bt.deck).clone(), 1.4);
  for (let i = 0; i < 8; i++) {
    V4.set(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(12 + Math.random() * 16);
    debris.emit(bt.deck, V4, 0.4 + Math.random() * 0.6, 0.8);
  }
  splash(bt.deck, 120, 1.4);
  navalKill(BOAT_PTS[bt.type], bt.type === 'patrol' ? 'PATROL BOAT / КАТЕР' : 'SMUGGLER / КОНТРАБАНДИСТ');
}
const armorEls = [];
let armorI = 0;
function ricochet(bt, p, d) {
  // deflected sparks + a metallic tick: the deck armour is proof against bolts from above
  for (let i = 0; i < 10; i++) {
    const v = 14 + Math.random() * 20;
    sparks.emit(p.x, p.y, p.z, -d.x * v * 0.5 + (Math.random() - 0.5) * 10, 5 + Math.random() * 12, -d.z * v * 0.5 + (Math.random() - 0.5) * 10, 0.25 + Math.random() * 0.2, 0.7, 0.2, 2.2, 1.9, 1.5, 1, 22, 1);
  }
  sparks.emit(p.x, p.y, p.z, 0, 0, 0, 0.08, 3, 4, 2.4, 2.2, 1.9, 1);
  audio.ricochet(panOf(p));
  armoredTag(p);
}
function armoredTag(p) {
  if (G.armorT > 0) return;
  G.armorT = 0.45;
  G.ricochets++;
  if (!armorEls.length) for (let i = 0; i < 3; i++) {
    const el = document.createElement('div'); el.className = 'armor'; el.textContent = 'ARMORED / БРОНЯ';
    $('tgts').appendChild(el); armorEls.push(el);
  }
  toScreen(p, SCR2);
  if (SCR2.z >= 1) return;
  const el = armorEls[armorI++ % armorEls.length];
  el.style.left = clamp(SCR2.x, 60, innerWidth - 60).toFixed(0) + 'px';
  el.style.top = clamp(SCR2.y, 40, innerHeight - 40).toFixed(0) + 'px';
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
}
function shipHitsBoat(bt) {
  const ds = G.s - bt.s, dl = G.lat - bt.lat;
  const c = Math.abs(Math.cos(bt.head)), sn = Math.abs(Math.sin(bt.head));
  const hl = c * BOAT_HL + sn * BOAT_HW + SHIP_R * 0.8, hw = c * BOAT_HW + sn * BOAT_HL + SHIP_R * 0.8;
  if (Math.abs(ds) > hl || Math.abs(dl) > hw || G.y > BOAT_TOP + 0.8 || G.y < BOAT_KEEL - 0.85) return;   // the default dive depth (−2.4 m) passes under the keel
  if (ds < 0 && Math.abs(dl) < hw * 0.75) {
    G.s = bt.s - hl - 0.1; G.speed *= 0.55;
    G.vLat = Math.sign(dl || 1) * 14; G.lat += Math.sign(dl || 1) * 1.5;
  } else {
    G.lat = bt.lat + Math.sign(dl || 1) * hw; G.vLat = Math.sign(dl || 1) * 12;
  }
  hitCargo(9 + G.speed * 0.06, V1.copy(shipPos).addScaledVector(shipFwd, 4).clone());
}

function updateNaval(dt, time) {
  const flying = G.phase === 'flight' || G.phase === 'landing';
  const sub = G.underwater && G.phase === 'flight';
  // ---- mines: bob on their chains, faint red blink, proximity fuse
  for (let i = 0; i < MINES.length; i++) {
    const m = MINES[i];
    if (m.fuse > 0) { m.fuse -= dt; if (m.fuse <= 0) { m.fuse = 0; detonateMine(m); } }
    if (!m.alive || m.s < G.s - 120 || m.s > G.s + 900) {
      mineM.mines.setMatrixAt(i, ZERO_M); mineM.chains.setMatrixAt(i, ZERO_M); mineM.sinkers.setMatrixAt(i, ZERO_M);
      if (!m.alive) m.wp.set(0, -1e4, 0);
      continue;
    }
    const sway = Math.sin(time * 0.4 + m.phase) * 0.6, bob = Math.sin(time * 0.7 + m.phase * 1.7) * 0.3;
    toWorld(m.s, m.lat + sway, m.y + bob, m.wp);
    pathBasis(m.s, M1);
    M1.multiply(M2.makeRotationY(time * 0.12 + m.phase)).multiply(M2.makeRotationZ(sway * 0.12));
    M1.setPosition(m.wp);
    mineM.mines.setMatrixAt(i, M1);
    // tether: sinker on the bed -> bottom of the mine
    V1.copy(m.wp); V1.y -= 1.3;
    V2.copy(V1).sub(m.anchor);
    const len = V2.length();
    Q1.setFromUnitVectors(UP, V2.multiplyScalar(1 / len));
    M1.compose(m.anchor, Q1, V3.set(1, len, 1));
    mineM.chains.setMatrixAt(i, M1);
    pathBasis(m.s, M1); M1.setPosition(m.anchor);
    mineM.sinkers.setMatrixAt(i, M1);
    // faint red blinking light (visible underwater); a faint red glimmer on the surface over shallow ones
    const bl = Math.sin(time * 3.1 + m.phase * 3) > 0.55 ? 1 : 0.12;
    glows.add(m.wp.x, m.wp.y + 1.25, m.wp.z, 2.2, 0.12, 0.07, 0.75 * bl, 1.9);
    if (m.y > -2.2 && !camUnder) glows.add(m.wp.x, 0.15, m.wp.z, 1.8, 0.12, 0.06, 0.28 * bl, 2.2);
    if (flying && m.wp.distanceToSquared(shipPos) < MINE_TRIG * MINE_TRIG) killMine(m, 'contact');
  }
  mineM.mines.instanceMatrix.needsUpdate = mineM.chains.instanceMatrix.needsUpdate = mineM.sinkers.instanceMatrix.needsUpdate = true;
  // ---- hunter-subs: patrol below; engage only a submerged ship nearby (pace it, charge, fire a short-range bolt, lunge)
  let engaged = 0;
  for (const h of HUNTERS) if (h.alive && h.mode === 'hunt') engaged++;
  for (let i = 0; i < HUNTERS.length; i++) {
    const h = HUNTERS[i];
    h.vis = false;
    if (!h.alive || h.ps < G.s - 250 || h.ps > G.s + 900) { hunterMesh.setMatrixAt(i, ZERO_M); if (!h.alive) h.wp.set(0, -1e4, 0); continue; }
    const dist = h.wp.distanceTo(shipPos);
    if (h.mode !== 'hunt' && sub && dist < 80 && engaged < 2 && h.ps > G.s - 30) {
      h.mode = 'hunt'; h.cd = 0.9 + Math.random() * 0.6; h.huntT = 0; engaged++;
      audio.sonar(panOf(h.wp));
    }
    if (h.mode === 'hunt' && (!sub || dist > 150 || h.huntT > 14)) { h.mode = 'return'; h.charge = 0; }
    if (h.mode === 'return' && Math.abs(h.ps - h.home) < 20) h.mode = 'patrol';
    const lim = underLim(h.ps) - 1;
    let ts, tl, ty, maxS;
    if (h.mode === 'hunt') {
      h.huntT += dt;
      const side = i % 2 ? 1 : -1;
      ts = G.s + (h.ps > G.s - 4 ? 19 : -12); tl = G.lat + side * 5; ty = G.y + 0.5; maxS = HUNT_SP;
    } else {
      ts = h.home + 24 * Math.sin(time * 0.17 + h.phase); tl = h.lat + Math.sin(time * 0.29 + h.phase) * 0.3 * lim;
      ty = h.y + 0.7 * Math.sin(time * 0.8 + h.phase); maxS = h.mode === 'return' ? 14 : 7;
    }
    const want = clamp((ts - h.ps) * 1.6 + (h.mode === 'hunt' ? G.speed : 0), -maxS * 0.5, maxS);
    h.vs += (want - h.vs) * damp(2.2, dt);
    h.vl += (clamp((tl - h.pl) * 1.5, -12, 12) - h.vl) * damp(3, dt);
    h.vy += (clamp((ty - h.py) * 1.5, -5, 5) - h.vy) * damp(3, dt);
    h.ps += h.vs * dt; h.pl = clamp(h.pl + h.vl * dt, -lim, lim);
    h.py = clamp(h.py + h.vy * dt, bedY(h.ps, h.pl) + 1.4, -1.8);
    toWorld(h.ps, h.pl, h.py, h.wp);
    frame(h.ps, F);
    // orientation: toward the ship while hunting, along its motion otherwise
    if (h.mode === 'hunt') V3.copy(shipPos).sub(h.wp);
    else V3.set(F.tx * h.vs + F.rx * h.vl, h.vy * 0.5, F.tz * h.vs + F.rz * h.vl);
    if (V3.lengthSq() > 0.01) h.fwd.lerp(V3.normalize(), damp(4, dt)).normalize();
    M1.lookAt(V1.set(0, 0, 0), V2.copy(h.fwd).negate(), UP);
    M1.multiply(M2.makeRotationZ(Math.sin(time * 2 + h.phase) * 0.15));
    M1.setPosition(h.wp);
    hunterMesh.setMatrixAt(i, M1);
    h.nose.copy(h.wp).addScaledVector(h.fwd, 1.9);
    h.vis = true;
    // cold cyan lights; a bright pulse while charging a shot
    const ch = h.charge > 0 ? 1 - h.charge / 0.55 : 0;
    glows.add(h.nose.x, h.nose.y, h.nose.z, 0.35, 1.6, 1.8, 1 + ch, 2.1 + ch * 3);
    glows.add(h.wp.x, h.wp.y, h.wp.z, 0.25, 1.1, 1.2, 0.3, 4.5);
    glows.add(h.wp.x - h.fwd.x * 1.9, h.wp.y - h.fwd.y * 1.9, h.wp.z - h.fwd.z * 1.9, 0.3, 1.2, 1.4, 0.55, 1.8);
    if (h.mode === 'hunt' && Math.random() < 0.6) mist.emit(h.wp.x - h.fwd.x * 2.2, h.wp.y, h.wp.z - h.fwd.z * 2.2, 0, 1 + Math.random(), 0, 0.8, 0.25, 0.7, 0.75, 1, 1, 0.6, -4, 2);
    if (h.mode !== 'hunt' || !flying) continue;
    threat(h, h.wp);
    if (!G.hunterHinted) hint('hunter');
    // lunge into the ship = it detonates against the hull
    if (dist < 5.2) {
      G.hunterRams++;
      h.alive = false;
      underwaterBlast(h.wp.clone(), 0.5);
      damage(11, h.wp.clone(), 'hunter');
      G.hitFlash = 0.8;
      continue;
    }
    if (h.charge > 0) {
      h.charge -= dt;
      if (h.charge <= 0) {
        leadTarget(h.nose, V4, HB_SPEED, true);
        V4.x += (Math.random() - 0.5) * 2; V4.y += (Math.random() - 0.5) * 1.2; V4.z += (Math.random() - 0.5) * 2;
        enemyBolt(h.nose, V4, h.ps, HB_SPEED, EB_CYAN, 7, 2.7, 'hunter', true, 0.9);
        G.hunterShots++;
        audio.hunterShot(panOf(h.wp));
        h.cd = 2 + Math.random() * 0.9;
      }
    } else {
      h.cd -= dt;
      if (h.cd <= 0 && dist < 36 && dist > 7 && viewLOS(h.wp, shipPos, h.ps)) { h.charge = 0.55; audio.hunterCharge(panOf(h.wp)); }
    }
  }
  hunterMesh.instanceMatrix.needsUpdate = true;
  // ---- boats
  for (let i = 0; i < BOATS.length; i++) {
    const b = BOATS[i];
    const pt = b.type === 'patrol';
    const mF = pt ? boatM.pF : boatM.sF, mB = pt ? boatM.pB : boatM.sB, oF = pt ? boatM.sF : boatM.pF, oB = pt ? boatM.sB : boatM.pB;
    oF.setMatrixAt(i, ZERO_M); oB.setMatrixAt(i, ZERO_M);
    const gone = !b.alive && b.sinkT > 7;
    if (gone || b.s < G.s - 250 || b.s > G.s + 1300) {
      mF.setMatrixAt(i, ZERO_M); mB.setMatrixAt(i, ZERO_M); boatM.panels.setMatrixAt(i, ZERO_M);
      if (!b.alive) { b.wp.set(0, -1e4, 0); b.deck.set(0, -1e4, 0); }
      continue;
    }
    if (b.alive) {
      // slow back-and-forth run around the home position (turning takes a few seconds)
      const turning = Math.abs((b.dir > 0 ? 0 : Math.PI) - b.head) > 0.3;
      b.s += Math.cos(b.head) * b.speed * dt * (turning ? 0.35 : 1);
      if ((b.s - b.home) * b.dir > 150) b.dir = -b.dir;
      b.head += ((b.dir > 0 ? 0 : Math.PI) - b.head) * damp(0.7, dt);
      b.lat = b.lat0 + Math.sin(time * 0.11 + i * 2) * 2.2 + Math.sin(b.head) * 3;
    } else b.sinkT += dt;
    const bob = Math.sin(time * 1.3 + i) * 0.12;
    pathBasis(b.s, b.M);
    b.M.multiply(M2.makeRotationY(b.head)).multiply(M2.makeRotationX(Math.sin(time * 1.1 + i * 2) * 0.025)).multiply(M2.makeRotationZ(Math.sin(time * 0.9 + i) * 0.04));
    b.M.setPosition(toWorld(b.s, b.lat, bob, V3));
    if (b.alive) {
      mF.setMatrixAt(i, b.M); mB.setMatrixAt(i, b.M);
      boatM.panels.setMatrixAt(i, b.M);
    } else {
      // broken in two: halves separate, tilt up and sink with bubbles
      const k = smoothstep(0, 6.5, b.sinkT), sep = 2.4 * smoothstep(0, 1.6, b.sinkT), tilt = 0.6 * smoothstep(0, 3, b.sinkT), sink = 10 * Math.pow(k, 1.3);
      M1.copy(b.M).multiply(M2.makeTranslation(0, -sink, -sep)).multiply(M2.makeRotationX(tilt));
      mF.setMatrixAt(i, M1);
      M1.copy(b.M).multiply(M2.makeTranslation(0, -sink * 1.15, sep)).multiply(M2.makeRotationX(-tilt * 0.8));
      mB.setMatrixAt(i, M1);
      boatM.panels.setMatrixAt(i, ZERO_M);
      if (Math.random() < dt * 30) mist.emit(b.deck.x + (Math.random() - 0.5) * 8, Math.min(-0.5, -sink * 0.5), b.deck.z + (Math.random() - 0.5) * 8, (Math.random() - 0.5), 3 + Math.random() * 3, (Math.random() - 0.5), 1.5, 0.4, 1.4, 0.8, 1, 1, 0.7, -5, 1);
      if (b.sinkT < 3 && Math.random() < dt * 20) {
        mist.emit(b.deck.x, Math.max(0.5, 2 - sink), b.deck.z, (Math.random() - 0.5) * 2, 4 + Math.random() * 3, (Math.random() - 0.5) * 2, 2.5, 3, 12, 0.18, 0.16, 0.15, 0.55, -1, 0.5);
        if (sink < 2) sparks.emit(b.deck.x + (Math.random() - 0.5) * 4, 1.5, b.deck.z + (Math.random() - 0.5) * 4, 0, 4 + Math.random() * 4, 0, 0.5, 2.5, 1, 2, 0.9, 0.3, 1, -2, 0);
      }
      if (b.sinkT > 3 && Math.random() < dt * 8 && sink < 4) splash(b.deck, 6, 0.4);
      continue;
    }
    toWorld(b.s, b.lat, BOAT_KEEL - 0.1, b.wp);
    toWorld(b.s, b.lat, 2.4, b.deck);
    b.gun.set(0, 1.8, -6.2).applyMatrix4(b.M);
    // lights: patrol = alternating blue strobes + white bow lamp; smuggler = warm orange deck lamps
    const P = V1;
    if (pt) {
      const st = Math.sin(time * 9 + i) > 0.3;
      P.set(0, 4.75, 1.0).applyMatrix4(b.M); glows.add(P.x, P.y, P.z, 0.35, 0.7, 2.6, st ? 1 : 0.15, 2.4);
      P.set(1.5, 3.0, -0.9).applyMatrix4(b.M); glows.add(P.x, P.y, P.z, 0.3, 0.6, 2.4, st ? 0.15 : 0.9, 1.6);
      P.set(-1.5, 3.0, -0.9).applyMatrix4(b.M); glows.add(P.x, P.y, P.z, 0.3, 0.6, 2.4, st ? 0.15 : 0.9, 1.6);
      P.set(0, 1.6, -6.8).applyMatrix4(b.M); glows.add(P.x, P.y, P.z, 1.6, 1.7, 1.9, 0.5, 1.6);
    } else {
      const fl = 0.75 + 0.25 * Math.sin(time * 13 + i * 5) * Math.sin(time * 3.1);
      P.set(1.4, 2.9, 2.2).applyMatrix4(b.M); glows.add(P.x, P.y, P.z, 2.2, 0.9, 0.25, fl, 1.8);
      P.set(-1.4, 2.9, 2.2).applyMatrix4(b.M); glows.add(P.x, P.y, P.z, 2.2, 0.9, 0.25, fl * 0.9, 1.8);
      P.set(0, 2.6, -2.0).applyMatrix4(b.M); glows.add(P.x, P.y, P.z, 2.0, 0.75, 0.2, 0.55, 3);
    }
    // glowing belly weak point (seen from underwater only: the water surface hides it from above)
    if (camUnder) {
      const c = BOAT_PANEL[b.type], pu = 0.6 + 0.4 * Math.sin(time * 5 + i) + (b.flashT > 0 ? 1 : 0);
      for (const z of [-1.4, 0.3, 2.0]) { P.set(0, BOAT_KEEL - 0.15, z).applyMatrix4(b.M); glows.add(P.x, P.y, P.z, c.r * 0.7, c.g * 0.7, c.b * 0.7, pu * 0.6, 2.6); }
    }
    b.flashT -= dt;
    // bow wave / wake
    if (Math.random() < dt * 14 * Math.abs(Math.cos(b.head))) {
      P.set((Math.random() - 0.5) * 4, 0.2, -6.5).applyMatrix4(b.M);
      mist.emit(P.x, 0.3, P.z, (Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 3, 0.9, 0.8, 2.6, 0.88, 0.95, 0.95, 0.55, 8, 0.6);
    }
    if (flying) shipHitsBoat(b);
    // Council patrol boats fire on a surfaced ship in range: telegraph (white/blue strobe on the gun) -> 3 dodgeable bolts
    if (!pt || G.phase !== 'flight') continue;
    const dS = b.gun.distanceTo(shipPos);
    if (b.fire === 'idle') {
      b.cd -= dt;
      if (b.cd <= 0 && !G.underwater && dS < 170 && dS > 12 && viewLOS(b.gun, shipPos, b.s)) { b.fire = 'tele'; b.ft = 0.7; audio.boatAlarm(panOf(b.gun)); }
    } else {
      threat(b, b.deck);
      glows.add(b.gun.x, b.gun.y, b.gun.z, 1.2, 1.6, 2.6, 0.6 + 0.4 * Math.sin(time * 40), b.fire === 'tele' ? 3.5 : 2.5);
      b.ft -= dt;
      if (G.underwater) { b.fire = 'idle'; b.cd = 1.5; }
      else if (b.ft <= 0) {
        if (b.fire === 'tele') { b.fire = 'burst'; b.shots = 0; }
        leadTarget(b.gun, V4, PB_SPEED);
        V4.x += (Math.random() - 0.5) * 5; V4.y += (Math.random() - 0.5) * 3; V4.z += (Math.random() - 0.5) * 5;
        enemyBolt(b.gun, V4, b.s, PB_SPEED, EB_BLUE, 7, 3.4, 'boat');
        G.boatShots++;
        sparks.emit(b.gun.x, b.gun.y, b.gun.z, 0, 0, 0, 0.1, 4, 2, 1.2, 1.6, 2.6, 1);
        audio.turretShot(panOf(b.gun) * 0.8);
        b.ft = 0.2;
        if (++b.shots >= 3) { b.fire = 'idle'; b.cd = 3.2 + Math.random() * 1.6; }
      }
    }
  }
  for (const k of ['pF', 'pB', 'sF', 'sB', 'panels']) boatM[k].instanceMatrix.needsUpdate = true;
  updateSpouts(dt);
  // first-encounter hints
  if (G.phase === 'flight') {
    if (!G.mineHinted) for (const m of MINES) if (m.alive && m.s > G.s && m.s - G.s < 170) { hint('mine'); break; }
    if (!G.hunterHinted) for (const h of HUNTERS) if (h.alive && h.ps > G.s && h.ps - G.s < 160) { hint('hunter'); break; }
    if (!G.boatHinted) for (const b of BOATS) if (b.alive && b.s > G.s - 20 && b.s - G.s < 230) { hint('boat'); break; }
  }
}
function hint(kind) {
  if (kind === 'mine' && !G.mineHinted) { G.mineHinted = true; toast('<b>Mines below — shoot them or steer clear.</b><br><i>Мины под водой — сбей или обойди.</i>', 5); }
  if (kind === 'hunter' && !G.hunterHinted) { G.hunterHinted = true; toast('<b>Hunters live underwater — shoot them while diving.</b><br><i>Охотники только под водой — стреляй в нырке.</i>', 5); }
  if (kind === 'boat' && !G.boatHinted) { G.boatHinted = true; toast('<b>Boats are armored on top — dive and hit the glowing belly.</b><br><i>Катера бронированы сверху — ныряй и бей в днище.</i>', 5.5); }
}

// ------------------------------------------------------------------ off-screen threat indicator
// Anything that locks / fires / attacks registers here; an edge chevron points to it while it is off-screen or hidden
// (around a bend, or across the water surface), fading 1.5 s after the threat ends.
const threats = new Map();
let simTime = 0;
function threat(obj, p) {
  const e = threats.get(obj);
  if (e) { e.last = simTime; e.p = p; } else threats.set(obj, { p, last: simTime });
}
const THR_N = 6, thrEls = [];
for (let i = 0; i < THR_N; i++) { const el = document.createElement('div'); el.className = 'thr'; $('threats').appendChild(el); thrEls.push(el); }
const THR_V = new THREE.Vector3();
let thrShown = 0;
function updateThreats() {
  let n = 0;
  const on = G.phase === 'flight' || G.phase === 'landing';
  for (const [obj, e] of threats) {
    const age = simTime - e.last;
    if (age > 1.5 || !on || obj.alive === false) { threats.delete(obj); continue; }
    if (n >= THR_N) continue;
    THR_V.copy(e.p).applyMatrix4(camera.matrixWorldInverse);
    const behind = THR_V.z > -0.5;
    let x = THR_V.x, y = THR_V.y;
    if (!behind) {
      reticleV.copy(e.p).project(camera);
      const across = (e.p.y < 0) !== camUnder;   // the water surface hides it
      if (Math.abs(reticleV.x) < 0.94 && Math.abs(reticleV.y) < 0.9 && !across && viewLOS(camera.position, e.p, G.s - 20)) continue;
      x = reticleV.x * innerWidth; y = reticleV.y * innerHeight;
    }
    if (Math.abs(x) + Math.abs(y) < 1e-3) { x = 0; y = -1; }
    const a = Math.atan2(y, x), ca = Math.cos(a), sa = Math.sin(a);
    const hw = innerWidth / 2 - 40, hh = innerHeight / 2 - 40;
    const k = Math.min(hw / Math.max(1e-3, Math.abs(ca)), hh / Math.max(1e-3, Math.abs(sa)));
    const el = thrEls[n++];
    el.style.display = 'block';
    el.style.opacity = (age < 0.1 ? 1 : 1 - (age - 0.1) / 1.4).toFixed(2);
    el.style.transform = `translate(${(innerWidth / 2 + ca * k).toFixed(1)}px,${(innerHeight / 2 - sa * k).toFixed(1)}px) rotate(${(-a).toFixed(3)}rad)`;
  }
  thrShown = n;
  for (let i = n; i < THR_N; i++) if (thrEls[i].style.display !== 'none') thrEls[i].style.display = 'none';
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
    // blinking red top light + a faint upward data shimmer (rising red motes; fewer on low quality)
    const on = Math.sin(time * 5 + b.phase) > 0.2 ? 1 : 0.12;
    const tp = b.top;
    glows.add(tp.x, tp.y + 0.1, tp.z, 2.2, 0.22, 0.1, on, 4.5);
    glows.add(tp.x, tp.y + 0.1, tp.z, 1.4, 0.12, 0.06, on * 0.25, 12);
    if (b.s - G.s > 500) continue;
    const nm = quality === 'low' ? 2 : 4;
    for (let k = 0; k < nm; k++) {
      const u = (time * 0.45 + b.phase + k / nm) % 1;
      const fl = (1 - u) * u * 4 * (0.6 + 0.4 * Math.sin(time * 11 + k * 2 + b.phase));
      glows.add(tp.x + Math.sin(k * 2.3 + time) * 0.25, tp.y + 0.6 + u * 9, tp.z + Math.cos(k * 1.7 + time) * 0.25, 1.6, 0.35, 0.12, 0.32 * fl, 1.6 + u * 1.2);
    }
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
  updateBurn(dt);
}

// round 6: engines burn cargo water as backup reaction mass (boost, thin air); hydrojet underwater burns none
function updateBurn(dt) {
  const z = zoneAt(G.s);
  const air = G.phase === 'flight' && !G.underwater;
  G.thinAir = air && !!(z && !z.shielded);
  let rate = 0;
  if (air) {
    const boost = G.boost > 0.05 && !G.dive ? BURN_BOOST * G.boost : 0;
    rate = (G.thinAir ? BURN_THIN + boost * BURN_THIN_BOOST : boost) * SHIP_BURN_MUL;
  }
  const d = Math.min(rate * dt, Math.max(0, G.cargo - BURN_FLOOR));
  G.burnRate = d > 0 ? rate : 0;
  if (d > 0) { G.cargo -= d; G.waterBurned += d; }
  // exhaust steam amount (0..1): full in thin air, follows boost otherwise
  const st = G.burnRate > 0 ? (G.thinAir ? Math.max(0.75, G.boost) : clamp(G.boost * 1.1, 0, 1)) : 0;
  G.steam += (st - G.steam) * damp(4, dt);
  if (G.burnRate > 0 && G.boost > 0.05 && !G.burnHinted) {
    G.burnHinted = true;
    toast('<b>Boost burns cargo water as reaction mass.</b><br><i>Форсаж тратит воду из цистерны как рабочее тело.</i>', 5);
  }
  if (G.thinAir && !G.thinHinted) {
    G.thinHinted = true;
    toast('<b>Thin air over a downed mast — ship sinks, engines draw water.</b><br><i>Над сбитой мачтой воздух жидкий: корабль проседает, двигатели пьют воду.</i>', 5.5);
  }
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
  ship.animate(dt, G.dive || G.underwater, G.boost, time, running ? 1 : 0.25, G.steam);
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
      // round 6: burning cargo water — soft white steam puffs trailing the nozzles
      if (G.steam > 0.08 && Math.random() < G.steam * 0.8) {
        const j = () => (Math.random() - 0.5) * 0.8;
        mist.emit(nozW.x + j(), nozW.y + j() - 0.2, nozW.z + j(), shipVel.x * 0.84 - shipFwd.x * 6 + j() * 3, shipVel.y * 0.8 + 0.6 + Math.random(), shipVel.z * 0.84 - shipFwd.z * 6 + j() * 3,
          0.8 + Math.random() * 0.6, 1.1, 4.6 + Math.random() * 2, 0.93, 0.97, 1, 0.3 + 0.25 * G.steam, -0.6, 0.6);
      }
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
  // round 4: underwater the camera drops ~3 m *below* the ship (looking up a little), so the ship no longer hides
  // mines / hunters at its own depth, and boat bellies + the Snell window show overhead (camera framing only)
  const hgt = under ? -3.2 : (start ? 9 : 10.6 + wide * 0.6 + G.boost * 0.8);
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
  if (G.y < -0.6) camPos.y = clamp(camPos.y, bedY(cs, lat) + 1.2, -1.1);
  else if (G.y > 0.3) camPos.y = Math.max(camPos.y, 1.0 + Math.max(0, bankY(cs, lat)));
  camera.position.copy(camPos);
  // shake
  G.shake = Math.max(0, G.shake - dt * 1.8);
  G.micro = Math.max(0, G.micro - dt * 0.9);
  const sh = G.shake * G.shake * 0.9 + G.micro + (G.phase === 'flight' ? G.speed / 95 * 0.04 + G.boost * 0.07 : 0);
  camera.position.x += (Math.random() - 0.5) * sh;
  camera.position.y += (Math.random() - 0.5) * sh;
  camera.position.z += (Math.random() - 0.5) * sh;
  if (G.y < -0.6) camera.position.y = Math.min(camera.position.y, -0.4);   // shake never pops the camera out of the water
  camLook.copy(shipPos).addScaledVector(shipFwd, 40);
  camLook.y = shipPos.y + (under ? 0.8 : 3.1);
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

// ------------------------------------------------------------------ targeting HUD: reticle, markers, mast tags
let hudT = 0, legendMode = 'auto';
const RET = { x: 0, y: 0, init: false, lock: false };
const MUZ = new THREE.Vector3(), RAY = new THREE.Vector3();
function toScreen(v, out) {
  reticleV.copy(v).project(camera);
  out.x = (reticleV.x * 0.5 + 0.5) * innerWidth; out.y = (-reticleV.y * 0.5 + 0.5) * innerHeight; out.z = reticleV.z;
  out.on = reticleV.z < 1 && Math.abs(reticleV.x) < 1.02 && Math.abs(reticleV.y) < 1.02;
  return out;
}
// where a bolt fired now actually goes: the assisted target, else the first wall / water / rock / arch hit along
// the bolt line (from between the muzzles), else the end of the bolt's range
function boltAimPoint(out) {
  ship.body.updateMatrixWorld();
  ship.body.localToWorld(MUZ.copy(ship.muzzles[0]).add(ship.muzzles[1]).multiplyScalar(0.5));
  const at = aimTarget(MUZ);
  if (at) { out.copy(at.wp); return at; }
  if (G.underwater) {
    let s = G.s;
    for (let d = 8; d <= UW_RANGE; d += 6) {
      RAY.copy(MUZ).addScaledVector(shipFwd, d);
      const pr = projectToPath(RAY.x, RAY.z, s); s = pr.s;
      if (RAY.y > -0.2 || RAY.y < bedY(s, pr.lat) || Math.abs(pr.lat) > riverHalf(s) * 0.97) { out.copy(MUZ).addScaledVector(shipFwd, Math.max(12, d - 3)); return null; }
    }
    out.copy(MUZ).addScaledVector(shipFwd, UW_RANGE);
    return null;
  }
  const range = BOLT_SPEED * BOLT_LIFE;
  let s = G.s;
  for (let d = 20; d <= range; d += 12) {
    RAY.copy(MUZ).addScaledVector(shipFwd, d);
    const pr = projectToPath(RAY.x, RAY.z, s); s = pr.s;
    const side = pr.lat > 0 ? 1 : -1;
    let hit = RAY.y < 0 || side * pr.lat > wallLat(s, RAY.y, side);
    if (!hit) for (const r of ROCKS) if (Math.abs(r.s - s) < r.r + 2 && RAY.y < r.h && Math.abs(r.lat - pr.lat) < r.r) { hit = true; break; }
    if (!hit) for (const a of ARCHES) if (Math.abs(a.s - s) < a.ht && RAY.y > archBottom(a, pr.lat) && RAY.y < archTop(a, pr.lat)) { hit = true; break; }
    if (hit) { out.copy(MUZ).addScaledVector(shipFwd, Math.max(30, d - 6)); return null; }
  }
  out.copy(MUZ).addScaledVector(shipFwd, Math.min(range, 170));
  return null;
}
const AIMP = new THREE.Vector3(), SCR = { x: 0, y: 0, z: 0, on: false }, SCR2 = { x: 0, y: 0, z: 0, on: false };
let aimObj = null;
function updateReticle(rdt) {
  const vis = G.phase === 'flight';
  if (G.underwater !== RET.uw) { RET.uw = G.underwater; hud.reticle.classList.toggle('uw', RET.uw); }
  aimObj = null;
  if (vis) {
    const at = boltAimPoint(AIMP);
    aimObj = at ? at.obj : null;
    toScreen(AIMP, SCR);
  }
  const show = vis && SCR.z < 1;
  hud.reticle.style.display = show ? 'block' : 'none';
  if (!show) { RET.init = false; return; }
  // snaps quickly onto an assisted target, glides otherwise (no jitter from the wall ray)
  const k = !RET.init ? 1 : damp(aimObj ? 22 : 14, rdt);
  RET.x += (SCR.x - RET.x) * k; RET.y += (SCR.y - RET.y) * k; RET.init = true;
  hud.reticle.style.transform = `translate(${RET.x}px,${RET.y}px)`;
  hud.hitx.style.transform = `translate(${RET.x}px,${RET.y}px)`;
  if (!!aimObj !== RET.lock) { RET.lock = !!aimObj; hud.reticle.classList.toggle('lock', RET.lock); }
}
// line of sight camera -> point against the analytic canyon walls and arches
function viewLOS(a, b, s0) {
  for (let k = 1; k < 6; k++) {
    LOS_P.lerpVectors(a, b, k / 6);
    const pr = projectToPath(LOS_P.x, LOS_P.z, s0);
    s0 = pr.s;
    const side = pr.lat > 0 ? 1 : -1;
    if (side * pr.lat > wallLat(pr.s, LOS_P.y, side) + 0.5) return false;
    for (const ar of ARCHES) if (Math.abs(ar.s - pr.s) < ar.ht && LOS_P.y > archBottom(ar, pr.lat) && LOS_P.y < archTop(ar, pr.lat)) return false;
    for (const r of ROCKS) if (Math.abs(r.s - pr.s) < r.r && LOS_P.y < r.h && Math.abs(r.lat - pr.lat) < r.r) return false;
  }
  return true;
}
const TGT_N = 10, TGT_RANGE = 260, TGT_RANGE_UW = 95;
const TGT_LABEL = { turret: 'TURRET / ТУРЕЛЬ', drone: 'DRONE / ДРОН', beacon: 'RELAY / РЕТРАНСЛЯТОР', mine: 'MINE / МИНА', hunter: 'HUNTER / ОХОТНИК',
  boat: 'BOAT / КАТЕР · ARMORED', weak: 'WEAK POINT / УЯЗВИМОЕ МЕСТО' };
const TGT_R = { turret: 2.6, drone: 2.4, beacon: 2.2, mine: 1.8, hunter: 1.6, boat: 5, weak: 2.2 };
const tgtEls = [], mtagEls = [];
for (let i = 0; i < TGT_N; i++) {
  const el = document.createElement('div'); el.className = 'tgt'; el.innerHTML = '<span></span>';
  $('tgts').appendChild(el); tgtEls.push({ el, span: el.firstChild, label: '', aim: false, kind: '' });
}
for (let i = 0; i < 2; i++) {
  const el = document.createElement('div'); el.className = 'mtag'; el.innerHTML = '<span>DO NOT HIT / НЕ СТРЕЛЯТЬ</span>';
  $('tgts').appendChild(el); mtagEls.push(el);
}
const tgtCand = [];
function updateMarkers(rdt) {
  let n = 0, nm = 0;
  if (G.phase === 'flight') {
    tgtCand.length = 0;
    const cp = camera.position;
    const range = camUnder ? TGT_RANGE_UW : TGT_RANGE;
    const add = (o, kind, p = o.wp, s = o.s) => {
      if (Math.abs(s - G.s) > range + 30) return;
      const d = p.distanceTo(shipPos);
      if (d > range || p.distanceTo(cp) < 8) return;
      tgtCand.push({ o, kind, d, p });
    };
    if (camUnder) {
      // underwater: mines, hunters and the boats' glowing belly (weak point)
      for (const m of MINES) if (m.alive) add(m, 'mine');
      for (const h of HUNTERS) if (h.alive && h.vis) add(h, 'hunter', h.wp, h.ps);
      for (const b of BOATS) if (b.alive) add(b, 'weak');
    } else {
      for (const d of DRONES) if (d.alive && !d.spotting) add(d, 'drone');   // spotting drones carry the red LETHE bracket
      for (const b of BEACONS) if (b.alive) add(b, 'beacon');
      for (const t of TURRETS) if (t.alive) add(t, 'turret');
      for (const b of BOATS) if (b.alive) add(b, 'boat', b.deck);
      for (const m of MINES) if (m.alive && m.y > -2.6 && m.s > G.s && m.s - G.s < 80) add(m, 'mine');   // shallow ones, close
    }
    tgtCand.sort((a, b) => a.d - b.d);
    const fy = Math.tan((camera.fov * Math.PI) / 360);
    for (const c of tgtCand) {
      if (n >= TGT_N) break;
      toScreen(c.p, SCR2);
      if (!SCR2.on) continue;
      // line of sight (mines just under the surface are glimpsed through it from above)
      if (!(c.kind === 'mine' && !camUnder) && !viewLOS(cp, c.p, G.s - 20)) continue;
      const dc = c.p.distanceTo(cp);
      const size = clamp((TGT_R[c.kind] * 2.2 * innerHeight) / (2 * dc * fy), 18, c.kind === 'boat' ? 90 : 54);
      const m = tgtEls[n++];
      // first sighting of each type gets a label for a few seconds; a boat's weak point is always labelled
      const seen = G.seen[c.kind];
      if (!seen) {
        G.seen[c.kind] = { o: c.o, t: 4.5 };
        if (c.kind === 'turret' && !G.turretHinted) {
          G.turretHinted = true;
          toast('<b>Turrets on the rims fire when a drone marks you.</b> Shoot them or the drone.<br><i>Турели стреляют по метке дрона — сбей их или дрон.</i>', 6);
        }
        if (c.kind === 'beacon' && !G.relayHinted) {
          G.relayHinted = true;
          toast('<b>Relays pass drone marks to turrets.</b> Shoot the relay first — the section goes blind.<br><i>Ретрансляторы передают метку турелям. Сбей ретранслятор — сектор ослепнет.</i>', 6);
        }
      }
      const label = c.kind === 'weak' || (seen && seen.o === c.o && seen.t > 0) ? TGT_LABEL[c.kind] : '';
      if (label !== m.label) { m.label = label; m.span.textContent = label; }
      const aim = c.o === aimObj;
      if (aim !== m.aim) { m.aim = aim; m.el.classList.toggle('aim', aim); }
      if (c.kind !== m.kind) {
        m.el.classList.toggle('weak', c.kind === 'weak');
        m.el.classList.toggle('uwk', c.kind === 'mine' || c.kind === 'hunter');
        m.el.classList.toggle('boat', c.kind === 'boat');
        m.kind = c.kind;
      }
      m.el.style.display = 'block';
      m.el.style.width = m.el.style.height = size.toFixed(0) + 'px';
      m.el.style.transform = `translate(${(SCR2.x - size / 2).toFixed(1)}px,${(SCR2.y - size / 2).toFixed(1)}px)`;
    }
    for (const k in G.seen) G.seen[k].t -= rdt;
    // masts: a cyan DO NOT HIT tag the first time each one comes near
    if (!camUnder) for (const m of MASTS) {
      if (!m.alive || m.tagT === 0 || nm >= mtagEls.length) continue;
      const d = m.pts[1].distanceTo(shipPos);
      if (m.tagT === undefined) {
        if (d > 210 || m.s < G.s) continue;
        toScreen(m.pts[1], SCR2);
        if (!SCR2.on || !viewLOS(cp, m.pts[1], G.s - 20)) continue;
        m.tagT = 4;
      }
      m.tagT = Math.max(0, m.tagT - rdt);
      toScreen(m.pts[1], SCR2);
      if (m.tagT > 0 && SCR2.on) {
        const el = mtagEls[nm++];
        el.style.display = 'block';
        el.style.transform = `translate(${SCR2.x.toFixed(1)}px,${SCR2.y.toFixed(1)}px)`;
      }
    }
  }
  for (let i = n; i < TGT_N; i++) if (tgtEls[i].el.style.display !== 'none') tgtEls[i].el.style.display = 'none';
  for (let i = nm; i < mtagEls.length; i++) if (mtagEls[i].style.display !== 'none') mtagEls[i].style.display = 'none';
}

// ------------------------------------------------------------------ HUD
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
  // round 6: water-burn tag under the cargo gauge (steam-white, not an alarm) + shimmer on the bar
  const burning = G.burnRate > 0, thinTag = burning && G.thinAir;
  if (burning !== hud.rowCargo.classList.contains('burn')) hud.rowCargo.classList.toggle('burn', burning);
  if (burning && thinTag !== hud.burnTag.classList.contains('thin')) {
    hud.burnTag.classList.toggle('thin', thinTag);
    hud.burnTag.innerHTML = thinTag ? 'THIN AIR · WATER BURN<i>РАЗРЕЖЕННЫЙ ВОЗДУХ · РАСХОД ВОДЫ</i>' : 'WATER BURN<i>РАСХОД ВОДЫ</i>';
  }
  hud.rowShield.classList.toggle('down', G.shield <= 0);
  const locked = G.lock.phase === 'laser' || G.lock.phase === 'volley';
  // in a blind section (its relays are down) the mark has nowhere to go: the bar reads NO RELAY
  const noRelay = G.noRelay && !locked;
  hud.markBox.style.opacity = G.mark > 0.01 || G.lock.phase === 'laser' || (noRelay && G.spotters > 0) ? 1 : 0;
  hud.markBox.classList.toggle('lock', !noRelay && (G.mark >= 1 || locked));
  if (noRelay !== hud.markBox.classList.contains('norelay')) {
    hud.markBox.classList.toggle('norelay', noRelay);
    hud.markLbl.innerHTML = noRelay ? 'NO RELAY <i>/ НЕТ СВЯЗИ</i>' : 'MARK <i>/ МЕТКА</i>';
  }
  hud.tintLock.style.opacity = locked ? 0.6 + 0.4 * Math.sin(time * 20) : G.mark * (noRelay ? 0.08 : 0.35);
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
  if (G.toastT > 0) {
    G.toastT -= rdt;
    if (G.toastT <= 0) { hud.toast.classList.remove('on'); G.toastT = -0.5; }   // short gap before a queued one
  } else if (G.toastT < 0) {
    G.toastT = Math.min(0, G.toastT + rdt);
    if (G.toastT === 0 && G.toastQ.length) { const [h, d] = G.toastQ.shift(); toast(h, d); }
  }
  if (G.popT > 0) {
    G.popT -= rdt;
    hud.pop.style.transform = `translate(-50%,${-50 - (0.9 - G.popT) * 40}%)`;
    if (G.popT <= 0) hud.pop.style.opacity = 0;
  }
  camera.updateMatrixWorld();
  updateReticle(rdt);
  updateMarkers(rdt);
  updateThreats();
  // desktop key legend: first ~20 s of flight, then fades; H toggles
  if (G.phase === 'flight' && G.legendT > 0 && legendMode === 'auto') G.legendT -= rdt;
  const legendOn = document.body.classList.contains('playing') && (legendMode === 'on' || (legendMode === 'auto' && G.legendT > 0));
  hud.keys.classList.toggle('on', legendOn);
  hudT -= dt;
  if (hudT > 0) return;
  hudT = 0.1;
  hud.cargo.textContent = G.burnRate > 0 ? G.cargo.toFixed(1) + '%' : Math.ceil(G.cargo) + '%';
  hud.shield.textContent = G.shield > 0 ? Math.ceil(G.shield) + '%' : 'DOWN';
  hud.health.textContent = Math.ceil(Math.max(0, G.health)) + '%';
  hud.rad.textContent = G.rad > 0.05 ? (G.rad * 4.2).toFixed(1) + ' Sv/h' : 'SHIELDED';
  hud.rad.style.color = G.rad > 0.05 ? '#ff6a4a' : '#9ff';
  hud.mark.textContent = locked ? 'LOCK' : G.noRelay ? '—' : Math.round(G.mark * 100) + '%';
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
  const litres = (pct) => Math.round(pct / 100 * TANK_L / 10) * 10;
  const fmtL = (l) => String(l).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009') + '\u00a0л';
  const deliv = ok ? G.cargo : 0;
  $('rWater').textContent = `${fmtL(litres(deliv))} (${Math.round(deliv)}%)`;
  $('rBurned').textContent = `${fmtL(litres(G.waterBurned))} (${G.waterBurned.toFixed(1)}%)`;
  $('rHealth').textContent = Math.round(Math.max(0, G.health)) + '%';
  $('rTargets').textContent = `${G.kills} / ${N_DRONE_REAL + BEACONS.length + TURRETS.length}`;
  $('rMasts').textContent = `${G.mastsBroken}`;
  $('rRelays').textContent = `${G.relayKills} / ${BEACONS.length}`;
  $('rMines').textContent = `${G.mineKills} / ${N_MINE_REAL}`;
  $('rHunters').textContent = `${G.hunterKills} / ${N_HUNTER_REAL}`;
  $('rBoats').textContent = `${G.boatKills} / ${N_BOAT_REAL}`;
  $('rHits').textContent = `${G.turretHits} / ${G.turretShotsFired}`;
  $('rScore').textContent = G.finalScore + (ok ? ` (+${timeBonus})` : '');
  $('result').classList.remove('hide');
  document.body.classList.remove('playing');
  input.active = false;
}

function reset() {
  resetLevel();
  for (let i = N_DRONE_REAL; i < DRONES.length; i++) DRONES[i].alive = false;
  for (let i = N_MINE_REAL; i < MINES.length; i++) MINES[i].alive = false;
  for (let i = N_HUNTER_REAL; i < HUNTERS.length; i++) HUNTERS[i].alive = false;
  for (let i = N_BOAT_REAL; i < BOATS.length; i++) BOATS[i].alive = false;
  threats.clear();
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
  for (const m of MASTS) delete m.tagT;
}

function startGame() {
  if (G.phase !== 'start') return;
  if (!navigator.userActivation || navigator.userActivation.isActive) audio.init();
  $('start').classList.add('hide');
  $('result').classList.add('hide');
  document.body.classList.add('playing');
  input.active = true;
  // keyboard focus: drop it from the clicked button (a focused hidden button would eat Space/Enter) onto the canvas
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  try { renderer.domElement.focus({ preventScroll: true }); window.focus(); } catch (e) { /* ignore */ }
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
// ---- engine sound presets: start-screen segmented control (with audition), HUD gear button, V key
const engSeg = document.querySelector('#engSel .seg');
for (const e of ENGINES) {
  const b = document.createElement('button');
  b.type = 'button'; b.dataset.e = e.id; b.innerHTML = `${e.en}<small>${e.ru}</small>`;
  b.addEventListener('click', (ev) => { ev.stopPropagation(); audio.init(); setEngine(e.id); audio.preview(); b.blur(); });
  b.addEventListener('keydown', (ev) => ev.stopPropagation());
  engSeg.appendChild(b);
}
function syncEngine() {
  for (const b of engSeg.children) b.classList.toggle('on', b.dataset.e === audio.engine);
  const info = audio.engineInfo();
  hud.engBtn.title = `Engine sound (V): ${info.en} / ${info.ru}`;
}
function setEngine(name, announce = false) {
  audio.setEngine(name);
  syncEngine();
  if (announce) {
    const info = audio.engineInfo();
    toast(`ENGINE SOUND · <b>${info.en}</b> <i>/ ${info.ru}</i>`, 1.6, true);
  }
}
function cycleEngine() {
  audio.init();
  setEngine(ENGINES[(ENGINES.findIndex((e) => e.id === audio.engine) + 1) % ENGINES.length].id, G.phase !== 'start');
  if (G.phase === 'start' || G.phase === 'result') audio.preview();
}
syncEngine();
hud.engBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); cycleEngine(); });
// leaving mid-flight (e.g. Ctrl+W while Ctrl is the dive key) asks first
addEventListener('beforeunload', (e) => {
  if (G.phase === 'flight' || G.phase === 'takeoff' || G.phase === 'landing') { e.preventDefault(); e.returnValue = ''; }
});
addEventListener('keydown', (e) => {
  if (e.altKey || e.metaKey) return;
  if (e.code === 'KeyV' && !e.repeat) cycleEngine();
  if (e.code === 'KeyH' && !e.repeat && G.phase !== 'start') {
    const visible = legendMode === 'on' || (legendMode === 'auto' && G.legendT > 0);
    legendMode = visible ? 'off' : 'on';
  }
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
let pxScale = 600;
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
  simTime = time;
  G.armorT -= realDt;
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
    // underwater: shoot whatever the assist locks (mines, hunters, boat bellies)
    if (G.underwater && aimObj) autoFire = true;
    input.fire = autoFire;
  }
  if (G.phase === 'flight' && input.fire && G.fireCd <= 0) fire();
  if (input.consumeRocket() && G.phase === 'flight') { if (G.underwater) audio.empty(); else fireRocket(); }
  updateBolts(dt);
  updateRockets(dt);
  updateTargets(dt, time);
  updateLethe(dt, time);
  updateNaval(dt, time);
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
  pxScale = ps;
  glows.mat.uniforms.uScale.value = ps; sparks.out.mat.uniforms.uScale.value = ps; mist.out.mat.uniforms.uScale.value = ps; motes.mat.uniforms.uScale.value = ps;

  updateHUD(dt, time);
  updateAudioScene();
  audio.update(G.speed * (1 - G.dip), G.boost, camUnder, G.skim || 0, G.phase !== 'start' && G.phase !== 'result', G.prox || 0, G.y);
  audio.steam(G.phase === 'flight' && !camUnder ? G.steam : 0);
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
    dive: G.dive, radiation: +G.rad.toFixed(3),
    waterBurned: +G.waterBurned.toFixed(3), waterSpilled: +G.waterSpilled.toFixed(2), burnRate: +G.burnRate.toFixed(3), thinAir: G.thinAir, steam: +G.steam.toFixed(2),
    burnTag: hud.rowCargo.classList.contains('burn'), mastsBroken: G.mastsBroken, kills: G.kills,
    rockets: G.rockets, rocketsFired: G.rocketsFired, recoilDip: +G.dip.toFixed(3), muted: audio.muted, volume: audio.vol, engineSound: audio.engine,
    aim: aimObj ? (TURRETS.includes(aimObj) ? 'turret' : DRONES.includes(aimObj) ? 'drone' : MINES.includes(aimObj) ? 'mine' : HUNTERS.includes(aimObj) ? 'hunter'
      : BOATS.includes(aimObj) ? 'boat' : 'relay') : null, turretKills: G.turretKills,
    relaysAlive: BEACONS.filter((b) => b.alive).length, relaysDown: BEACONS.filter((b) => !b.alive).length, relayKills: G.relayKills,
    noRelay: G.noRelay, zone: zoneAt(G.s)?.idx ?? -1, sectorLinked: zoneLinked(zoneAt(G.s)), lockRelay: G.lock.phase !== 'none' ? !!G.lock.relay : null,
    lockTurret: G.lock.turret ? TURRETS.indexOf(G.lock.turret) : -1, lockLog: G.lockLog.slice(-8), dataBeam: G.beamSegs, beamTurret: G.beamTurret,
    blindTurrets: TURRETS.filter((t) => t.alive && t.blind).length,
    mines: { alive: MINES.filter((m) => m.alive).length, killed: G.mineKills, hit: G.mineHits },
    hunters: { alive: HUNTERS.filter((h) => h.alive).length, killed: G.hunterKills, rams: G.hunterRams, shots: G.hunterShots, hunting: HUNTERS.filter((h) => h.alive && h.mode === 'hunt').length,
      visible: HUNTERS.filter((h) => h.alive && h.vis && h.wp.distanceTo(shipPos) < 120).length },
    boats: { alive: BOATS.filter((b) => b.alive).length, killed: G.boatKills, shots: G.boatShots, ricochets: G.ricochets },
    navalHits: G.navalHits, threats: thrShown, markerKinds: tgtEls.filter((m) => m.el.style.display === 'block').map((m) => m.kind),
    markers: tgtEls.filter((m) => m.el.style.display === 'block').length, legend: hud.keys.classList.contains('on'),
    shield: +G.shield.toFixed(1), mark: +G.mark.toFixed(3), spotters: G.spotters, lock: G.lock.phase,
    turretShotsFired: G.turretShotsFired, ebLog: G.ebLog.slice(-6), rkLog: G.rkLog.slice(-4), turretHits: G.turretHits, quality, fps: Math.round(fps),
    camDist: +camera.position.distanceTo(shipPos).toFixed(2), shipFrac: shipFrac(), camWallGap: camGap(), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
  }),
  start: startGame,
  retry: () => { reset(); startGame(); },
  warp: (s) => { G.s = s; camInit = false; },
  input,
  debug: {
    breakMast: (i) => breakMast(MASTS[i]),
    setCargo: (v) => { G.cargo = clamp(v, 0, 100); disp.cargo = disp.gc = G.cargo; },
    zones: () => ZONES.map((z) => ({ i: z.idx, s0: +z.s0.toFixed(0), s1: +z.s1.toFixed(0), shielded: z.shielded, mast: MASTS.findIndex((m) => m.zone === z) })),
    masts: () => MASTS.map((m) => ({ s: m.s, alive: m.alive })),
    spawnDrone: (ahead = 110, lat = 0, y = 18) => {
      const d = DRONES.find((x) => x.debug && !x.alive) || DRONES[DRONES.length - 1];
      Object.assign(d, { s: G.s + ahead, lat, y, amp: 3, alive: true });
      return DRONES.indexOf(d);
    },
    forceMark: (v = 1) => { G.mark = v; },
    // round 5 relays: list (with the turrets each one links) and kill one (as if shot: score, toasts)
    relays: () => BEACONS.map((b, i) => ({ i, s: +b.s.toFixed(0), zone: b.zone.idx, alive: b.alive, side: b.side,
      turrets: TURRETS.map((t, k) => (t.zone === b.zone ? k : -1)).filter((k) => k >= 0) })),
    killRelay: (i) => { const b = BEACONS[i]; if (b && b.alive) killTarget('beacon', b); return b ? zoneLinked(b.zone) : null; },
    turretBlind: () => TURRETS.map((t) => t.blind),
    // round 4 naval helpers: spawn a target `ahead` metres in front of the ship (debug slots)
    spawnMine: (ahead = 60, lat = null, y = -2.4) => {
      const m = MINES.find((x) => x.debug && !x.alive) || MINES[MINES.length - 1];
      Object.assign(m, { s: G.s + ahead, lat: lat === null ? G.lat : lat, y, alive: true, fuse: 0, cause: null });
      m.bed = bedY(m.s, m.lat); toWorld(m.s, m.lat, m.bed, m.anchor);
      return MINES.indexOf(m);
    },
    spawnHunter: (ahead = 60, lat = null, y = -3) => {
      const h = HUNTERS.find((x) => x.debug && !x.alive) || HUNTERS[HUNTERS.length - 1];
      Object.assign(h, { s: G.s + ahead, home: G.s + ahead, lat: lat === null ? G.lat : lat, y, alive: true });
      Object.assign(h, { ps: h.s, pl: h.lat, py: y, vs: 0, vl: 0, vy: 0, mode: 'patrol', cd: 0, charge: 0, huntT: 0 });
      toWorld(h.ps, h.pl, h.py, h.wp);
      return HUNTERS.indexOf(h);
    },
    spawnBoat: (ahead = 80, lat = null, type = 'patrol', speed = 0) => {
      const b = BOATS.find((x) => x.debug && !x.alive) || BOATS[BOATS.length - 1];
      const l = lat === null ? G.lat : lat;
      Object.assign(b, { s: G.s + ahead, home: G.s + ahead, lat: l, lat0: l, type, dir: 1, dir0: 1, speed, alive: true, hp: BOAT_HP, head: 0, sinkT: 0, cd: 1, fire: 'idle' });
      toWorld(b.s, b.lat, BOAT_KEEL - 0.05, b.wp); toWorld(b.s, b.lat, 2.4, b.deck);
      boatM.panels.setColorAt(BOATS.indexOf(b), BOAT_PANEL[type]); boatM.panels.instanceColor.needsUpdate = true;
      return BOATS.indexOf(b);
    },
    naval: () => ({
      mines: MINES.map((m) => ({ s: +m.s.toFixed(0), lat: +m.lat.toFixed(1), y: +m.y.toFixed(1), alive: m.alive })),
      hunters: HUNTERS.map((h) => ({ s: +(h.ps ?? h.s).toFixed(0), lat: +(h.pl ?? h.lat).toFixed(1), y: +(h.py ?? h.y).toFixed(1), alive: h.alive, mode: h.mode })),
      boats: BOATS.map((b) => ({ s: +b.s.toFixed(0), lat: +b.lat.toFixed(1), type: b.type, alive: b.alive, hp: b.hp })),
    }),
    // place the ship (path coords) and freeze its lateral/vertical velocity
    place: (s, lat = 0, y = null, dive = null) => {
      G.s = s; G.lat = lat; G.vLat = 0; G.vY = 0; if (y !== null) G.y = y; if (dive !== null) G.dive = dive; camInit = false;
    },
    threat: (kind = 'turret', i = 0) => { const o = kind === 'turret' ? TURRETS[i] : DRONES[i]; threat(o, o.wp); return o.s; },
    damageShield: (n = 30) => damage(n, V4.copy(shipPos).addScaledVector(shipFwd, 6).clone(), 'debug'),
    setQuality: (q) => applyQuality(q),
    setEngine: (name) => { setEngine(name); return audio.engine; },
    // park the ship below a live turret (index into TURRETS), flying toward it from `back` metres
    nearTurret: (i = 0, back = 150) => {
      const t = TURRETS.filter((x) => x.alive)[i];
      if (!t) return null;
      G.s = t.s - back; G.lat = clamp(t.lat * 0.55, -riverHalf(G.s) * 0.7, riverHalf(G.s) * 0.7); G.vLat = 0; camInit = false;
      return { s: +t.s.toFixed(0), lat: +t.lat.toFixed(1), y: +t.y.toFixed(1) };
    },
    // screen position of both suns (NDC; |x|,|y| < 1 = in frame) and the camera pitch, for framing checks
    suns: () => {
      const f = (d) => { V3.copy(camera.position).addScaledVector(d, 1500).project(camera); return [+V3.x.toFixed(2), +V3.y.toFixed(2), V3.z < 1]; };
      camera.getWorldDirection(V4);
      return { sun: f(SUN), mirror: f(SUN2), pitch: +(Math.asin(V4.y) / DEG).toFixed(1), fov: +camera.fov.toFixed(1) };
    },
    post, scene,
    turrets: () => TURRETS.map((t) => ({ s: +t.s.toFixed(0), lat: +t.lat.toFixed(1), y: +t.y.toFixed(1), alive: t.alive })),
    shipCam: () => ({ ship: shipPos.toArray(), cam: camera.position.toArray() }),
  },
};

if (params.get('autostart') === '1') startGame();
loop();
