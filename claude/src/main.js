import { buildBoatFX, buildBoatUnderFX, buildShockRings, WAKE_W } from './boat-fx.js';
// LETHE / ЛЕТА — "Delivery" prototype. Game loop, flight model, shooting, shield, LETHE spotters
// and turrets, hazards, camera, HUD, adaptive quality.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, lerp, damp, smoothstep } from './util.js';
import {
  PAD_A, PAD_B, PAD_TOP, ROUTE, frame, toWorld, projectToPath, wallLat, riverHalf, bankY, maxY, narrowAt,
  ARCHES, ROCKS, ZONES, BEACONS, DRONES, MASTS, TURRETS, archBottom, archTop, zoneAt, zoneLinked, resetLevel,
  MINES, HUNTERS, BOATS, bedY, underLim, GATE_S, GATE_HOLD, GATE_BEAM,
} from './world.js';
import { buildGate, GATE_CORES, CORE_HP } from './gate.js';
import {
  buildMines, buildHunters, buildBoats, buildTurretGeo, buildTurretMountGeo, rimMaterial, BOAT_HL, BOAT_HW, BOAT_KEEL, BOAT_TOP, BOAT_FEATURES,
} from './naval.js';
import {
  buildChunks, buildWater, buildFields, buildFoam, buildShafts, makeSky, makeTerrainMaterial, makeWaterMaterial, STATIC_GLOWS, VENTS, FALLS,
} from './terrain.js';
import { Glows, Particles, Streaks, Beams, Debris, Motes, Wake } from './fx.js';
import { Ship, makeEnvMap } from './ship.js';
import { Audio, ENGINES } from './audio.js';
import { input, setupInput, pollInput } from './input.js';
import { Post, QualityGovernor, TIERS } from './post.js';

THREE.ColorManagement.enabled = false;
const params = new URLSearchParams(location.search);
const AUTOPILOT = params.get('autopilot') === '1';
// round 11 tips: 'lethe.tips' = '0' turns hints off; 'lethe.tips.boat' = '1' once the boat tutorial was seen
const TIPS_KEY = 'lethe.tips', TUT_KEY = 'lethe.tips.boat';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
const tipsParam = params.get('tips');   // ?tips=0 / ?tips=1 override for this page load only (tests)
let tipsOn = tipsParam !== null ? tipsParam !== '0' : lsGet(TIPS_KEY) !== '0';
if (tipsParam === '1') lsSet(TUT_KEY, null);
const tutArmed = () => tipsOn && lsGet(TUT_KEY) !== '1';
const TUT_R = 400, TUT_SLOW = 0.3, TUT_EASE = 0.4, TUT_HOLD = 2.1, TUT_PROMPT = 4;
const TUT_CUE = 7;   // round 12: seconds after the tutorial dive during which a torpedo lock pulses the ROCKET button
const TUT = { cueT: 0, cueSeen: false, phase: 'idle', t: 0, boat: null, hold: false, dist: 0, dived: false, outAt: 0, minScale: 1, count: 0, frozen: false, triggerAt: null, releaseAt: null, triggerS: null };
let timeScale = 1;
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
const FOG_THIN = new THREE.Color(0.55, 0.48, 0.43);
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
const hemi = new THREE.HemisphereLight(0xffd3b0, 0x55566a, 1.85);
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
// round 14: one pooled light that rides a sinking boat's breach so the hull stays readable in the murk
const wreckL = new THREE.PointLight(0xff6a22, 0, 22, 2);
scene.add(wreckL);
let wreckPick = 1e12;

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
  ship.setQuality(name);
  const T = TIERS[name];
  for (const c of chunks) for (const m of c.children) if (m.userData.detail) m.visible = T.detail && (!m.userData.highOnly || name === 'high');
  shafts.visible = T.name !== 'low';
  shafts.material.uniforms.uOp.value = name === 'high' ? 0.26 : 0.065;
  shafts.material.uniforms.uReach.value = name === 'high' ? 1.85 : 1;
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
const turretMat = rimMaterial([0.55, 0.87, 1.0], 1.25);
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
const boatMat = rimMaterial([0.85, 0.85, 0.8], 0.35);
const boatM = buildBoats(BOATS.length, boatMat);
const boatFX = buildBoatFX(BOATS.length), boatWaterM = new THREE.Matrix4();
scene.add(...Object.values(boatFX));
// round 12: boat seen from below (Snell glow + caustic ripples + wake turbulence, propeller-wash bubbles), underwater only
const boatUFX = buildBoatUnderFX(BOATS.length, FOG_D_WATER);
scene.add(boatUFX.under, boatUFX.wash);
const HULL_UW = new THREE.Color(0.2, 0.2, 0.21), HULL_AIR = new THREE.Color(1, 1, 1);   // hull albedo: dark silhouette from below
const SINK_COL = new THREE.Color();
scene.add(boatM.pF, boatM.pB, boatM.sF, boatM.sB, boatM.panels);
const shock = buildShockRings(6);
for (const r of shock.rings) scene.add(r.mesh);
const SHOCK = { kick: 0, t: -1, spawned: 0 };
for (const m of MINES) { m.wp = new THREE.Vector3(0, -1e4, 0); m.anchor = new THREE.Vector3(); }
for (const h of HUNTERS) { h.wp = new THREE.Vector3(0, -1e4, 0); h.nose = new THREE.Vector3(); h.fwd = new THREE.Vector3(0, 0, -1); }
for (const b of BOATS) { b.wp = new THREE.Vector3(0, -1e4, 0); b.deck = new THREE.Vector3(0, -1e4, 0); b.gun = new THREE.Vector3(); b.mast = new THREE.Vector3(); b.M = new THREE.Matrix4(); b.scan = 'off'; }
// round 11: the first two boats of the run (by position along the river) are gentler: slower, longer gun cooldown
for (const [k, b] of BOATS.slice(0, N_BOAT_REAL).sort((a, c) => a.home - c.home).entries()) b.easy = k < 2;
const EASY_PACE = 0.65, TUTOR_PACE = 0.6, EASY_CD = 1.6;
const boatPace = (b) => (b === TUT.boat ? TUTOR_PACE : b.easy ? EASY_PACE : 1);
const boatCdMul = (b) => (b.easy ? EASY_CD : 1);
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
  dive: $('btnDive'), rocketBtn: $('btnRocket'), rockets: $('tRockets'), pips: $('pips'), snd: $('snd'), hitx: $('hitx'), keys: $('keys'), engBtn: $('engBtn'), tut: $('tut'),
  pR: $('pR'), dampCue: $('dampCue'),
  act: $('act'), routeBar: $('routeBar'),   // round 16 (null-guarded: an old index.html must not crash the loop)
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
// round 16: act + gate ticks on the route bar
const routeTick = (s, cls, title) => {
  if (!hud.routeBar) return null;
  const el = document.createElement('div');
  el.className = cls; el.title = title || '';
  el.style.left = clamp((s - PAD_A) / ROUTE, 0, 1) * 100 + '%';
  hud.routeBar.appendChild(el);
  return el;
};
routeTick(GATE_S, 'gt', 'LETHE GATE / ВРАТА ЛЕТЫ');
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
    relayKills: 0, relayHinted: false, blindSaid: false, noRelay: false, blockLogged: false, lockLog: [], beamSegs: 0, beamTurret: -1, markPings: 0,
    waterBurned: 0, waterSpilled: 0, burnRate: 0, thinAir: false, steam: 0, burnHinted: false, thinHinted: false,
    dmgTaken: 0, uwCam: 0,
    scan: 0, scanWant: 0, scanCap: 62, scanPhase: 'off', scanBoat: -1, scanDrawn: 0,
    act: -1, shots: 0, shotHits: 0, coreKills: 0, deaths: 0, gateT: null,   // round 16
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
    const v = (5 + r * 13) * strength;
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
  G.dmgTaken += amount;
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

// ------------------------------------------------------------------ flight (air handling unchanged; round 14 drag applies only once submerged)
const SHIP_R = 3.2;
// Submerged cruise is about a third of air cruise (62). The dive plunge, still in air, keeps its 34 m/s target and lat 15.
const UW_FWD = 20, UW_DRAG = 2.6, UW_LAT = 11, UW_LAT_K = 3;
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
  // round 16: at the gate, line up with a live generator (air ones first, then dive for the underwater one)
  let gT = null;
  if (GATE.up && GATE_S - G.s < 560) gT = GATE.cores.find((c) => c.alive && !c.under) || GATE.cores.find((c) => c.alive);
  if (gT) { if (gT.under) needDive = true; else ty = gT.y; }
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
  if (gT) best = clamp(gT.lat, -wr * 0.75, wr * 0.75);
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
    // round 14: once the hull is under, hydro drag pulls cruise to UW_FWD and caps lateral speed.
    // Above the water the old targets stay: 34 while diving in, 62 + boost in air.
    // round 15: a boat scan lock damps only that air cruise. Dive entry and submerged handling are untouched.
    const submerged = G.underwater;
    const scanK = (!submerged && !G.dive) ? G.scan : 0;
    const target = submerged ? UW_FWD : (G.dive ? 34 : 62 + 32 * G.boost);
    let spdK = submerged ? UW_DRAG : (boosting ? 1.3 : 0.9);
    let latMax = submerged ? UW_LAT : (G.dive ? 15 : 30);
    let latK = submerged ? UW_LAT_K : 5;
    let aimSpd = target;
    if (scanK > 0) {
      aimSpd = target + (G.scanCap - target) * scanK;
      spdK += (2.7 - spdK) * scanK;
      latMax += (16 - latMax) * scanK;
      latK += (2.4 - latK) * scanK;
    }
    // round 16: the gate's field holds the ship in a hover arena ~GATE_HOLD m in front of it until the generators fall
    GATE.hold = false;
    if (GATE.up) {
      const room = GATE_S - GATE_HOLD - G.s;
      if (room < 260) { aimSpd = Math.min(aimSpd, Math.max(0, room * 0.55)); spdK = Math.max(spdK, 2.2); GATE.hold = room < 90; }
    }
    G.speed += (aimSpd - G.speed) * damp(spdK, dt);
    G.vLat += (ix * latMax - G.vLat) * damp(latK, dt);
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
  if (GATE.up && G.s > GATE_S - 10 && (G.phase === 'flight' || G.phase === 'failed')) {
    G.s = GATE_S - 10; G.speed = 0;
    GATE.bumpCd -= dt;
    if (GATE.bumpCd <= 0 && G.phase === 'flight') { GATE.bumpCd = 1; hitCargo(8, V1.copy(shipPos).addScaledVector(shipFwd, 4).clone()); curtainHit(shipPos, 1); }
  }
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
    if (Math.abs(G.s - GATE_S) < 8 && G.y > GATE_BEAM - 6) { G.y = GATE_BEAM - 6; G.vY = Math.min(G.vY, 0); }
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
  G.shots++;
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
const AIM_UW_BOAT = 25 * DEG;   // round 12
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
    const naval = kind === 'mine' || kind === 'hunter' || kind === 'boat' || (kind === 'core' && uw);
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
        // round 12: submerged, a boat's belly weak point gets a strong assist (±25°): bolts converge on it
        if (a > (uw && (kind === 'boat' || kind === 'core') ? AIM_UW_BOAT : AIM_CONE * 1.3) * widen) return;
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
      if (a > AIM_CONE * (kind === 'core' ? 1.9 : 1) * widen) return;
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
    if (Math.abs(GATE_S - G.s) < 90) for (const c of GATE.cores) if (c.alive && c.under) consider(c, 'core');
  } else {
    if (GATE_S - G.s < 260 && GATE_S - G.s > -20) for (const c of GATE.cores) if (c.alive && !c.under) consider(c, 'core');
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
  if (GATE_S - G.s < 400) for (const t of GATE.cores) if (t.alive && !t.under) { const c = rocketTargetOK(t.wp, from, dir, 0.96, 380); if (c > bc) { bc = c; best = t; } }
  return best && viewLOS(from, best.wp, G.s) ? best : null;
}
function fireRocket() {
  if (G.rocketCd > 0) return;
  if (G.rockets <= 0) { audio.empty(); popScore('NO ROCKETS / НЕТ РАКЕТ'); G.rocketCd = 0.4; return; }
  const r = rockets.find((x) => !x.on);
  if (!r) return;
  G.rockets--; G.rocketsFired++; G.rocketCd = ROCKET_CD;
  ship.body.updateMatrixWorld();
  const p = ship.body.localToWorld(V1.copy(ship.rocketPort));
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
  if (direct === 'boat ') { sparkBurst(p, 24, [2.2,1.9,1.5]); audio.ricochet(panOf(p)); armoredTag(p); }
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
      const rate = TURRETS.includes(r.target) || isCore(r.target) ? 2.4 : 1.3;   // turrets sit high on the ledges: steeper climb
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
    if (!hit && Math.abs(GATE_S - r.s) < 60) for (const c of GATE.cores) if (c.alive && !c.under && segSphere(r.q, r.p, c.wp, 3.4)) { hit = 'core '; hitCore(c, 8, r.p); break; }
    if (!hit && GATE.up && r.age > 0.08 && r.s > GATE_S - 1) { hit = 'world '; curtainHit(r.p, 1); }
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
      if (!dead && Math.abs(GATE_S - b.s) < 40) for (const c of GATE.cores) if (c.alive && c.under && segSphere(b.q, b.p, c.wp, 2.9)) { hitCore(c, 1, b.p); dead = true; break; }
      if (!dead) { dead = navalBoltHit(b, true); if (dead) G.shotHits++; }
      if (!dead && GATE.up && b.s > GATE_S - 0.5) { dead = true; curtainHit(b.p, 0.4); }
      if (!dead) dead = uwBoltWorld(b);
    } else {
      if (!dead) {
        for (const d of DRONES) {
          if (!d.alive || Math.abs(d.s - b.s) > 40) continue;
          if (segSphere(b.q, b.p, d.wp, 3.4)) { killTarget('drone', d); dead = true; G.shotHits++; break; }
        }
      }
      if (!dead) for (const t of BEACONS) {
        if (!t.alive || Math.abs(t.s - b.s) > 40) continue;
        if (segSphere(b.q, b.p, t.wp, 2.4) || segSphere(b.q, b.p, t.wp2, 1.6)) { killTarget('beacon', t); dead = true; G.shotHits++; break; }
      }
      if (!dead) for (const m of MASTS) {
        if (!m.alive || Math.abs(m.s - b.s) > 40) continue;
        if (m.pts.some((pt) => segSphere(b.q, b.p, pt, 2.1))) { breakMast(m); dead = true; break; }
      }
      if (!dead) for (const t of TURRETS) {
        if (!t.alive || Math.abs(t.s - b.s) > 40) continue;
        if (segSphere(b.q, b.p, t.wp, 2.6)) { killTarget('turret', t); dead = true; G.shotHits++; break; }
      }
      if (!dead && Math.abs(GATE_S - b.s) < 60) for (const c of GATE.cores) if (c.alive && !c.under && segSphere(b.q, b.p, c.wp, 2.9)) { hitCore(c, 1, b.p); dead = true; break; }
      if (!dead && GATE.up && b.s > GATE_S - 0.5) { dead = true; curtainHit(b.p, 0.4); }
      if (!dead) { dead = navalBoltHit(b, false); if (dead) G.shotHits++; }   // boats: armoured from above (ricochet)
      // entering the water: the bolt carries a few metres down — enough for mines just under the surface
      if (!dead && b.p.y < 0 && b.q.y >= 0) {
        V4.lerpVectors(b.q, b.p, b.q.y / Math.max(1e-4, b.q.y - b.p.y));   // water entry point
        V3.copy(V4).addScaledVector(b.d, Math.min(22, 3.2 / Math.max(0.05, -b.d.y)));
        for (const m of MINES) if (m.alive && Math.abs(m.s - b.s) < 40 && segSphere(V4, V3, m.wp, 2.0)) { killMine(m, 'shot'); G.shotHits++; break; }
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

// ------------------------------------------------------------------ round 12: torpedoes (ROCKET while submerged)
// Same ammo, cooldown and recoil as a rocket. Auto-acquires the nearest alive boat within ~250 m ahead in a wide
// cone (±60° horizontally, any elevation: no pitch-up needed). The torpedo runs in path space just below the surface
// (so it follows the river bends and slips around rock columns), then rises into the boat's belly.
// Damage: a smuggler sinks to one torpedo; a Council patrol boat takes two (each breaches half its hull, shown on its HP bar).
// No target: it runs straight along the river and scuttles itself after ~3 s.
const TORP_RANGE = 250, TORP_COS = Math.cos(60 * DEG), TORP_SPEED = 88, TORP_ACC = 75, TORP_TURN = 4.2, TORP_RUN_Y = -2.5, TORP_RISE = 34;
const TORP_LIFE = 6, TORP_FREE_LIFE = 3, TORP_N = 4;
const TORP_DMG = { smuggler: BOAT_HP, patrol: BOAT_HP / 2 };
const TORP = { target: null, lockT: 0, pingT: 0, fired: 0, hits: 0, kills: 0, scuttled: 0, log: [] };
const torps = [];
for (let i = 0; i < TORP_N; i++) torps.push({ on: false, s: 0, lat: 0, y: 0, vs: 0, vl: 0, vy: 0, p: new THREE.Vector3(), q: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), target: null, age: 0, life: 0 });
const torpMesh = new THREE.InstancedMesh(mergeGeometries([
  colored(tr(new THREE.CylinderGeometry(0.26, 0.26, 2.2, 8), 0, 0, 0, Math.PI / 2), [0.2, 0.22, 0.24]),
  colored(tr(new THREE.SphereGeometry(0.26, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0, -1.1, -Math.PI / 2), [0.75, 0.42, 0.12]),
  colored(tr(new THREE.CylinderGeometry(0.26, 0.1, 0.5, 8), 0, 0, 1.35, Math.PI / 2), [0.16, 0.17, 0.18]),
  colored(tr(new THREE.BoxGeometry(0.9, 0.04, 0.3), 0, 0, 1.3), [0.3, 0.32, 0.34]),
  colored(tr(new THREE.BoxGeometry(0.04, 0.9, 0.3), 0, 0, 1.3), [0.3, 0.32, 0.34]),
]), navalMat, TORP_N);
torpMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); torpMesh.frustumCulled = false;
for (let i = 0; i < TORP_N; i++) torpMesh.setMatrixAt(i, ZERO_M);
scene.add(torpMesh);
// lock: nearest alive boat in the cone, measured in path space (along the river, like the torpedo's own run)
function findTorpedoTarget() {
  if (!G.underwater || G.phase !== 'flight') return null;
  const head = Math.atan2(G.vLat, Math.max(1, G.speed));
  let best = null, bd = TORP_RANGE;
  for (const b of BOATS) {
    if (!b.alive) continue;
    const ds = b.s - G.s, dl = b.lat - G.lat, d = Math.hypot(ds, dl, b.wp.y - shipPos.y);
    if (d > bd || ds < -2) continue;
    if (d > 6 && Math.cos(Math.atan2(dl, ds) - head) < TORP_COS) continue;
    bd = d; best = b;
  }
  return best;
}
function fireTorpedo() {
  if (G.rocketCd > 0) return;
  if (G.rockets <= 0) { audio.empty(); popScore('NO TORPEDOES / НЕТ ТОРПЕД'); G.rocketCd = 0.4; return; }
  const t = torps.find((x) => !x.on);
  if (!t) return;
  G.rockets--; G.rocketsFired++; G.rocketCd = ROCKET_CD; TORP.fired++;
  ship.body.updateMatrixWorld();
  const p = ship.body.localToWorld(V1.copy(ship.rocketPort));
  const pr = projectToPath(p.x, p.z, G.s);
  t.on = true; t.s = pr.s; t.lat = pr.lat; t.y = Math.min(p.y, -1.2); t.vs = G.speed + 10; t.vl = G.vLat; t.vy = 0; t.age = 0;
  t.target = findTorpedoTarget(); t.life = t.target ? TORP_LIFE : TORP_FREE_LIFE;
  toWorld(t.s, t.lat, t.y, t.p); t.q.copy(t.p);
  TORP.log.push({ t: +G.t.toFixed(2), target: BOATS.indexOf(t.target), type: t.target ? t.target.type : null, s: +G.s.toFixed(0), y: +G.y.toFixed(2), pitch: +G.pitch.toFixed(3) });
  // the rocket's recoil: forward dip, nose kick, camera push-back + short shake
  G.recoilT = 0; G.kick = 1;
  G.shake = Math.min(1.4, G.shake + 0.42);
  for (let i = 0; i < 22; i++) mist.emit(p.x, p.y, p.z, shipVel.x * 0.3 + (Math.random() - 0.5) * 7, 1 + Math.random() * 4, shipVel.z * 0.3 + (Math.random() - 0.5) * 7, 0.8 + Math.random() * 0.8, 0.35, 1.3, 0.8, 1, 1, 0.75, -7, 2.2);
  sparks.emit(p.x, p.y, p.z, shipVel.x, shipVel.y, shipVel.z, 0.12, 4, 3, 0.5, 1.6, 1.8, 1);
  lightFlash(p, 170, 0.16, 0.4, 0.9, 1);
  audio.torpedo();
  if (TUT.cueT > 0) TUT.cueT = 0;   // the tutorial's "now fire [R]" cue is done
}
function torpedoHit(t, bt) {
  t.on = false;
  TORP.hits++;
  const p = t.p.clone();
  p.y = Math.max(p.y, BOAT_KEEL - 0.4);
  underwaterBlast(p, 1.25);
  for (const m of MINES) if (m.alive && m.wp.distanceTo(p) < 10) { m.fuse = 0.06 + m.wp.distanceTo(p) * 0.01; m.cause = 'chain'; }
  for (const h of HUNTERS) if (h.alive && h.wp.distanceTo(p) < 9) killHunter(h);
  if (!bt.alive) return;
  bt.hp = Math.max(0, bt.hp - TORP_DMG[bt.type]); bt.flashT = 0.5;
  const c = bt.type === 'patrol' ? [0.6, 1.8, 2] : [2, 1.1, 0.4];
  for (let i = 0; i < 26; i++) sparks.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 20, Math.random() * 10, (Math.random() - 0.5) * 20, 0.4, 1.2, 0.3, c[0], c[1], c[2], 1, 0, 3);
  if (bt.hp <= 0) { TORP.kills++; killBoat(bt, true); }
  else { audio.hitTick(); hitMarker(); popScore(`HULL ${Math.round((bt.hp / BOAT_HP) * 100)}% · ONE MORE / ЕЩЁ ОДНА`); }
}
function updateTorpedoes(dt) {
  for (let i = 0; i < TORP_N; i++) {
    const t = torps[i];
    if (!t.on) { torpMesh.setMatrixAt(i, ZERO_M); continue; }
    t.age += dt; t.life -= dt;
    if (t.target && !t.target.alive) { t.target = null; t.life = Math.min(t.life, 1.2); }
    const sp = Math.min(TORP_SPEED, Math.hypot(t.vs, t.vl) + TORP_ACC * dt);
    let hd = Math.atan2(t.vl, t.vs), ty = TORP_RUN_Y;
    const b = t.target;
    if (b) {
      const ds = b.s - t.s, dl = b.lat - t.lat, d = Math.hypot(ds, dl);
      // pursuit in path space with a capped turn rate; rise into the belly over the last ~34 m
      let err = Math.atan2(dl, ds) - hd;
      err = Math.atan2(Math.sin(err), Math.cos(err));
      hd += clamp(err, -TORP_TURN * dt, TORP_TURN * dt);
      if (d < TORP_RISE) ty = BOAT_KEEL + 0.4;
    }
    // slip around rock columns ahead
    for (const r of ROCKS) {
      const rs = r.s - t.s, rl = t.lat - r.lat;
      if (rs > -2 && rs < r.r + 14 && Math.abs(rl) < r.r + 2.5) { t.lat += Math.sign(rl || 1) * Math.min(Math.abs(Math.abs(rl) - r.r - 2.5), 30 * dt); }
    }
    t.vs = Math.cos(hd) * sp; t.vl = Math.sin(hd) * sp;
    t.vy += (clamp((ty - t.y) * 4, -10, 10) - t.vy) * damp(6, dt);
    t.s += t.vs * dt; t.lat += t.vl * dt; t.y += t.vy * dt;
    const lim = underLim(t.s) - 0.5;
    t.lat = clamp(t.lat, -lim, lim);
    t.y = clamp(t.y, bedY(t.s, t.lat) + 0.7, -0.8);
    t.q.copy(t.p); toWorld(t.s, t.lat, t.y, t.p);
    if (t.p.distanceToSquared(t.q) > 1e-6) t.dir.copy(t.p).sub(t.q).normalize();
    let hit = null;
    for (const bt of BOATS) if (bt.alive && Math.abs(bt.s - t.s) < 30 && inBoat(bt, t.p, 0.9)) { hit = bt; break; }
    if (hit) { torpedoHit(t, hit); torpMesh.setMatrixAt(i, ZERO_M); continue; }
    if (t.life <= 0) {
      // scuttled: a muffled pop of bubbles, harmless
      t.on = false; TORP.scuttled++;
      for (let k = 0; k < 24; k++) mist.emit(t.p.x, t.p.y, t.p.z, (Math.random() - 0.5) * 6, 1 + Math.random() * 5, (Math.random() - 0.5) * 6, 1 + Math.random(), 0.35, 1.2, 0.8, 1, 1, 0.75, -7, 2);
      sparks.emit(t.p.x, t.p.y, t.p.z, 0, 0, 0, 0.2, 3, 7, 0.5, 1.5, 1.7, 1);
      torpMesh.setMatrixAt(i, ZERO_M);
      continue;
    }
    M1.lookAt(V1.set(0, 0, 0), V2.copy(t.dir).negate(), UP);
    M1.multiply(M2.makeRotationZ(t.age * 9));
    M1.setPosition(t.p);
    torpMesh.setMatrixAt(i, M1);
    // bubble trail + pale wake streak + cold motor glow; a faint wake line just under the surface above it
    const tail = V3.copy(t.p).addScaledVector(t.dir, -1.6);
    beams.add(tail.x - t.dir.x * 9, tail.y - t.dir.y * 9, tail.z - t.dir.z * 9, tail.x, tail.y, tail.z, 0.5, 0.55, 1.25, 1.3, 0.8);
    glows.add(tail.x, tail.y, tail.z, 0.5, 1.6, 1.8, 0.9, 1.6);
    glows.add(t.p.x, t.p.y, t.p.z, 0.4, 1.1, 1.3, 0.3, 4.5);
    if (quality !== 'low') beams.add(tail.x - t.dir.x * 14, -0.15, tail.z - t.dir.z * 14, tail.x, -0.15, tail.z, 1.1, 0.5, 0.75, 0.8, 0.45);
    // bubbles per metre travelled (frame-rate independent), spacing by tier
    t.trail = (t.trail || 0) + t.p.distanceTo(t.q) / (quality === 'low' ? 3 : quality === 'med' ? 1.5 : 0.9);
    for (; t.trail >= 1; t.trail -= 1) {
      const f = Math.random();
      mist.emit(t.q.x + (t.p.x - t.q.x) * f - t.dir.x * 1.6, t.q.y + (t.p.y - t.q.y) * f, t.q.z + (t.p.z - t.q.z) * f - t.dir.z * 1.6,
        (Math.random() - 0.5) * 1.2, 0.5 + Math.random() * 1.3, (Math.random() - 0.5) * 1.2, 1.6 + Math.random() * 1.2, 0.35, 1.3, 0.85, 1, 1, 0.75, -4, 1.6);
    }
  }
  torpMesh.instanceMatrix.needsUpdate = true;
}
// per-frame lock (HUD bracket, sonar ping on a new lock, tutorial cue)
function updateTorpedoLock(rdt) {
  const tg = findTorpedoTarget();
  if (tg && tg !== TORP.target && TORP.pingT <= 0) { audio.torpedoLock(); TORP.pingT = 0.8; }
  TORP.pingT -= rdt;
  TORP.lockT = tg ? (tg === TORP.target ? TORP.lockT + rdt : 0) : 0;
  TORP.target = tg;
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
      const minS = (18 * dc) / pxScale;
      const base = locked ? 0.85 + 0.15 * Math.sin(time * 30) : 0.72 + 0.25 * Math.sin(time * 4 + i);
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
        t.cd = (6 + Math.random() * 5) * (t.blind ? 2.6 : 1) * (G.act >= 2 ? 0.7 : 1);   // round 16: act III escalates
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
  markPings(dt, time);
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
      if (b.src === 'punish') { PUN.hits++; PUN.dmg += b.dmg; if (b.punRec) { b.punRec.hits++; b.punRec.dmg += b.dmg; } }
      const through = damage(b.dmg, b.p.clone(), 'bolt');
      G.shake = Math.min(1.4, G.shake + 0.45);
      sparkBurst(b.p, 18, through > 0 ? [1.8, 0.9, 0.4] : [0.6, 1.5, 2]);
      explodeSmall(b.p);
      dead = true;
    }
    if (!dead && b.life < b.life0 - 0.1) { dead = b.under ? uwBoltWorld(b) : boltWorldHit(b); if (dead) b.why = 'world'; }
    if (dead) { b.on = false; b.punRec = null; if (b.accurate) G.ebLog.push((b.why || 'x') + ':' + b.minD.toFixed(1) + '@' + (3 - b.life).toFixed(2)); b.why = null; continue; }
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
  // faint red-amber carrier, dimmer than the cyan ship-tag so the two jobs stay apart
  beams.add(a.x, a.y, a.z, b.x, b.y, b.z, 0.08, 1.25, 0.22, 0.06, alpha * (0.2 + 0.07 * Math.sin(time * 9 + k)));
  const ph = (time * 1.6 + k * 0.37) % 1;
  for (let j = 0; j < n; j++) {
    const u = (j + ph) / n, u0 = Math.max(0, u - dl / len);
    const fl = alpha * (0.55 + 0.45 * Math.sin(time * 14 + j * 2.1 + k));
    // packets stay amber and a little softer — they run to the relay, not onto the ship
    beams.add(a.x + (b.x - a.x) * u0, a.y + (b.y - a.y) * u0, a.z + (b.z - a.z) * u0,
      a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u, 0.24, 2.2, 0.46, 0.1, fl * 0.82);
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
// MARK PING: while a drone is spotting, brief cold-cyan dashes travel drone → ship.
// A pair (tyn-tyn), then a gap. Slightly faster and brighter as the mark fills.
// Not a solid beam — the red turret designation laser stays that job. No pings underwater
// (drones do not spot there; cam-under also skips so the murk stays clear).
const PING_ON = 0.12;
function markPings(dt, time) {
  G.markPings = 0;
  G.markPingU = 0;
  // G.underwater is latched in updateHazards, which runs after this, so also test altitude.
  // A dive must kill the tag on the same frame the hull goes under. Camera-under skips too.
  const under = G.underwater || G.y < -0.6 || camUnder;
  if (G.phase !== 'flight' || under || G.spotters <= 0) {
    for (const d of DRONES) d.ping = null;
    return;
  }
  let nearest = null, nd = 1e9;
  for (const d of DRONES) if (d.spotting) {
    const x = d.wp.distanceTo(shipPos);
    if (x < nd) { nd = x; nearest = d; }
  }
  const k = G.mark;
  const bright = lerp(0.58, 1, k);
  for (const d of DRONES) {
    if (!d.spotting) { d.ping = null; continue; }
    if (!d.ping) d.ping = { phase: 'wait', t: 0.05 + ((d.phase % 1) * 0.26) };
    const p = d.ping;
    const was = p.phase;
    p.t -= dt;
    if (p.t <= 0) {
      if (p.phase === 'wait') { p.phase = 'a'; p.t = PING_ON; }
      else if (p.phase === 'a') { p.phase = 'gap'; p.t = lerp(0.1, 0.048, k); }
      else if (p.phase === 'gap') { p.phase = 'b'; p.t = PING_ON; }
      else { p.phase = 'wait'; p.t = lerp(0.64, 0.28, k); }
    }
    const flashing = p.phase === 'a' || p.phase === 'b';
    if (flashing && p.phase !== was && d === nearest) audio.markPing(panOf(d.wp), k, p.phase === 'b');
    if (flashing) drawMarkPing(d, 1 - p.t / PING_ON, bright * (p.phase === 'b' ? 1.08 : 0.92), time);
  }
  // hold a mid-pulse frame (path lit, stroke in the air) when a shot is requested
  if (freezeOnPing && G.markPingU > 0.45) frozen = true;
}
// Dashed cold-cyan tag for this flash only (off in the gap — not a solid laser), plus a
// brighter stroke travelling drone → ship. coreTint keeps the hot core cyan, not white.
function drawMarkPing(d, u, alpha, time) {
  if (u <= 0.05 || u > 1.02) return;
  const a = d.wp, b = shipPos;
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 3) return;
  // stop a few metres short of the hull so the tag sits in the air, not inside the mesh
  const arrive = Math.max(0.5, (len - 3.2) / len);
  const env = 0.72 + 0.28 * Math.sin(Math.min(u, 1) * Math.PI);
  const flick = 0.9 + 0.1 * Math.sin(time * 46 + d.phase);
  const A = alpha * env * flick;
  // cold cyan: green and blue high, red kept low — not white, not pure blue, not deep navy
  const cr = 0.2, cg = 1.85, cb = 2.15;
  const seg = (s0, s1, w, al) => {
    if (s1 - s0 < 0.015) return;
    beams.add(a.x + dx * s0, a.y + dy * s0, a.z + dz * s0, a.x + dx * s1, a.y + dy * s1, a.z + dz * s1,
      w, cr, cg, cb, al, 1);
  };
  // broken dashes along the whole path so the tag reads through dust, with gaps so it is not a solid beam
  const bits = len > 90 ? 4 : 3;
  for (let i = 0; i < bits; i++) seg((i + 0.06) / bits, Math.min(arrive, (i + 0.58) / bits), 0.34 + 0.08 * alpha, Math.min(1.05, A * 0.82));
  const u1 = Math.min(Math.max(u, 0.08), arrive);
  const dash = Math.min(42, Math.max(11, len * 0.36));
  seg(Math.max(0, u1 - dash / len), u1, 0.48 + 0.12 * alpha, Math.min(1.2, A));
  glows.add(a.x + dx * u1, a.y + dy * u1, a.z + dz * u1, 0.25, 1.35, 1.6, Math.min(1.1, A), 3.6);
  if (u < 0.4) glows.add(a.x, a.y - 0.15, a.z, 0.28, 1.3, 1.55, (1 - u / 0.4) * alpha, 4.2);
  if (u > 0.55) {
    const kGlow = Math.min(1, (u - 0.55) / 0.3) * alpha;
    const ix = b.x + (camera.position.x - b.x) * 0.12;
    const iz = b.z + (camera.position.z - b.z) * 0.12;
    glows.add(ix, b.y + 1.2, iz, 0.2, 1.55, 1.8, kGlow, 7.4);
  }
  if (u > G.markPingU) G.markPingU = u;
  G.markPings++;
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
    b.pun = 'idle'; b.punCd = 0;
    b.heard = false; b.hp = BOAT_HP; b.head = b.dir > 0 ? 0 : Math.PI; b.sinkT = 0; b.cd = (2 + Math.random() * 2) * boatCdMul(b); b.fire = 'idle'; b.ft = 0; b.shots = 0; b.flashT = 0;
    b.scan = 'off'; b.scanT = 0; b.scanGrace = 0; b.scanBeep = 0;
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
const NB_MID = new THREE.Vector3();
// player bolt vs naval targets; returns true if the bolt is used up
function navalBoltHit(b, under) {
  if (under) {
    for (const m of MINES) if (m.alive && Math.abs(m.s - b.s) < 30 && segSphere(b.q, b.p, m.wp, 1.9)) { killMine(m, 'shot'); return true; }
    for (const h of HUNTERS) if (h.alive && Math.abs(h.ps - b.s) < 30 && segSphere(b.q, b.p, h.wp, 1.8)) { killHunter(h); return true; }
  }
  for (const bt of BOATS) {
    if (!bt.alive || Math.abs(bt.s - b.s) > 24) continue;
    // round 12: underwater bolts also test the segment midpoint (long frames must not tunnel past a belly)
    if (!inBoat(bt, b.p, 0.3) && !(under && inBoat(bt, NB_MID.lerpVectors(b.q, b.p, 0.5), 0.3) && b.p.copy(NB_MID))) continue;
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
// round 14: a breach, not a debris bomb. Fire stays on the belly; the hull itself sinks in updateNaval.
// `blasted` — a torpedo already played underwaterBlast, so don't stack a second explosion.
function killBoat(bt, blasted = false) {
  if (!bt.alive) return;
  bt.alive = false; bt.sinkT = 0;
  bt.list = bt.lat >= 0 ? -1 : 1;
  G.boatKills++;
  const p = V4.copy(bt.wp);
  if (p.y > -0.35 || p.y < -6) p.y = -1.15;
  for (let i = 0; i < 16; i++) {
    sparks.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 7, (Math.random() - 0.35) * 5, (Math.random() - 0.5) * 7,
      0.4 + Math.random() * 0.4, 2.4, 7, 2.6, 0.85, 0.18, 1, -0.6, 1.6);
  }
  sparks.emit(p.x, p.y, p.z, 0, 0, 0, 0.32, 7, 14, 2.8, 1.15, 0.32, 1);
  for (let i = 0; i < 34; i++) {
    const a = Math.random() * 6.28, v = 1 + Math.random() * 4;
    mist.emit(p.x + (Math.random() - 0.5) * 2.4, p.y, p.z + (Math.random() - 0.5) * 2.4,
      Math.cos(a) * v * 0.3, 2.2 + Math.random() * 5, Math.sin(a) * v * 0.3,
      0.9 + Math.random(), 0.4, 1.6, 0.8, 0.98, 1, 0.85, -7, 1.7);
  }
  lightFlash(p, blasted ? 980 : 1280, 0.55, 1, 0.72, 0.28);
  G.flash = { p: p.clone(), t: 0.5, big: blasted ? 1.65 : 2.05, cold: false };
  boatShock(p, bt, blasted ? 0.85 : 1);
  splash(bt.deck, blasted ? 70 : 110, blasted ? 0.9 : 1.25);
  for (let i = 0; i < 7; i++) {
    mist.emit(bt.deck.x + (Math.random() - 0.5) * 4, 0.7, bt.deck.z + (Math.random() - 0.5) * 4,
      (Math.random() - 0.5) * 1.6, 2.5 + Math.random() * 3, (Math.random() - 0.5) * 1.6,
      2, 2.2, 9, 0.24, 0.18, 0.14, 0.42, -0.35, 0.35);
  }
  const near = clamp(1 - camera.position.distanceTo(p) / 160, 0, 1);
  if (!blasted) {
    G.shake = Math.min(1.5, G.shake + 0.45 + 0.55 * near);
    audio.explosion(0.95, near, panOf(p));
    audio.splash();
  }
  audio.shockWave(panOf(p));
  audio.boatSink(panOf(p));
  bt.scan = 'off';
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

// ---- round 12: close-range punish. Skimming over / past a boat above water (≤ ~40 m) without diving draws a heavy
// point-blank burst. Telegraph: the aim laser sweeps onto the ship for 0.65 s (thin, flickering), freezing on a lock
// line for the last 0.2 s (thick, solid) — then 5 heavy bolts go down that line (forward-led, so only a sideways /
// vertical jink or a dive escapes). Diving at any point before the burst cancels it.
// 5 × 24 = 120 damage: the full shield plus ~20 % hull — never a kill from full health.
const PUN_R = 40, PUN_TELE = 0.65, PUN_LOCK = 0.2, PUN_N = 5, PUN_DT = 0.07, PUN_DMG = 24, PUN_SPEED = 190, PUN_CD = 4;
const PUN_COL = [2.6, 0.35, 0.2];
const PUN = { log: [], tele: 0, dodgedDive: 0, bursts: 0, hits: 0, dmg: 0 };
const PUN_AIM = new THREE.Vector3();
function punishAim(b, out) {
  const tf = b.gun.distanceTo(shipPos) / PUN_SPEED;
  return toWorld(G.s + G.speed * (1 - G.dip) * tf, b.punLat, b.punY, out);
}
function updatePunish(b, dt, time) {
  b.punCd = (b.punCd || 0) - dt;
  if (G.phase !== 'flight') { b.pun = 'idle'; return; }
  if (!b.pun || b.pun === 'idle') {
    b.pun = 'idle';
    if (b.punCd > 0 || G.dive || G.underwater || G.y < 0.3 || (b === TUT.boat && TUT.hold)) return;
    if (b.deck.distanceTo(shipPos) > PUN_R || !viewLOS(b.gun, shipPos, b.s)) return;
    b.pun = 'tele'; b.punT = PUN_TELE; PUN.tele++;
    b.punRec = { i: BOATS.indexOf(b), teleAt: +G.t.toFixed(3), fireAt: null, dodged: null, shots: 0, hits: 0, dmg: 0, dist: +b.deck.distanceTo(shipPos).toFixed(1) };
    PUN.log.push(b.punRec); if (PUN.log.length > 60) PUN.log.shift();
    audio.punishAlarm(panOf(b.gun));
    showMsg('POINT-BLANK — DIVE OR JINK!', 'В УПОР — НЫРЯЙ ИЛИ УХОДИ!', 0.9, '#ff7a5a');
  }
  threat(b, b.deck);
  if (b.pun === 'tele') {
    b.punT -= dt;
    if (G.dive || G.underwater) { b.pun = 'idle'; b.punCd = PUN_CD; b.punRec.dodged = 'dive'; PUN.dodgedDive++; return; }
    const locked = b.punT <= PUN_LOCK;
    if (!locked) { b.punLat = G.lat; b.punY = Math.max(1.2, G.y); }
    punishAim(b, PUN_AIM);
    const fl = locked ? 1 : 0.55 + 0.45 * Math.sin(time * 70);
    beams.add(b.gun.x, b.gun.y, b.gun.z, PUN_AIM.x, PUN_AIM.y, PUN_AIM.z, locked ? 0.42 : 0.2, PUN_COL[0], PUN_COL[1], PUN_COL[2], fl);
    glows.add(b.gun.x, b.gun.y, b.gun.z, 2.6, 0.4, 0.2, 0.8 + 0.2 * Math.sin(time * 40), locked ? 6 : 4);
    glows.add(PUN_AIM.x, PUN_AIM.y, PUN_AIM.z, 2.4, 0.35, 0.15, locked ? 0.9 : 0.5, locked ? 4 : 2.5);
    if (b.punT <= 0) { b.pun = 'burst'; b.punShots = 0; b.punFt = 0; b.punRec.fireAt = +G.t.toFixed(3); PUN.bursts++; }
    return;
  }
  // burst
  b.punFt -= dt;
  if (b.punFt > 0) return;
  punishAim(b, PUN_AIM);
  const eb = enemyBolt(b.gun, PUN_AIM, b.s, PUN_SPEED, PUN_COL, PUN_DMG, 2.6, 'punish', false, 1.2);
  if (eb) eb.punRec = b.punRec;
  b.punRec.shots++;
  sparks.emit(b.gun.x, b.gun.y, b.gun.z, 0, 0, 0, 0.1, 5, 3, 2.6, 0.5, 0.2, 1);
  lightFlash(b.gun, 180, 0.1, 1, 0.35, 0.2);
  audio.turretShot(panOf(b.gun) * 0.8);
  b.punFt = PUN_DT;
  if (++b.punShots >= PUN_N) { b.pun = 'idle'; b.punCd = PUN_CD; }
}

// Round 15: a boat scans the lane from well before you are on top of it. The beam is the telegraph.
// Catch sticks the beam on the ship with no damp yet; lock (a beat later) pulls air cruise down.
// Dive, leaving the lane, or killing the boat drops it. Underwater handling is never damped by this.
const SCAN_R = 245, SCAN_LAT = 50, SCAN_ACQ = 0.5, SCAN_ACQ_EASY = 0.85;
const SCAN_CAP = 27, SCAN_CAP_EASY = 38, SCAN_CAP_TUT = 46;
const SCAN_COL = [2.35, 1.72, 0.52];
function boatShock(p, bt, scale = 1) {
  const dx = bt.deck.x, dz = bt.deck.z;
  shock.burst(dx, 0.85, dz, 38 * scale, 0.95, [1.05, 0.82, 0.4], 2.2);
  shock.burst(dx, 0.9, dz, 16 * scale, 0.42, [1.2, 0.95, 0.75], 0.6);
  shock.burst(p.x, Math.min(-0.4, p.y), p.z, 22 * scale, 0.7, [1.0, 0.45, 0.14], 1.2);
  SHOCK.spawned += 3;
  const d = shipPos.distanceTo(p);
  let kick = 0;
  if ((G.underwater || G.y < -0.35) && d < 30) {
    const k = 1 - d / 30;
    kick = k * k * scale;
    G.shake = Math.min(1.5, G.shake + 0.2 + 0.55 * kick);
    G.micro = Math.min(0.4, G.micro + 0.1 * kick);
    const ds = G.s - bt.s, dl = G.lat - bt.lat;
    const len = Math.hypot(ds, dl) || 1;
    G.vLat += (dl / len) * 6.5 * kick;
    G.vY += 2.6 * kick;
    G.speed *= 1 - 0.1 * kick;
  } else if (d < 46) {
    G.shake = Math.min(1.35, G.shake + 0.18 * scale * (1 - d / 46));
  }
  SHOCK.kick = kick;
  SHOCK.t = G.t;
}
function drawScanBeam(b, time, locked) {
  const flick = locked ? 0.82 + 0.18 * Math.sin(time * 28) : 0.28 + 0.72 * Math.abs(Math.sin(time * 26));
  const aim = V1.copy(shipPos); aim.y += 0.7;
  beams.add(b.mast.x, b.mast.y, b.mast.z, aim.x, aim.y, aim.z, locked ? 1.45 : 0.62, SCAN_COL[0], SCAN_COL[1], SCAN_COL[2], flick, 1);
  glows.add(b.mast.x, b.mast.y, b.mast.z, SCAN_COL[0], SCAN_COL[1], SCAN_COL[2], 0.85, locked ? 5.5 : 3.2);
  glows.add(aim.x, aim.y, aim.z, SCAN_COL[0], SCAN_COL[1] * 0.85, SCAN_COL[2], locked ? 0.75 : 0.4, locked ? 4.6 : 2.4);
  G.scanDrawn++;
  if (!locked) return;
  const r = 3.4, a0 = time * 2.2;
  for (let k = 0; k < 3; k++) {
    const a = a0 + k * 2.094;
    const x = aim.x + Math.cos(a) * r, z = aim.z + Math.sin(a) * r;
    beams.add(x, aim.y - 1.3, z, x, aim.y + 2.1, z, 0.28, SCAN_COL[0], SCAN_COL[1], SCAN_COL[2], 0.55, 1);
    G.scanDrawn++;
  }
}
function drawScanSweep(b, time, i) {
  const ds = G.s - b.s;
  const reach = clamp(Math.abs(ds), 34, 110);
  const aimS = b.s + Math.sign(ds || -1) * reach;
  const lat = b.lat + Math.sin(time * 0.92 + i * 1.4) * 32;
  const y = 7.5 + 3.2 * Math.sin(time * 0.92 + i);
  toWorld(aimS, lat, y, V1);
  const flick = 0.45 + 0.4 * Math.abs(Math.sin(time * 9 + i));
  beams.add(b.mast.x, b.mast.y, b.mast.z, V1.x, V1.y, V1.z, 0.85, SCAN_COL[0], SCAN_COL[1], SCAN_COL[2], flick, 1);
  glows.add(b.mast.x, b.mast.y, b.mast.z, SCAN_COL[0], SCAN_COL[1], SCAN_COL[2], 0.55, 2.8);
  glows.add(V1.x, V1.y, V1.z, SCAN_COL[0], SCAN_COL[1] * 0.7, 0.3, 0.28 * flick, 2.2);
  G.scanDrawn++;
}
function measureScan(b) {
  const pt = b.type === 'patrol';
  b.mast.set(0, pt ? 5.45 : 3.55, pt ? 1.0 : 3.5).applyMatrix4(b.M);
  const ds = b.s - G.s, dl = b.lat - G.lat;
  const dist = Math.hypot(ds, dl, (b.deck.y || 2) - G.y);
  // Lane check, not a straight chord: a bend must not hide the scan. Rocks and arches still break it.
  let los = dist < 460;
  if (los) {
    const steps = 5;
    for (let k = 1; k < steps && los; k++) {
      const s = G.s + (b.s - G.s) * (k / steps);
      const lat = G.lat + (b.lat - G.lat) * (k / steps);
      const y = G.y + (b.mast.y - G.y) * (k / steps);
      for (const ar of ARCHES) if (Math.abs(ar.s - s) < ar.ht && y > archBottom(ar, lat) && y < archTop(ar, lat)) los = false;
      for (const r of ROCKS) if (Math.abs(r.s - s) < r.r * 0.9 && y < r.h && Math.abs(r.lat - lat) < r.r * 0.75) los = false;
    }
  }
  const elig = b.alive && G.phase === 'flight' && !G.dive && !G.underwater && G.y > 0.45
    && ds > -28 && ds < SCAN_R && Math.abs(dl) < SCAN_LAT && los;
  const show = b.alive && ds > -40 && ds < 380 && Math.abs(dl) < 90 && dist < 420;
  return { ds, dl, dist, los, elig, show };
}
function resolveBoatScan(dt, time) {
  G.scanDrawn = 0;
  if (G.dive || G.underwater || G.y < 0.35 || G.phase !== 'flight') {
    for (const b of BOATS) if (b.scan !== 'off') b.scan = 'off';
    G.scanPhase = 'off'; G.scanWant = 0; G.scanBoat = -1;
    G.scan += (0 - G.scan) * damp(8, dt);
    if (G.scan < 0.01) G.scan = 0;
    return;
  }
  let holder = null;
  for (const b of BOATS) if (b.alive && (b.scan === 'catch' || b.scan === 'lock') && b.scanInfo && b.scanInfo.elig) holder = b;
  let cand = holder, candD = holder ? holder.scanInfo.dist : 1e9;
  if (!cand) {
    for (const b of BOATS) if (b.alive && b.scanInfo && b.scanInfo.elig && b.scanInfo.dist < candD) { cand = b; candD = b.scanInfo.dist; }
  }
  let phase = 'off', cap = G.scanCap, boatI = -1;
  for (let i = 0; i < BOATS.length; i++) {
    const b = BOATS[i];
    const info = b.scanInfo;
    if (!b.alive || !info) { b.scan = 'off'; continue; }
    const mine = b === cand;
    if (!mine && (b.scan === 'catch' || b.scan === 'lock') && b.scanGrace > 0) {
      b.scanGrace -= dt;
      drawScanBeam(b, time, b.scan === 'lock');
      if (b.scan === 'lock') { phase = 'lock'; boatI = i; cap = b.scanCap || SCAN_CAP; }
      else if (phase !== 'lock') { phase = 'catch'; boatI = i; }
      continue;
    }
    if (!mine) {
      b.scan = 'off';
      if (info.show) drawScanSweep(b, time, i);
      continue;
    }
    b.scanGrace = 0.22;
    const acq = (b.easy || b === TUT.boat) ? SCAN_ACQ_EASY : SCAN_ACQ;
    if (b.scan !== 'catch' && b.scan !== 'lock') {
      b.scan = 'catch'; b.scanT = acq; b.scanBeep = 0;
      audio.scanCatch(panOf(b.mast));
      if (TUT.phase !== 'active') showMsg('BOAT SCAN — DIVE', 'КАТЕР СКАНИРУЕТ — НЫРЯЙ', 1.15, '#ffd39a');
    }
    if (b.scan === 'catch') {
      b.scanT -= dt;
      if (b.scanT <= 0) {
        b.scan = 'lock'; b.scanBeep = 0.15;
        const tutSoft = b === TUT.boat && TUT.phase === 'active' && !TUT.dived;
        b.scanCap = tutSoft ? SCAN_CAP_TUT : (b.easy || b === TUT.boat) ? SCAN_CAP_EASY : SCAN_CAP;
        audio.scanLock(panOf(b.mast));
        if (TUT.phase !== 'active') showMsg('ENGINES DAMPED — DIVE', 'ДВИГАТЕЛИ ГЛУШАТ — НЫРЯЙ', 1.35, '#ffb15e');
      }
    }
    if (b.scan === 'lock') {
      const tutSoft = b === TUT.boat && TUT.phase === 'active' && !TUT.dived;
      b.scanCap = tutSoft ? SCAN_CAP_TUT : (b.easy || b === TUT.boat) ? SCAN_CAP_EASY : SCAN_CAP;
      drawScanBeam(b, time, true);
      b.scanBeep -= dt;
      if (b.scanBeep <= 0) { b.scanBeep = 0.55; audio.scanTick(panOf(shipPos)); }
      phase = 'lock'; boatI = i; cap = b.scanCap || SCAN_CAP;
    } else {
      drawScanBeam(b, time, false);
      if (phase !== 'lock') { phase = 'catch'; boatI = i; }
    }
  }
  G.scanPhase = phase;
  G.scanBoat = boatI;
  G.scanWant = phase === 'lock' ? 1 : 0;
  if (phase === 'lock') G.scanCap = cap;
  G.scan += (G.scanWant - G.scan) * damp(G.scanWant ? 5.5 : 7, dt);
  if (G.scan < 0.012 && !G.scanWant) G.scan = 0;
}

// round 14: bow and stern stay a boat. They list, the stern goes down, the break opens, and both halves
// sink with fire on the wound so the silhouette reads in the murk. No flying debris chunks.
function drawSinkingBoat(b, i, dt, time, mF, mB) {
  const t = b.sinkT;
  // hold the break up in the bright surface window, then drop the whole wreck (bow included) past the camera
  const crack = smoothstep(0.45, 2.5, t);
  const list = (b.list || 1) * 0.62 * smoothstep(0.2, 3.4, t);
  const sink = 0.45 * smoothstep(0, 1.8, t) + 6.6 * Math.pow(smoothstep(1.7, 6.6, t), 1.15);
  const sep = 2.1 * crack;
  const bowPitch = 0.22 * smoothstep(0.35, 2.6, t);
  const sternPitch = 0.4 * smoothstep(0.3, 2.5, t);
  const yaw = 0.5 * crack;
  const fade = 1 - smoothstep(5.4, 6.95, t);
  const breath = 0.7 + 0.3 * Math.sin(time * 11 + i);
  if (!b.bowM) { b.bowM = new THREE.Matrix4(); b.sternM = new THREE.Matrix4(); }
  const bow = b.bowM, stern = b.sternM;
  bow.copy(b.M);
  bow.multiply(M2.makeTranslation(0, -sink * 0.82, 0));
  bow.multiply(M2.makeRotationZ(list));
  bow.multiply(M2.makeTranslation(0.15 * crack, 0, -sep));
  bow.multiply(M2.makeRotationY(-yaw));
  bow.multiply(M2.makeRotationX(bowPitch));
  stern.copy(b.M);
  stern.multiply(M2.makeTranslation(0, -sink * 1.16 - 0.3 * crack, 0));
  stern.multiply(M2.makeRotationZ(list * 0.9));
  stern.multiply(M2.makeTranslation(-0.12 * crack, 0, sep));
  stern.multiply(M2.makeRotationY(yaw * 0.6));
  stern.multiply(M2.makeRotationX(sternPitch));
  mF.setMatrixAt(i, bow);
  mB.setMatrixAt(i, stern);
  SINK_COL.setRGB(1, 0.34 + 0.2 * breath, 0.05);
  boatM.panels.setColorAt(i, SINK_COL);
  // small belly wound, not a slab between the halves
  M1.copy(bow).multiply(M2.makeTranslation(0, -0.12, 0.15)).multiply(M2.makeScale(0.42, 1, 0.32));
  boatM.panels.setMatrixAt(i, M1);
  const at = (m, x, y, z, r, g, bl, a, size) => {
    V1.set(x, y, z).applyMatrix4(m);
    glows.add(V1.x, V1.y, V1.z, r, g, bl, a, size);
  };
  at(bow, 0, -0.45, 0.2, 2.6, 0.7, 0.14, 0.95 * breath * fade, 4.2);
  at(bow, 0, -0.45, 0.2, 3.0, 1.6, 0.55, 0.9 * fade, 1.8);
  at(bow, 0, 0.35, -6.3, 1.6, 1.55, 1.35, 0.8 * fade, 2.2);
  at(bow, 2.05, 0.15, -2.4, 1.3, 0.85, 0.35, 0.45 * fade, 1.5);
  at(bow, -2.05, 0.15, -2.4, 1.3, 0.85, 0.35, 0.45 * fade, 1.5);
  at(stern, 0, -0.35, 0.1, 2.3, 0.5, 0.1, 0.6 * breath * fade, 3.4);
  at(stern, 0, 1.35, 5.5, 2.2, 0.16, 0.06, (Math.sin(time * 8 + i) > -0.2 ? 0.9 : 0.22) * fade, 2.2);
  at(stern, 2.05, 0.15, 2.8, 1.7, 0.4, 0.1, 0.4 * fade, 1.5);
  at(stern, -2.05, 0.15, 2.8, 1.7, 0.4, 0.1, 0.4 * fade, 1.5);
  V2.set(0, -0.4, 0.25).applyMatrix4(bow);
  V1.set(0, -0.35, -0.1).applyMatrix4(stern);
  beams.add(V2.x, V2.y, V2.z, V1.x, V1.y, V1.z, 0.7, 2.5, 0.75, 0.16, (0.55 + 0.45 * breath) * fade);
  V3.set(0, -1.15, -6.2).applyMatrix4(bow);
  V1.set(0, -1.15, -0.2).applyMatrix4(bow);
  beams.add(V3.x, V3.y, V3.z, V1.x, V1.y, V1.z, 0.45, 1.8, 0.5, 0.12, 0.45 * fade);
  V3.set(0, -1.15, 0.2).applyMatrix4(stern);
  V1.set(0, -1.15, 6.2).applyMatrix4(stern);
  beams.add(V3.x, V3.y, V3.z, V1.x, V1.y, V1.z, 0.45, 1.5, 0.35, 0.08, 0.4 * fade);
  V1.set(0, -0.5, 0.3).applyMatrix4(bow);
  const dx = V1.x - camera.position.x, dy = V1.y - camera.position.y, dz = V1.z - camera.position.z, d2 = dx * dx + dy * dy + dz * dz;
  if (fade > 0.04 && d2 < 90 * 90 && d2 < wreckPick) {
    wreckPick = d2;
    wreckL.position.copy(V1);
    wreckL.intensity = 160 * fade * (0.82 + 0.18 * breath);
    wreckL.color.setRGB(1, 0.45, 0.14);
  }
  if (camUnder && sink < 2.6) {
    pathBasis(b.s, boatWaterM);
    boatWaterM.multiply(M2.makeRotationY(b.head)).setPosition(toWorld(b.s, b.lat, 0, V3));
    const k = 1 - sink / 2.6;
    M1.copy(boatWaterM).multiply(M2.makeTranslation(0, -0.3, 18)).multiply(M2.makeScale(44 * k, 1, 80 * k));
    boatUFX.under.setMatrixAt(i, M1);
  }
  let n = (quality === 'low' ? 20 : quality === 'med' ? 46 : 64) * (t < 2.4 ? 1.35 : 0.65) * (0.35 + 0.65 * fade) * dt;
  while (n > 0 && Math.random() < n) {
    n -= 1;
    const m = Math.random() < 0.7 ? bow : stern;
    V1.set((Math.random() - 0.5) * 2.2, -0.5 - Math.random() * 0.4, (Math.random() - 0.5) * 1.6).applyMatrix4(m);
    mist.emit(V1.x, V1.y, V1.z, (Math.random() - 0.5) * 0.8, 3.5 + Math.random() * 5.5, (Math.random() - 0.5) * 0.8,
      1.3 + Math.random() * 1.1, 0.45, 2.4, 0.82, 0.97, 1, 0.88, -5, 1.2);
  }
  let nf = (quality === 'low' ? 8 : 16) * fade * dt;
  while (nf > 0 && Math.random() < nf) {
    nf -= 1;
    const m = Math.random() < 0.5 ? bow : stern;
    V1.set((Math.random() - 0.5) * 1.8, -0.45 + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 1.2).applyMatrix4(m);
    sparks.emit(V1.x, V1.y, V1.z, (Math.random() - 0.5) * 1.6, 0.3 + Math.random() * 1.4, (Math.random() - 0.5) * 1.6,
      0.28 + Math.random() * 0.35, 1.1, 4.2, 2.5, 0.7 + Math.random() * 0.45, 0.12, 1, -0.4, 0.8);
  }
  if (t < 3.5 && Math.random() < dt * 8) {
    mist.emit(b.deck.x + (Math.random() - 0.5) * 3, 0.6, b.deck.z + (Math.random() - 0.5) * 3,
      (Math.random() - 0.5) * 1.5, 2.5 + Math.random() * 2, (Math.random() - 0.5) * 1.5,
      2.2, 2, 8, 0.22, 0.18, 0.15, 0.4, -0.3, 0.3);
  }
}
function updateNaval(dt, time) {
  const flying = G.phase === 'flight' || G.phase === 'landing';
  const sub = G.underwater && G.phase === 'flight';
  wreckPick = 1e12;
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
    for (const mesh of Object.values(boatFX)) mesh.setMatrixAt(i, ZERO_M);
    boatUFX.under.setMatrixAt(i, ZERO_M); boatUFX.wash.setMatrixAt(i, ZERO_M);
    const pt = b.type === 'patrol';
    const mF = pt ? boatM.pF : boatM.sF, mB = pt ? boatM.pB : boatM.sB, oF = pt ? boatM.sF : boatM.pF, oB = pt ? boatM.sB : boatM.pB;
    oF.setMatrixAt(i, ZERO_M); oB.setMatrixAt(i, ZERO_M);
    const gone = !b.alive && b.sinkT > 7;
    if (gone || b.s < G.s - 250 || b.s > G.s + 1300) {
      mF.setMatrixAt(i, ZERO_M); mB.setMatrixAt(i, ZERO_M); boatM.panels.setMatrixAt(i, ZERO_M);
      b.scanInfo = null; b.scan = 'off';
      if (!b.alive) { b.wp.set(0, -1e4, 0); b.deck.set(0, -1e4, 0); }
      continue;
    }
    if (b.alive) {
      // slow back-and-forth run around the home position (turning takes a few seconds)
      const turning = Math.abs((b.dir > 0 ? 0 : Math.PI) - b.head) > 0.3;
      b.s += Math.cos(b.head) * b.speed * boatPace(b) * dt * (turning ? 0.35 : 1);
      if ((b.s - b.home) * b.dir > 150) b.dir = -b.dir;
      b.head += ((b.dir > 0 ? 0 : Math.PI) - b.head) * damp(0.7, dt);
      b.lat = b.lat0 + Math.sin(time * 0.11 + i * 2) * 2.2 + Math.sin(b.head) * 3;
    } else b.sinkT += dt;
    const bob = b.alive ? Math.sin(time * 1.3 + i) * 0.12 : 0;
    pathBasis(b.s, b.M);
    b.M.multiply(M2.makeRotationY(b.head));
    if (b.alive) b.M.multiply(M2.makeRotationX(Math.sin(time * 1.1 + i * 2) * 0.025)).multiply(M2.makeRotationZ(Math.sin(time * 0.9 + i) * 0.04));
    b.M.setPosition(toWorld(b.s, b.lat, bob, V3));
    if (b.alive) {
      mF.setMatrixAt(i, b.M); mB.setMatrixAt(i, b.M);
      boatM.panels.setMatrixAt(i, b.M);
    } else {
      b.scanInfo = null; b.scan = 'off';
      drawSinkingBoat(b, i, dt, time, mF, mB);
      continue;
    }
    toWorld(b.s, b.lat, BOAT_KEEL - 0.1, b.wp);
    toWorld(b.s, b.lat, 2.4, b.deck);
    b.gun.set(0, 1.8, -6.2).applyMatrix4(b.M);
    pathBasis(b.s,boatWaterM); boatWaterM.multiply(M2.makeRotationY(b.head)).setPosition(toWorld(b.s,b.lat,0,V3));
    // wake plane starts at the bow (-7 m): Kelvin V arms plus the stern foam band
    const wakeLength = quality === 'low' ? 16 : 64, wakeW = quality === 'low' ? 14 : WAKE_W;
    boatFX.wake.material.uniforms.uL.value = wakeLength; boatFX.wake.material.uniforms.uW.value = wakeW;
    M1.copy(boatWaterM).multiply(M2.makeTranslation(0,0.22,-7+wakeLength/2)).multiply(M2.makeScale(wakeW,1,wakeLength)); boatFX.wake.setMatrixAt(i,M1);
    M1.copy(boatWaterM).multiply(M2.makeTranslation(0,0.25,-6.8)).multiply(M2.makeScale(12,1,7)); boatFX.bow.setMatrixAt(i,M1);
    if (quality !== 'low') {
      V2.copy(shipPos).applyMatrix4(M2.copy(b.M).invert());
      const sweep = b.fire !== 'idle' ? Math.atan2(-V2.x,-V2.z) : Math.sin(time*0.55+i)*0.65;
      M1.copy(b.M).multiply(M2.makeTranslation(0,4,-2)).multiply(M2.makeRotationY(sweep)).multiply(M2.makeRotationX(-0.10)).multiply(M2.makeScale(7,7,42)); boatFX.beam.setMatrixAt(i,M1);
      M1.copy(boatWaterM).multiply(M2.makeTranslation(-Math.sin(sweep)*35,0.24,-Math.cos(sweep)*35)).multiply(M2.makeScale(15,1,22)); boatFX.pool.setMatrixAt(i,M1);
    }
    // round 12: the boat from below — light pooling + caustic ripples + wake turbulence, propeller wash (underwater camera only)
    if (camUnder && b.deck.distanceTo(camera.position) < 200) {
      M1.copy(boatWaterM).multiply(M2.makeTranslation(0, -0.3, 18)).multiply(M2.makeScale(44, 1, 80)); boatUFX.under.setMatrixAt(i, M1);
      if (quality !== 'low') { M1.copy(boatWaterM).multiply(M2.makeTranslation(0, -0.95, 27)).multiply(M2.makeScale(10, 1, 40)); boatUFX.wash.setMatrixAt(i, M1); }
      if (b.deck.distanceTo(camera.position) < 120) {
        let nb = (quality === 'low' ? 8 : quality === 'med' ? 22 : 36) * dt;
        while (nb > 0 && Math.random() < nb) {
          nb -= 1;
          V1.set((Math.random() - 0.5) * 2.4, -0.8 - Math.random() * 0.6, 7.3 + Math.random()).applyMatrix4(boatWaterM);
          mist.emit(V1.x, V1.y, V1.z, (Math.random() - 0.5) * 3, 0.5 + Math.random() * 2, (Math.random() - 0.5) * 3, 1.4 + Math.random() * 1.2, 0.3, 1.1, 0.8, 1, 1, 0.7, -3, 1.4);
        }
      }
    }
    if (b.deck.distanceTo(shipPos) < 400) {
      threat(b,b.deck);
      if (!b.heard) { b.heard=true; audio.boatApproach(panOf(b.deck)); }
    }
    b.lightStart = glows.n;
    // lights: patrol = red/white strobes + xenon mast flash; smuggler = warm orange deck lamps.
    // Far away the sprites keep a minimum on-screen size and gain intensity through the haze.
    const P = V1, dCam = b.deck.distanceTo(camera.position), far = 1 + Math.min(0.7, dCam / 400);
    const lamp = (x, y, z, r, g, bl, a, size, minPx) => {
      P.set(x, y, z).applyMatrix4(b.M);
      glows.add(P.x, P.y, P.z, r, g, bl, a * far, Math.max(size, (minPx * dCam) / pxScale));
    };
    if (pt) {
      const st = Math.sin(time * 9 + i) > 0.3, ph = (time * 0.85 + i * 0.37) % 1;
      lamp(0, 4.75, 1.0, 3.5, 0.08, 0.04, st ? 0.75 : 0.06, 6.5, 44);
      lamp(1.5, 3.0, -0.9, 1.8, 1.8, 1.8, st ? 0.08 : 1, 2.2, 14);
      lamp(-1.5, 3.0, -0.9, 1.8, 1.8, 1.8, st ? 0.08 : 1, 2.2, 14);
      lamp(0, 1.6, -6.8, 2.2, 2.2, 2.2, st ? 1.2 : 0.08, 3.2, 20);
      // double-flash xenon strobe on the mast top
      if (ph < 0.05 || (ph > 0.12 && ph < 0.17)) lamp(0, 5.6, 1.0, 3, 3, 3.2, 0.75, 5, 28);
    } else {
      const fl = 0.75 + 0.25 * Math.sin(time * 13 + i * 5) * Math.sin(time * 3.1);
      lamp(1.4, 2.9, 2.2, 2.2, 0.9, 0.25, fl, 1.8, 14);
      lamp(-1.4, 2.9, 2.2, 2.2, 0.9, 0.25, fl * 0.9, 1.8, 14);
      lamp(0, 2.6, -2.0, 2.0, 0.75, 0.2, 0.55, 3, 20);
    }
    lamp(0,1.7,6.5,pt?2.6:2.2,pt?2.6:0.9,pt?2.6:0.2,pt?(Math.sin(time*9+i)<0.3?1.2:0.08):0.7,2.5,20);
    b.lightEnd = glows.n;
    // glowing belly weak point (seen from underwater only: the water surface hides it from above)
    if (camUnder) {
      const c = BOAT_PANEL[b.type], pu = 0.6 + 0.4 * Math.sin(time * 5 + i) + (b.flashT > 0 ? 1 : 0);
      for (const z of [-1.4, 0.3, 2.0]) { P.set(0, BOAT_KEEL - 0.15, z).applyMatrix4(b.M); glows.add(P.x, P.y, P.z, c.r * 0.7, c.g * 0.7, c.b * 0.7, pu * 0.6, 2.6); }
      // round 12: a stronger pulsing core on the weak spot (faster + brighter while the torpedo is locked on it)
      const lk = TORP.target === b, beat = 0.5 + 0.5 * Math.sin(time * (lk ? 9 : 4.5) + i);
      P.set(0, BOAT_KEEL - 0.3, 0.3).applyMatrix4(b.M);
      glows.add(P.x, P.y, P.z, c.r * 0.55, c.g * 0.55, c.b * 0.55, (0.45 + 0.55 * beat) * (lk ? 1.3 : 0.9), 4.5 + 2.5 * beat);
      glows.add(P.x, P.y, P.z, 1.6, 1.6, 1.5, 0.35 + 0.4 * beat, 1.4);
    }
    b.flashT -= dt;
    // bow wave / wake
    if (Math.random() < dt * 14 * Math.abs(Math.cos(b.head))) {
      P.set((Math.random() - 0.5) * 4, 0.2, -6.5).applyMatrix4(b.M);
      mist.emit(P.x, 0.3, P.z, (Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 3, 0.9, 0.8, 2.6, 0.88, 0.95, 0.95, 0.55, 8, 0.6);
    }
    b.scanInfo = measureScan(b);
    if (flying) shipHitsBoat(b);
    updatePunish(b, dt, time);
    // Council patrol boats fire on a surfaced ship in range: telegraph (white/blue strobe on the gun) -> 3 dodgeable bolts
    if (!pt || G.phase !== 'flight') continue;
    const dS = b.gun.distanceTo(shipPos);
    if (b.fire === 'idle') {
      b.cd -= dt;
      if (b.cd <= 0 && !(b === TUT.boat && TUT.hold) && !G.underwater && dS < 335 && dS > 12 && viewLOS(b.gun, shipPos, b.s)) { b.fire = 'tele'; b.ft = 0.8; b.teleAt = G.t; audio.boatAlarm(panOf(b.gun)); }
    } else {
      threat(b, b.deck);
      glows.add(b.gun.x, b.gun.y, b.gun.z, 1.2, 1.6, 2.6, 0.6 + 0.4 * Math.sin(time * 40), b.fire === 'tele' ? 3.5 : 2.5);
      if (b.fire === 'tele' && quality !== 'low') beams.add(b.gun.x,b.gun.y,b.gun.z,shipPos.x,shipPos.y,shipPos.z,0.16,2.0,0.18,0.08,0.35);
      b.ft -= dt;
      if (G.underwater || !viewLOS(b.gun, shipPos, b.s)) { b.fire = 'idle'; b.cd = 1.5; }
      else if (b.ft <= 0) {
        if (b.fire === 'tele') { b.fire = 'burst'; b.shots = 0; }
        leadTarget(b.gun, V4, PB_SPEED);
        V4.x += (Math.random() - 0.5) * 5; V4.y += (Math.random() - 0.5) * 3; V4.z += (Math.random() - 0.5) * 5;
        enemyBolt(b.gun, V4, b.s, PB_SPEED, EB_BLUE, 6, 3.0, 'boat');
        G.boatShots++;
        boatShotLog.push({t:G.t,teleAt:b.teleAt,range:dS,i}); if(boatShotLog.length>200)boatShotLog.shift();
        sparks.emit(b.gun.x, b.gun.y, b.gun.z, 0, 0, 0, 0.1, 4, 2, 1.2, 1.6, 2.6, 1);
        lightFlash(b.gun, 110, 0.12, 0.7, 0.85, 1);
        audio.turretShot(panOf(b.gun) * 0.8);
        b.ft = 0.2;
        if (++b.shots >= 3) { b.fire = 'idle'; b.cd = (3.2 + Math.random() * 1.6) * boatCdMul(b); }
      }
    }
  }
  resolveBoatScan(dt, time);
  shock.update(dt);
  for (const k of ['pF', 'pB', 'sF', 'sB', 'panels']) boatM[k].instanceMatrix.needsUpdate = true;
  boatFX.wake.material.uniforms.uTime.value = time;
  for (const mesh of Object.values(boatFX)) { mesh.instanceMatrix.needsUpdate=true; mesh.visible=quality!=='low'||mesh===boatFX.wake||mesh===boatFX.bow; }
  boatUFX.under.instanceMatrix.needsUpdate = boatUFX.wash.instanceMatrix.needsUpdate = true;
  boatUFX.under.visible = camUnder; boatUFX.wash.visible = camUnder && quality !== 'low';
  boatUFX.under.material.uniforms.uTime.value = boatUFX.wash.material.uniforms.uTime.value = time;
  boatMat.color.copy(camUnder ? HULL_UW : HULL_AIR);   // dark hull silhouette against the bright surface from below
  if (boatM.panels.instanceColor) boatM.panels.instanceColor.needsUpdate = true;
  if (wreckPick > 1e11) wreckL.intensity = 0;
  updateSpouts(dt);
  // first-encounter hints
  if (G.phase === 'flight') {
    if (!G.mineHinted) for (const m of MINES) if (m.alive && m.s > G.s && m.s - G.s < 170) { hint('mine'); break; }
    if (!G.hunterHinted) for (const h of HUNTERS) if (h.alive && h.ps > G.s && h.ps - G.s < 160) { hint('hunter'); break; }
    if (!G.boatHinted) for (const b of BOATS) if (b.alive && b.s > G.s - 20 && b.s - G.s < 400) { hint('boat'); break; }
  }
}
function hint(kind) {
  if (kind === 'mine' && !G.mineHinted) { G.mineHinted = true; toast('<b>Mines below — shoot them or steer clear.</b><br><i>Мины под водой — сбей или обойди.</i>', 5); }
  if (kind === 'hunter' && !G.hunterHinted) { G.hunterHinted = true; toast('<b>Hunters live underwater — shoot them while diving.</b><br><i>Охотники только под водой — стреляй в нырке.</i>', 5); }
  if (kind === 'boat' && !G.boatHinted) { G.boatHinted = true; toast('<b>Boats: dive, then fire a torpedo [R]</b><br><i>Нырни и пускай торпеду [R]</i>', 5.5); }
}

// ------------------------------------------------------------------ round 16: mission structure — acts + the LETHE gate finale
// The route is split into named acts (a title card on entry, escalating rim-turret pressure in act III) and ends at the
// LETHE gate: a frame across the canyon with a red energy curtain, held up by three generator cores (two in the air,
// one underwater). The field holds the ship in a hover arena in front of it; all three cores down = gate falls.
const gateObj = buildGate(scene, FOG_D_AIR);
const GATE = { up: true, said: false, hold: false, downT: -1, bumpCd: 0, hitK: 0, cores: [] };
GATE_CORES.forEach((c, i) => {
  const m = gateObj.cores[i];
  GATE.cores.push({ i, s: GATE_S, lat: m.lat, y: m.y, under: m.under, wp: toWorld(GATE_S, m.lat, m.y, new THREE.Vector3()), hp: CORE_HP, alive: true, cd: 1.6 + i * 0.8, gate: true, flash: 0 });
});
const isCore = (o) => !!(o && o.gate);
const CORE_PTS = 600, GATE_PTS = 1500;
const ACTS = [
  { s: 200, en: 'ACT I · THE NARROWS', ru: 'АКТ I · ТЕСНИНЫ', sub: 'Drones mark you · rim turrets fire', subRu: 'Дроны метят · турели стреляют' },
  { s: 2700, en: 'ACT II · DEEP WATER', ru: 'АКТ II · ГЛУБОКАЯ ВОДА', sub: 'Mines, hunters and patrol boats', subRu: 'Мины, охотники и патрульные катера' },
  { s: 5300, en: "ACT III · LETHE'S REACH", ru: 'АКТ III · ВЛАДЕНИЯ ЛЕТЫ', sub: 'LETHE is awake — everything at once', subRu: 'ЛЕТА проснулась — всё сразу' },
  { s: GATE_S - 720, en: 'FINALE · THE GATE', ru: 'ФИНАЛ · ВРАТА', sub: 'Break the gate — three generators', subRu: 'Сломай врата — три генератора' },
];
ACTS.forEach((a, i) => { if (i) routeTick(a.s, 'at', a.en); });
function actAt(s) { let a = -1; for (let i = 0; i < ACTS.length; i++) if (s >= ACTS[i].s) a = i; return a; }
let actT = 0;
function showAct(i) {
  const a = ACTS[i];
  if (!a || !hud.act) return;
  hud.act.innerHTML = `<b>${a.en}</b><span>${a.ru}</span><i>${a.sub} · ${a.subRu}</i>`;
  hud.act.classList.remove('on'); void hud.act.offsetWidth; hud.act.classList.add('on');
  actT = 3.6;
  audio.actSting?.();
}
function resetGate() {
  GATE.up = true; GATE.said = false; GATE.hold = false; GATE.downT = -1; GATE.bumpCd = 0; GATE.hitK = 0;
  for (const c of GATE.cores) { c.hp = CORE_HP; c.alive = true; c.cd = 1.6 + c.i * 0.8; c.flash = 0; }
  for (const m of gateObj.cores) m.g.visible = true;
  gateObj.curtain.visible = true; gateObj.curtainMat.uniforms.uAlpha.value = 1;
}
function curtainHit(p, k) {
  // ripple on the curtain at the impact (curtain local x = lateral, y = height)
  const pr = projectToPath(p.x, p.z, GATE_S);
  gateObj.curtainMat.uniforms.uHit.value.set(pr.lat, p.y - gateObj.curtain.position.y, 1);
  GATE.hitK = Math.max(GATE.hitK, k);
  sparks.emit(p.x, p.y, p.z, 0, 0, 0, 0.15, 4, 3, 2.4, 0.45, 0.2, 1);
}
function hitCore(c, dmg, p) {
  if (!c.alive) return;
  c.hp -= dmg; c.flash = 1;
  G.shotHits += dmg >= 4 ? 0 : 1;
  sparkBurst(p || c.wp, 10, c.under ? [0.6, 1.6, 1.6] : [2.4, 0.9, 0.4]);
  audio.hitTick();
  hitMarker();
  if (c.hp > 0) return;
  c.alive = false; c.hp = 0;
  G.coreKills++;
  G.score += CORE_PTS;
  gateObj.cores[c.i].g.visible = false;
  if (c.under) underwaterBlast(c.wp, 1.4); else explode(c.wp, 1.8);
  lightFlash(c.wp, 400, 0.4, 1, 0.4, 0.2);
  G.shake = Math.min(1.4, G.shake + 0.6);
  const left = GATE.cores.filter((x) => x.alive).length;
  popScore(`+${CORE_PTS} GENERATOR / ГЕНЕРАТОР`);
  if (left > 0) {
    showMsg(`GENERATOR DOWN — ${left} LEFT`, `ГЕНЕРАТОР УНИЧТОЖЕН — ОСТАЛОСЬ ${left}`, 2, '#ffb070');
    const uw = GATE.cores.find((x) => x.alive && x.under);
    if (uw && left === 1) toast('<b>Last generator is underwater — DIVE and shoot it.</b><br><i>Последний генератор под водой — НЫРЯЙ и стреляй.</i>', 5, true);
  } else gateDown();
}
function gateDown() {
  GATE.up = false; GATE.downT = 0; GATE.hold = false;
  G.gateT = G.t;
  G.score += GATE_PTS;
  showMsg('GATE DOWN — FLY TO SETTLEMENT B', 'ВРАТА ПАЛИ — ЛЕТИ В ПОСЁЛОК Б', 3, '#9ff2d8');
  popScore(`+${GATE_PTS} LETHE GATE / ВРАТА`);
  toast('LETHE: <em>“…no. NO.”</em> &nbsp;/&nbsp; ЛЕТА: <em>«…нет. НЕТ.»</em>', 3.5, true);
  audio.collapse();
}
function updateGate(dt, time) {
  const U = gateObj.curtainMat.uniforms;
  U.uTime.value = time;
  GATE.hitK = Math.max(0, GATE.hitK - dt * 2.5);
  U.uHit.value.z = GATE.hitK;
  if (GATE.downT >= 0) {
    GATE.downT += dt;
    U.uAlpha.value = Math.max(0, 1 - GATE.downT / 1.4) * (Math.random() < 0.3 ? 0.3 : 1);
    if (GATE.downT > 1.4) gateObj.curtain.visible = false;
    // chain of blasts along the beam
    const n = Math.floor(GATE.downT / 0.22);
    if (n > (GATE.booms || 0) && n <= 7) {
      GATE.booms = n;
      const lat = (n / 7 * 2 - 1) * gateObj.WL * 0.9;
      explode(toWorld(GATE_S, lat, GATE_BEAM - 2, V4).clone(), 1.2);
    }
  } else GATE.booms = 0;
  if (G.phase === 'flight' || G.phase === 'takeoff') { const a = actAt(G.s); if (a > G.act) { G.act = a; showAct(a); } }
  const near = GATE_S - G.s < 1400 && GATE_S - G.s > -330;
  if (!near) return;
  // generator glow: a pulsing core sphere + HDR glow sprite (hidden across the water line from the other side)
  for (const c of GATE.cores) {
    if (!c.alive) continue;
    c.flash = Math.max(0, c.flash - dt * 6);
    const m = gateObj.cores[c.i];
    const pulse = 1 + 0.08 * Math.sin(time * 6 + c.i * 2) + c.flash * 0.25;
    m.glow.scale.setScalar(pulse);
    if (c.under === camUnder) {
      const dc = c.wp.distanceTo(camera.position), minS = (14 * dc) / pxScale;
      glows.add(c.wp.x, c.wp.y, c.wp.z, c.under ? 1.2 : 2.4, c.under ? 0.5 : 0.35, 0.15, 0.9 + c.flash, Math.max(9, minS * 2));
    }
  }
  const lampOn = (time * 2) % 1 < 0.5;
  gateObj.lamps.visible = GATE.up ? lampOn : false;
  if (G.phase !== 'flight') return;
  const dist = GATE_S - G.s;
  if (GATE.up && !GATE.said && dist < 640) {
    GATE.said = true;
    showMsg('LETHE GATE — DESTROY 3 GENERATORS', 'ВРАТА ЛЕТЫ — УНИЧТОЖЬ 3 ГЕНЕРАТОРА', 3, '#ff8a5a');
    toast('<b>The gate field stops you. Shoot its generators — one is underwater (dive).</b><br><i>Поле врат не пустит. Сбей генераторы — один под водой (ныряй).</i>', 6, true);
  }
  if (!GATE.up || dist > 480 || dist < -20) return;
  // generator fire: air cores shoot red bolts while the ship is above water, the underwater core shoots cyan ones below;
  // the fewer cores are left, the faster the rest fire (escalation inside the fight)
  const left = GATE.cores.filter((x) => x.alive).length;
  for (const c of GATE.cores) {
    if (!c.alive) continue;
    const can = c.under ? G.underwater && c.wp.distanceTo(shipPos) < 115 : !G.underwater;
    if (!can) continue;
    c.cd -= dt;
    if (c.cd > 0) continue;
    c.cd = 1.0 + 0.55 * left + Math.random() * 0.6;
    if (!c.under && !lineOfSight(shipPos, c.wp, G.s)) continue;
    const sp = EB_SPEED * (c.under ? 0.55 : 0.85);
    V3.copy(shipPos).sub(c.wp).normalize().multiplyScalar(3.4).add(c.wp);
    const b = enemyBolt(V3, leadTarget(V3, V4, sp, c.under), GATE_S, sp, c.under ? EB_CYAN : EB_RED, 7, 3.4, 'gate', c.under, 4);
    if (!b) continue;
    threat(c, c.wp);
    sparks.emit(V3.x, V3.y, V3.z, 0, 0, 0, 0.12, 6, 3, c.under ? 0.4 : 2.4, c.under ? 1.6 : 0.4, c.under ? 1.7 : 0.2, 1);
    audio.turretShot(panOf(c.wp) * 0.8);
  }
}

// ------------------------------------------------------------------ off-screen threat indicator
// Anything that locks / fires / attacks registers here; an edge chevron points to it while it is off-screen or hidden
// (around a bend, or across the water surface), fading 1.5 s after the threat ends.
const boatShotLog = [];
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
    el.dataset.kind = BOATS.includes(obj) ? 'boat' : 'other';
    el.style.color = BOATS.includes(obj) && obj.fire === 'idle' ? '#ffc783' : '#ff5544';
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
    if(v.waterfall) {
      if(quality==='low'||(v.highOnly&&quality!=='high'))continue;
      const hi=quality==='high', w=v.width, fx=v.p.x-v.rx*w*0.16, fz=v.p.z-v.rz*w*0.16;
      // billowing base cloud: big slow sprites drifting out over the river
      if(Math.random()<dt*(hi?24:10)) {
        const a=(Math.random()-0.5)*w*1.3, o=Math.random()*4, sp=1.5+Math.random()*3;
        mist.emit(fx+v.tx*a-v.rx*o,v.p.y+1.8+Math.random()*4,fz+v.tz*a-v.rz*o,
          v.tx*(Math.random()-0.5)*3-v.rx*sp,1.2+Math.random()*2.5,v.tz*(Math.random()-0.5)*3-v.rz*sp,
          4.5+Math.random()*2.5,6,20+Math.random()*14,0.92,0.93,0.9,0.27,-0.3,0.3);
      }
      // white impact spray thrown up where the sheet hits the pool
      if(Math.random()<dt*(hi?36:14)) {
        const a=(Math.random()-0.5)*w*0.9;
        mist.emit(fx+v.tx*a,v.p.y+0.6,fz+v.tz*a,(Math.random()-0.5)*3-v.rx*2,4+Math.random()*5,(Math.random()-0.5)*3-v.rz*2,
          1.1+Math.random()*0.6,1.6,5,1,1,0.98,0.6,5,0.8);
      }
      // thin wisps peeling off the curtain edges
      if(Math.random()<dt*(hi?10:5)) {
        const e=v.edges[(Math.random()*v.edges.length)|0], sp=0.6+Math.random()*1.2;
        mist.emit(e.p.x,e.p.y,e.p.z,v.tx*e.out*sp-v.rx*0.6,-1.5-Math.random()*2,v.tz*e.out*sp-v.rz*0.6,
          2.4+Math.random(),0.8,4.5,0.92,0.93,0.9,0.22,-0.3,0.3);
      }
      continue;
    }
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
  const hov = GATE.hold ? 30 : 0;   // round 16: hovering at the gate — strafing must not swing the nose (aim stays on the gate)
  const yawT = -Math.atan2(G.vLat, Math.max(G.speed, 10, hov)) * 0.8;
  const pitchT = Math.atan2(G.vY, Math.max(G.speed, 12, hov)) * 0.8;
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
  // ventral lift engines (GLB model): small glows under the pods / belly
  for (const lf of ship.lifts) {
    nozW.copy(lf).applyMatrix4(ship.body.matrixWorld);
    glows.add(nozW.x, nozW.y, nozW.z, gc.r, gc.g * 0.8, gc.b * 0.6, 0.3 * power, 1.3 * power);
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
    const n = Math.ceil(skim * (7 + G.boost * (quality === 'high' ? 6 : 2)));
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1;
      const ox = shipPos.x + SF.rx * side * (2.5 + Math.random() * 2) + SF.tx * (2 + Math.random() * 6);
      const oz = shipPos.z + SF.rz * side * (2.5 + Math.random() * 2) + SF.tz * (2 + Math.random() * 6);
      const out = 5 + Math.random() * 8 + G.boost * 4;
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
let closeCam = null, cineCam = null, frozen = false, freezeOnPing = false;
const UW_CAM_BLEND = 0.7, UW_CAM_BACK = 7, UW_CAM_UP = 3.6, UW_CAM_LOOK = 1.4;   // round 12 underwater camera offset
// the extra pull-back never parks the camera behind a rock column in the river (it shrinks to stay in front of it)
function uwCamBack() {
  let back = UW_CAM_BACK;
  for (const r of ROCKS) {
    const ds = G.s - r.s;
    if (ds <= 0 || ds > 24 + UW_CAM_BACK + r.r + 3 || Math.abs(r.lat - G.lat) > r.r + 5) continue;
    back = Math.min(back, Math.max(0, ds - r.r - 3 - 24));
  }
  return back;
}
function updateCamera(dt, time) {
  const under = G.underwater;
  const start = G.phase === 'start';
  const wide = clamp((camera.aspect - 1.7) / 0.6, 0, 1);   // phones in landscape: a touch further
  // slightly tighter in the narrow slots so the near wall doesn't fill the frame
  G.camNarrow = (G.camNarrow || 0) + (narrowAt(G.s) - (G.camNarrow || 0)) * damp(1.5, dt);
  // round 12: underwater only, the camera is raised and pulled back (blended in over ~0.7 s after the dive) so the ship
  // covers less of the view; G.uwCam is 0 whenever the ship is not submerged, so the surface camera is untouched
  G.uwCam = under ? Math.min(1, G.uwCam + dt / UW_CAM_BLEND) : 0;
  const uwk = smoothstep(0, 1, G.uwCam);
  const dist = (start ? 30 : 30 * (1 - 0.17 * G.camNarrow)) + G.boost * 2.6 - (under ? 6 - uwCamBack() * uwk : 0) + G.dip * 22;
  // round 4: underwater the camera drops ~3 m *below* the ship (looking up a little), so the ship no longer hides
  // mines / hunters at its own depth, and boat bellies + the Snell window show overhead (camera framing only)
  const hgt = under ? -3.2 + UW_CAM_UP * uwk : (start ? 9 : 10.6 + wide * 0.6 + G.boost * 0.8);
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
  camLook.y = shipPos.y + (under ? 0.8 + UW_CAM_LOOK * uwk : 3.1);
  if (start) {
    // frame the ship low in the gap between the title and the brief
    V3.copy(shipPos).sub(camPos); V3.y = 0; V3.normalize();
    V2.crossVectors(V3, UP).normalize();
    camLook.copy(shipPos).addScaledVector(V2, 6.5).add(V3.set(0, 6, 0));
  }
  camera.lookAt(camLook);
  camera.rotateZ(G.roll * 0.22);
  if (closeCam) {
    // debug close-up (test hook only): orbit the ship in its own frame, az 0 = from behind, el in degrees
    const { az, el, dist } = closeCam;
    V3.set(Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), Math.cos(az * DEG) * Math.cos(el * DEG)).multiplyScalar(dist);
    camera.position.copy(shipPos).add(V3.applyQuaternion(ship.group.quaternion));
    camera.lookAt(shipPos);
  }
  if (cineCam) {
    // debug cinematic camera (test hook only): free camera in path space looking at a path-space point
    const c = cineCam;
    toWorld(c.s, c.lat, c.y, camera.position);
    camera.lookAt(toWorld(c.ls, c.llat, c.ly, V3));
  }
  const fovT = cineCam && cineCam.fov ? cineCam.fov : 64 + clamp((G.speed - 60) * 0.18, -6, 8) + G.boost * 12;
  fovCur += (fovT - fovCur) * (cineCam ? 1 : damp(3, dt));
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
    for (const r of shock.rings) r.mesh.material.uniforms.uFogD.value = fd;
    mist.out.mat.uniforms.uFogCol.value.copy(scene.fog.color);
    for (const z of ZONES) if (z.mesh) z.mesh.material.uniforms.uFogD.value = fd;
    hemi.intensity = cu ? 1.3 : 1.85;
    sunL.intensity = cu ? 1.2 : 2.6;
    hud.tintUnder.style.opacity = cu ? 1 : 0;
    post.grade.uniforms.uTintK.value = 0;
  }
  const thinLook = !cu && zoneAt(G.s)?.shielded === false;
  if (!cu) {
    post.grade.uniforms.uTint.value.set(0.22, 0.21, 0.20);
    post.grade.uniforms.uTintK.value = thinLook ? 0.22 : 0;
    scene.fog.color.copy(FOG_AIR).lerp(FOG_THIN, thinLook ? 0.6 : 0);
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
  boat: 'BOAT / КАТЕР · ARMORED', weak: 'WEAK POINT / УЯЗВИМОЕ МЕСТО', core: 'GENERATOR / ГЕНЕРАТОР' };
const TGT_R = { turret: 2.6, drone: 2.4, beacon: 2.2, mine: 1.8, hunter: 1.6, boat: 5, weak: 2.2, core: 3 };
const tgtEls = [], mtagEls = [];
for (let i = 0; i < TGT_N; i++) {
  const el = document.createElement('div'); el.className = 'tgt'; el.innerHTML = '<span></span><b class="hpb"><i></i></b>';
  $('tgts').appendChild(el); tgtEls.push({ el, span: el.firstChild, hp: el.lastChild.firstChild, hpV: -1, label: '', aim: false, kind: '', torp: false });
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
      const reach = kind === 'boat' ? 400 : kind === 'core' ? 330 : kind === 'weak' ? TORP_RANGE + 10 : range;   // round 12: boats stay bracketed through the murk out to torpedo range
      if (Math.abs(s - G.s) > reach + 30) return;
      const d = p.distanceTo(shipPos);
      if (d > reach || p.distanceTo(cp) < 8) return;
      tgtCand.push({ o, kind, d, p });
    };
    if (camUnder) {
      // underwater: mines, hunters and the boats' glowing belly (weak point)
      for (const m of MINES) if (m.alive) add(m, 'mine');
      for (const h of HUNTERS) if (h.alive && h.vis) add(h, 'hunter', h.wp, h.ps);
      for (const b of BOATS) if (b.alive) add(b, 'weak');
      for (const c of GATE.cores) if (c.alive && c.under) add(c, 'core');
    } else {
      for (const c of GATE.cores) if (c.alive && !c.under) add(c, 'core');
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
      if (!(c.kind === 'mine' && !camUnder) && !(c.kind === 'weak' && c.o === TORP.target) && !viewLOS(cp, c.p, G.s - 20)) continue;
      const dc = c.p.distanceTo(cp);
      const torp = c.kind === 'weak' && c.o === TORP.target;
      const size = c.kind === 'boat' ? clamp((TGT_R.boat * 2.6 * innerHeight) / (2 * dc * fy), 76, 130)
        : torp ? clamp((TGT_R.weak * 3 * innerHeight) / (2 * dc * fy), 46, 90) : clamp((TGT_R[c.kind] * 2.2 * innerHeight) / (2 * dc * fy), 18, 54);
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
      const label = c.kind === 'boat' ? `КАТЕР / BOAT · ${Math.round(c.d)} m${seen && seen.o === c.o && seen.t > 0 ? ' · ARMORED' : ''}`
        : torp ? `TORPEDO LOCK / ТОРПЕДА · ${Math.round(c.d)} m` : c.kind === 'weak' || c.kind === 'core' || (seen && seen.o === c.o && seen.t > 0) ? TGT_LABEL[c.kind] : '';
      if (label !== m.label) { m.label = label; m.span.textContent = label; }
      const aim = c.o === aimObj;
      if (aim !== m.aim) { m.aim = aim; m.el.classList.toggle('aim', aim); }
      if (torp !== m.torp) { m.torp = torp; m.el.classList.toggle('torp', torp); }
      // round 12: boat hull HP (a patrol boat shows the half a torpedo takes)
      const hpV = c.kind === 'core' ? c.o.hp / CORE_HP : c.kind === 'weak' || c.kind === 'boat' ? c.o.hp / BOAT_HP : -1;
      if (hpV !== m.hpV) { m.hpV = hpV; m.el.classList.toggle('hp', hpV >= 0); if (hpV >= 0) m.hp.style.transform = `scaleX(${hpV})`; }
      if (c.kind !== m.kind) {
        m.el.classList.toggle('weak', c.kind === 'weak' || c.kind === 'core');
        m.el.classList.toggle('uwk', c.kind === 'mine' || c.kind === 'hunter');
        m.el.classList.toggle('boat', c.kind === 'boat');
        m.kind = c.kind;
      }
      const alert = c.kind === 'boat' && (c.o.fire !== 'idle' || c.o.pun === 'tele' || c.o.pun === 'burst');
      m.el.style.color = alert ? '#ff5544' : '';
      if (alert !== m.alert) { m.alert = alert; m.el.classList.toggle('alert', alert); }
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
  const scanShow = G.scanPhase === 'catch' || G.scanPhase === 'lock';
  hud.pR.classList.toggle('damp', G.scanPhase === 'lock' || G.scan > 0.2);
  if (scanShow !== hud.dampCue.classList.contains('on')) hud.dampCue.classList.toggle('on', scanShow);
  if (scanShow && hud.dampPhase !== G.scanPhase) {
    hud.dampPhase = G.scanPhase;
    hud.dampCue.innerHTML = G.scanPhase === 'lock'
      ? 'ENGINES DAMPED — DIVE<i>ДВИГАТЕЛИ ГЛУШАТ — НЫРЯЙ</i>'
      : 'BOAT SCAN — DIVE<i>КАТЕР СКАНИРУЕТ — НЫРЯЙ</i>';
  }
  const pips = hud.pips.children;
  for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('off', i >= G.rockets);
  hud.pips.classList.toggle('cd', G.rocketCd > 0);
  hud.rocketBtn.classList.toggle('empty', G.rockets <= 0);
  hud.rocketBtn.classList.toggle('cd', G.rocketCd > 0);
  const rdt = realDt;
  if (G.msgT > 0) { G.msgT -= rdt; if (G.msgT <= 0) hud.msg.style.opacity = 0; }
  if (G.toastT > 0) {
    if (TUT.phase !== 'active') G.toastT -= rdt;   // round 11: a toast under the tutorial prompt waits (hidden) until it ends
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
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };   // null-guarded: never crash on an older index.html
  set('rTitle', ok ? 'MISSION COMPLETE' : 'MISSION FAILED');
  const rt = $('rTitle'); if (rt) rt.className = ok ? '' : 'bad';
  set('rSub', ok ? 'МИССИЯ ВЫПОЛНЕНА · Gate broken — settlement B has water tonight' : 'МИССИЯ ПРОВАЛЕНА · ' + G.reason);
  const mm = Math.floor(G.t / 60), ss = (G.t % 60).toFixed(1).padStart(4, '0');
  set('rTime', `${mm}:${ss}`);
  const litres = (pct) => Math.round(pct / 100 * TANK_L / 10) * 10;
  const fmtL = (l) => String(l).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009') + '\u00a0л';
  const deliv = ok ? G.cargo : 0;
  // round 16 headline stats
  G.killsTotal = G.kills + G.mineKills + G.hunterKills + G.boatKills + G.coreKills;
  set('rKills', `${G.killsTotal}`);
  set('rBoatsSunk', `${G.boatKills} / ${N_BOAT_REAL}`);
  G.accuracy = G.shots ? Math.min(100, Math.round(G.shotHits / G.shots * 100)) : 0;
  set('rAcc', G.shots ? `${G.accuracy}% (${G.shotHits}/${G.shots})` : '—');
  set('rDeaths', `${G.deaths}`);
  set('rGate', G.gateT != null ? 'BROKEN / СЛОМАНЫ' : `${G.coreKills} / ${GATE.cores.length}`);
  set('rCargo', Math.round(G.cargo) + '%');
  set('rWater', `${fmtL(litres(deliv))} (${Math.round(deliv)}%)`);
  set('rBurned', `${fmtL(litres(G.waterBurned))} (${G.waterBurned.toFixed(1)}%)`);
  set('rHealth', Math.round(Math.max(0, G.health)) + '%');
  set('rTargets', `${G.kills} / ${N_DRONE_REAL + BEACONS.length + TURRETS.length}`);
  set('rMasts', `${G.mastsBroken}`);
  set('rRelays', `${G.relayKills} / ${BEACONS.length}`);
  set('rMines', `${G.mineKills} / ${N_MINE_REAL}`);
  set('rHunters', `${G.hunterKills} / ${N_HUNTER_REAL}`);
  set('rBoats', `${G.boatKills} / ${N_BOAT_REAL}`);
  set('rHits', `${G.turretHits} / ${G.turretShotsFired}`);
  set('rScore', G.finalScore + (ok ? ` (+${timeBonus})` : ''));
  $('result')?.classList.remove('hide');
  document.body.classList.remove('playing');
  input.active = false;
}
function toMenu() {
  reset();
  $('result')?.classList.add('hide');
  $('start')?.classList.remove('hide');
}

function reset() {
  endTutorial(); TUT.phase = 'idle'; TUT.boat = null;
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
  for (const t of torps) t.on = false;
  Object.assign(TORP, { target: null, lockT: 0, fired: 0, hits: 0, kills: 0, scuttled: 0, log: [] });
  Object.assign(PUN, { log: [], tele: 0, dodgedDive: 0, bursts: 0, hits: 0, dmg: 0 });
  hud.rocketBtn.classList.remove('pulse'); TUT.cueT = 0;
  ship.body.position.z = 0;
  sparks.clear(); mist.clear(); debris.clear(); wake.clear();
  placeStatic();
  for (const z of ZONES) { z.mesh.visible = true; z.mesh.material.uniforms.uAlpha.value = 1; z.mesh.material.uniforms.uFlick.value = 1; }
  zoneEls.forEach((e) => e.classList.remove('off'));
  ship.diveT = 0;
  camInit = false;
  hud.toast.classList.remove('on');
  for (const m of MASTS) delete m.tagT;
  resetGate();
  if (hud.act) hud.act.classList.remove('on');
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
$('menuBtn')?.addEventListener('click', (e) => { e.stopPropagation(); toMenu(); });
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
// round 11: Tips / Подсказки toggle (start-screen settings block, next to the engine sound); turning it on re-arms the boat tutorial
const tipsSeg = document.querySelector('#tipsSel .seg');
function syncTips() { for (const b of tipsSeg.children) b.classList.toggle('on', (b.dataset.v === '1') === tipsOn); }
function setTips(on) {
  tipsOn = on; lsSet(TIPS_KEY, on ? '1' : '0');
  if (on) { lsSet(TUT_KEY, null); if (TUT.phase === 'done') TUT.phase = 'idle'; }
  syncTips();
}
for (const b of tipsSeg.children) {
  b.addEventListener('click', (ev) => { ev.stopPropagation(); audio.init(); audio.click(); setTips(b.dataset.v === '1'); b.blur(); });
  b.addEventListener('keydown', (ev) => ev.stopPropagation());
}
syncTips();
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

// ------------------------------------------------------------------ round 11: first-boat tutorial
// The first time an alive boat ahead comes within ~400 m (tips on, not yet seen): ~0.3x slow-mo with 0.4 s eases,
// a muffled / pitched-down mix with a voice-like sting, and a big "dive" prompt (pulsing DIVE button on touch).
// That boat holds fire until the player dives or the prompt times out. ?tips=0 disables it (tests), ?tips=1 re-arms it.
function updateTutorial(rdt) {
  const T = TUT;
  if (T.phase === 'idle') {
    if (G.phase === 'flight' && !G.dive && !G.underwater && tutArmed()) {
      let best = null, bd = TUT_R;
      for (const b of BOATS) {
        if (!b.alive || b.debug || b.s < G.s) continue;
        const d = b.deck.distanceTo(shipPos);
        if (d < bd) { bd = d; best = b; }
      }
      if (best) startTutorial(best, bd);
    }
    return;
  }
  if (T.phase !== 'active') return;
  if (G.phase !== 'flight') { endTutorial(); return; }
  if (!frozen && !T.frozen) T.t += rdt;
  if (!T.dived && (G.dive || G.underwater)) {
    T.dived = true;
    if (T.boat) T.cueT = TUT_CUE;   // round 12: step 2 — once submerged with a lock, pulse ROCKET (torpedo)
    T.outAt = Math.min(T.outAt, Math.max(T.t, TUT_EASE));   // diving ends the slow-mo early
    if (T.boat) audio.beep(1320);
  }
  const depth = smoothstep(0, TUT_EASE, T.t) * (1 - smoothstep(T.outAt, T.outAt + TUT_EASE, T.t));
  timeScale = 1 - (1 - TUT_SLOW) * depth;
  T.minScale = Math.min(T.minScale, timeScale);
  audio.slowmo(depth);
  if (T.hold && (T.dived || T.t >= TUT_PROMPT)) { T.hold = false; T.releaseAt = G.t; }
  const promptOn = !T.dived && T.t < TUT_PROMPT;
  if (!promptOn && hud.tut.classList.contains('on')) { hud.tut.classList.remove('on'); hud.dive.classList.remove('pulse'); }
  if (!promptOn && T.t > T.outAt + TUT_EASE) endTutorial();
}
// round 12: tutorial step 2. After the dive the big prompt goes (as in round 11); while submerged with a torpedo lock the
// ROCKET button pulses (touch and the desktop key strip) until a torpedo is fired or ~7 s pass.
function updateTorpCue(rdt) {
  if (TUT.cueT > 0 && !frozen) TUT.cueT -= rdt;
  const on = TUT.cueT > 0 && G.phase === 'flight' && G.underwater && !!TORP.target && G.rockets > 0;
  if (on) TUT.cueSeen = true;
  if (on !== hud.rocketBtn.classList.contains('pulse')) hud.rocketBtn.classList.toggle('pulse', on);
}
// round 12: the autopilot dives under a boat close ahead (as the tutorial teaches) through its existing dive timer
function apBoatDive() {
  if (G.air < 14) return;
  if (G.scanPhase === 'catch' || G.scanPhase === 'lock') { G.apDiveT = Math.max(G.apDiveT, 2.4); return; }
  for (const b of BOATS) if (b.alive && b.s - G.s > -25 && b.s - G.s < 240 && Math.abs(b.lat - G.lat) < 55) { G.apDiveT = Math.max(G.apDiveT, 1.8); return; }
  for (const b of BOATS) if (b.pun === 'tele') { G.apDiveT = Math.max(G.apDiveT, 1.4); return; }
}
function startTutorial(b, d) {
  Object.assign(TUT, { phase: 'active', t: 0, boat: b, hold: true, dist: d, dived: false, outAt: TUT_EASE + TUT_HOLD, minScale: 1,
    count: TUT.count + 1, triggerAt: G.t, releaseAt: null, triggerS: G.s });
  G.boatHinted = true;   // the prompt replaces the round-10 boat toast
  lsSet(TUT_KEY, '1');
  audio.tutorialSting();
  hud.tut.classList.add('on');
  hud.dive.classList.add('pulse');
  document.body.classList.add('tutorial');
}
function endTutorial() {
  if (TUT.hold) { TUT.hold = false; TUT.releaseAt = G.t; }
  TUT.phase = TUT.phase === 'idle' ? 'idle' : 'done';
  timeScale = 1; audio.slowmo(0);
  hud.tut.classList.remove('on'); hud.dive.classList.remove('pulse');
  document.body.classList.remove('tutorial');
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
  if (frozen) dt = 0;   // debug: freeze the simulation (cinematic shots)
  // round 11: tutorial slow-mo = one global time scale on the shared dt (1 outside the tutorial)
  updateTutorial(realDt);
  dt *= timeScale;
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
  if (AUTOPILOT && G.phase === 'flight') apBoatDive();
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
    if (isCore(aimObj)) autoFire = true;
    input.fire = autoFire;
  }
  updateTorpedoLock(realDt);
  // round 12: the autopilot sends one torpedo at a time at the locked boat
  if (AUTOPILOT && G.phase === 'flight' && TORP.target && TORP.lockT > 0.15 && G.rockets > 0 && G.rocketCd <= 0 && !torps.some((t) => t.on && t.target === TORP.target)) input.rocketPressed = true;
  if (G.phase === 'flight' && input.fire && G.fireCd <= 0) fire();
  // round 12: ROCKET while submerged launches a homing torpedo (it used to be a dry click)
  if (input.consumeRocket() && G.phase === 'flight') { if (G.underwater) fireTorpedo(); else fireRocket(); }
  updateTorpCue(realDt);
  updateBolts(dt);
  updateRockets(dt);
  updateTorpedoes(dt);
  updateTargets(dt, time);
  updateLethe(dt, time);
  updateNaval(dt, time);
  updateHazards(dt);
  updateGate(dt, time);
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
  const sv = cineCam ? cineCam.s : G.s;
  const s0 = sv - 320, s1 = sv + 1350;
  for (const c of chunks) c.visible = c.userData.sB > s0 && c.userData.sA < s1;
  for (const w of waters) w.visible = w.userData.sB > s0 && w.userData.sA < s1;
  for (const z of ZONES) if (z.mesh && z.shielded) z.mesh.visible = z.s1 > s0 && z.s0 < s1;
  gateObj.group.visible = GATE_S > s0 && GATE_S < s1;

  for (const m of FALLS) m.material.uniforms.uTime.value = time;
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
  audio.update(G.speed * (1 - G.dip), G.boost, camUnder, G.skim || 0, G.phase !== 'start' && G.phase !== 'result', G.prox || 0, G.y, (G.dive || G.underwater) ? 0 : G.scan);
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
      : BOATS.includes(aimObj) ? 'boat' : isCore(aimObj) ? 'core' : 'relay') : null, turretKills: G.turretKills,
    gate: { up: GATE.up, hold: GATE.hold, s: GATE_S, cores: GATE.cores.map((c) => (c.alive ? c.hp : 0)), coreKills: G.coreKills }, act: G.act,
    mission: { shots: G.shots, shotHits: G.shotHits, deaths: G.deaths, killsTotal: G.killsTotal ?? null, accuracy: G.accuracy ?? null },
    relaysAlive: BEACONS.filter((b) => b.alive).length, relaysDown: BEACONS.filter((b) => !b.alive).length, relayKills: G.relayKills,
    noRelay: G.noRelay, zone: zoneAt(G.s)?.idx ?? -1, sectorLinked: zoneLinked(zoneAt(G.s)), lockRelay: G.lock.phase !== 'none' ? !!G.lock.relay : null,
    lockTurret: G.lock.turret ? TURRETS.indexOf(G.lock.turret) : -1, lockLog: G.lockLog.slice(-8), dataBeam: G.beamSegs, beamTurret: G.beamTurret, markPings: G.markPings,
    blindTurrets: TURRETS.filter((t) => t.alive && t.blind).length,
    mines: { alive: MINES.filter((m) => m.alive).length, killed: G.mineKills, hit: G.mineHits },
    hunters: { alive: HUNTERS.filter((h) => h.alive).length, killed: G.hunterKills, rams: G.hunterRams, shots: G.hunterShots, hunting: HUNTERS.filter((h) => h.alive && h.mode === 'hunt').length,
      visible: HUNTERS.filter((h) => h.alive && h.vis && h.wp.distanceTo(shipPos) < 120).length },
    boats: { alive: BOATS.filter((b) => b.alive).length, killed: G.boatKills, shots: G.boatShots, ricochets: G.ricochets },
    navalHits: G.navalHits, threats: thrShown, markerKinds: tgtEls.filter((m) => m.el.style.display === 'block').map((m) => m.kind),
    markers: tgtEls.filter((m) => m.el.style.display === 'block').length, legend: hud.keys.classList.contains('on'),
    shield: +G.shield.toFixed(1), mark: +G.mark.toFixed(3), spotters: G.spotters, lock: G.lock.phase,
    turretShotsFired: G.turretShotsFired, ebLog: G.ebLog.slice(-6), rkLog: G.rkLog.slice(-4), turretHits: G.turretHits, quality, fps: Math.round(fps),
    camDist: +camera.position.distanceTo(shipPos).toFixed(2), shipFrac: shipFrac(), camWallGap: camGap(), drawCalls: renderer.info.render.calls, shipModel: ship.shipModel, triangles: renderer.info.render.triangles,
    tutorial: { phase: TUT.phase, timeScale: +timeScale.toFixed(3), minScale: +TUT.minScale.toFixed(3), t: +TUT.t.toFixed(2), prompt: hud.tut.classList.contains('on'),
      divePulse: hud.dive.classList.contains('pulse'), hold: TUT.hold, dived: TUT.dived, dist: +TUT.dist.toFixed(1), count: TUT.count, boat: BOATS.indexOf(TUT.boat),
      triggerAt: TUT.triggerAt, releaseAt: TUT.releaseAt, triggerS: TUT.triggerS, tips: tipsOn, seen: lsGet(TUT_KEY) === '1', armed: tutArmed() },
    timeScale: +timeScale.toFixed(3),
    // round 12
    dmgTaken: +G.dmgTaken.toFixed(1), uwCam: +G.uwCam.toFixed(3), camUnder,
    torpedo: { lock: !!TORP.target, target: BOATS.indexOf(TORP.target), lockT: +TORP.lockT.toFixed(2), dist: TORP.target ? +TORP.target.wp.distanceTo(shipPos).toFixed(1) : null,
      fired: TORP.fired, hits: TORP.hits, kills: TORP.kills, scuttled: TORP.scuttled, inFlight: torps.filter((t) => t.on).length,
      bracket: tgtEls.some((m) => m.torp && m.el.style.display === 'block'), cue: TUT.cueT > 0, cueSeen: TUT.cueSeen, rocketPulse: hud.rocketBtn.classList.contains('pulse') },
    punish: { tele: PUN.tele, bursts: PUN.bursts, dodgedDive: PUN.dodgedDive, hits: PUN.hits, dmg: PUN.dmg, active: BOATS.filter((b) => b.pun === 'tele' || b.pun === 'burst').length },
    fog: { density: scene.fog.density, color: scene.fog.color.toArray().map((x) => +x.toFixed(4)) },
    // round 14: submerged cruise targets (air handling still uses 62 + 32*boost / lat 30 when hydro.under is false)
    hydro: { under: G.underwater, fwd: UW_FWD, lat: UW_LAT, vLat: +G.vLat.toFixed(2), wreck: +wreckL.intensity.toFixed(1) },
    // round 15: scan damp is 0 unless a live boat's beam has locked; air cruise is unchanged at k = 0
    scan: { k: +G.scan.toFixed(3), want: G.scanWant, cap: G.scanCap, phase: G.scanPhase, boat: G.scanBoat, drawn: G.scanDrawn,
      dampCue: hud.dampCue.classList.contains('on'), speedDamp: hud.pR.classList.contains('damp') },
    shock: { kick: +SHOCK.kick.toFixed(3), spawned: SHOCK.spawned, live: shock.live(), t: +SHOCK.t.toFixed(2) },
    boatFeatures: BOAT_FEATURES,
  }),
  start: startGame,
  retry: () => { reset(); startGame(); },
  warp: (s) => { G.s = s; camInit = false; },
  input,
  debug: {
    hitCore: (i, d = 99) => hitCore(GATE.cores[i], d),
    gateWarp: (back = 300) => { G.s = GATE_S - back; G.y = 14; G.lat = 0; G.speed = 60; },
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
    clearDebugBoats: () => { for(const b of BOATS) if(b.debug) {b.alive=false;b.sinkT=8;} },
    spawnBoat: (ahead = 80, lat = null, type = 'patrol', speed = 0) => {
      const b = BOATS.find((x) => x.debug && !x.alive) || BOATS[BOATS.length - 1];
      const l = lat === null ? G.lat : lat;
      Object.assign(b, { s: G.s + ahead, home: G.s + ahead, lat: l, lat0: l, type, dir: 1, dir0: 1, speed, alive: true, hp: BOAT_HP, head: 0, sinkT: 0, cd: 1, fire: 'idle', easy: false, pun: 'idle', punCd: 0, scan: 'off', scanT: 0, scanGrace: 0 });
      toWorld(b.s, b.lat, BOAT_KEEL - 0.05, b.wp); toWorld(b.s, b.lat, 2.4, b.deck);
      boatM.panels.setColorAt(BOATS.indexOf(b), BOAT_PANEL[type]); boatM.panels.instanceColor.needsUpdate = true;
      return BOATS.indexOf(b);
    },
    boatSignals: () => BOATS.filter(b=>b.alive&&b.lightEnd>b.lightStart).map(b=>({type:b.type,lights:Array.from({length:b.lightEnd-b.lightStart},(_,j)=>({rgb:Array.from(glows.col.slice((b.lightStart+j)*4,(b.lightStart+j)*4+3)),size:glows.size[b.lightStart+j]}))})),
    boatShotLog: () => boatShotLog,
    // round 12: torpedoes, punish, underwater FX / camera probes
    torpedoes: () => torps.filter((t) => t.on).map((t) => ({ s: +t.s.toFixed(1), lat: +t.lat.toFixed(2), y: +t.y.toFixed(2), target: BOATS.indexOf(t.target), age: +t.age.toFixed(2) })),
    torpLog: () => TORP.log,
    torpCand: () => BOATS.filter((b) => b.alive).map((b) => { const ds = b.s - G.s, dl = b.lat - G.lat, head = Math.atan2(G.vLat, Math.max(1, G.speed));
      return { i: BOATS.indexOf(b), ds: +ds.toFixed(1), dl: +dl.toFixed(1), d: +Math.hypot(ds, dl, b.wp.y - shipPos.y).toFixed(1), off: +((Math.atan2(dl, ds) - head) / DEG).toFixed(1) }; }),
    fireTorpedo: () => { const before = TORP.fired; if (G.underwater) fireTorpedo(); return TORP.fired > before; },
    punishLog: () => PUN.log,
    fogConsts: () => ({ water: FOG_WATER.toArray(), dWater: FOG_D_WATER, air: FOG_AIR.toArray(), dAir: FOG_D_AIR }),
    underFX: () => ({ underVisible: boatUFX.under.visible, washVisible: boatUFX.wash.visible, hull: boatMat.color.toArray(),
      instances: BOATS.map((b, i) => { boatUFX.under.getMatrixAt(i, M1); const u = M1.elements[0] !== 0; boatUFX.wash.getMatrixAt(i, M1); return { under: u, wash: M1.elements[0] !== 0 }; }),
      particles: mist.n }),
    camOffset: () => ({ pitch: +G.pitch.toFixed(3), uwCam: +G.uwCam.toFixed(3), camDist: +camera.position.distanceTo(shipPos).toFixed(2), dy: +(camera.position.y - shipPos.y).toFixed(2), cam: camera.position.toArray(), ship: shipPos.toArray() }),
    boatHinted: () => G.boatHinted,
    // round 11 tutorial: trigger on boat i (default: nearest alive boat ahead, debug boats included), freeze its clock, re-arm
    tutorial: (i = null) => {
      let b = i === null ? null : BOATS[i];
      if (!b) { let bd = 1e9; for (const x of BOATS) if (x.alive && x.s > G.s && x.deck.distanceTo(shipPos) < bd) { bd = x.deck.distanceTo(shipPos); b = x; } }
      if (!b) return -1;
      endTutorial(); startTutorial(b, b.deck.distanceTo(shipPos)); return BOATS.indexOf(b);
    },
    tutorialFreeze: (on = true) => { TUT.frozen = !!on; },
    tutorialReset: () => { endTutorial(); TUT.phase = 'idle'; TUT.boat = null; },
    setTips: (on) => { setTips(!!on); return { tips: tipsOn, armed: tutArmed() }; },
    boatEase: () => BOATS.slice(0, N_BOAT_REAL).map((b) => ({ home: b.home, type: b.type, pace: boatPace(b), cdMul: boatCdMul(b), s: +b.s.toFixed(2) })),
    ricochetBoat: () => { const b=BOATS.find(b=>b.alive&&Math.abs(b.s-G.s)<400); if(b)ricochet(b,b.deck,shipFwd); },
    naval: () => ({
      mines: MINES.map((m) => ({ s: +m.s.toFixed(0), lat: +m.lat.toFixed(1), y: +m.y.toFixed(1), alive: m.alive })),
      hunters: HUNTERS.map((h) => ({ s: +(h.ps ?? h.s).toFixed(0), lat: +(h.pl ?? h.lat).toFixed(1), y: +(h.py ?? h.y).toFixed(1), alive: h.alive, mode: h.mode })),
      boats: BOATS.map((b) => ({ fire:b.fire, teleAt:b.teleAt, s: +b.s.toFixed(0), lat: +b.lat.toFixed(1), type: b.type, alive: b.alive, hp: b.hp })),
    }),
    // place the ship (path coords) and freeze its lateral/vertical velocity
    place: (s, lat = 0, y = null, dive = null) => {
      G.s = s; G.lat = lat; G.vLat = 0; G.vY = 0; if (y !== null) G.y = y; if (dive !== null) G.dive = dive; camInit = false;
    },
    // hold path position without clearing speed / vLat (round 14 handling probes)
    pin: (s, lat = 0, y = null, dive = null) => {
      G.s = s; G.lat = lat; if (y != null) G.y = y; if (dive != null) G.dive = dive;
    },
    sinkBoat: (i) => { const b = BOATS[i]; if (b && b.alive) killBoat(b); return !!b; },
    boatPose: (i) => {
      const b = BOATS[i]; if (!b) return null;
      const yOf = (mesh) => { mesh.getMatrixAt(i, M1); const e = M1.elements; return { y: +e[13].toFixed(2), sx: +Math.hypot(e[0], e[1], e[2]).toFixed(2) }; };
      const pt = b.type === 'patrol';
      const bow = yOf(pt ? boatM.pF : boatM.sF), stern = yOf(pt ? boatM.pB : boatM.sB);
      return { alive: b.alive, sinkT: +(b.sinkT || 0).toFixed(2), bowY: bow.y, sternY: stern.y, bowOn: bow.sx > 0.2, sternOn: stern.sx > 0.2, wreck: +wreckL.intensity.toFixed(1), list: b.list || 0,
        verts: { patrolBow: boatM.pF.geometry.attributes.position.count, patrolStern: boatM.pB.geometry.attributes.position.count, smugglerBow: boatM.sF.geometry.attributes.position.count, smugglerStern: boatM.sB.geometry.attributes.position.count } };
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
    // round 7 model checks: anchors in world space, LOD state, engine emissive, last muzzle flash point
    shipInfo: () => {
      ship.group.updateMatrixWorld();
      const w = (v) => ship.body.localToWorld(v.clone()).toArray().map((x) => +x.toFixed(2));
      const lod = ship.lod;
      return {
        model: ship.shipModel, muzzles: ship.muzzles.map(w), muzzlesLocal: ship.muzzles.map((v) => v.toArray().map((x) => +x.toFixed(2))),
        nozzles: ship.nozzles.map(w), lifts: ship.lifts.map(w), rocketPort: w(ship.rocketPort), lastMuzzle: G.muzzleP ? ship.body.worldToLocal(G.muzzleP.clone()).toArray().map((x) => +x.toFixed(2)) : null,
        lod: lod ? { auto: lod.autoUpdate, levels: lod.levels.map((l) => ({ d: l.distance, vis: l.object.visible })) } : null,
        engine: ship.engineMat ? ship.engineMat.emissive.toArray().map((x) => +x.toFixed(3)) : null, glow: ship.glowColor.toArray().map((x) => +x.toFixed(3)),
        armour: ship.shipModel === 'glb' ? ship.shield.visible : null, bubble: ship.bubble.scale.toArray().map((x) => +x.toFixed(2)),
      };
    },
    closeCam: (az = 35, el = 15, dist = 22) => { closeCam = az === null ? null : { az, el, dist }; },
    // round 8: free cinematic camera {s, lat, y, ls, llat, ly, fov} (null = off) and a simulation freeze
    cine: (c) => { cineCam = c || null; },
    freeze: (on = true) => { frozen = !!on; freezeOnPing = false; },
    freezeOnPing: () => { freezeOnPing = true; },
    // colours of ribbons drawn last frame: cyan ship-tags vs the red designation laser
    beamProbe: () => {
      const n = beams.n;
      let cyan = 0, laser = 0, laserRGB = null;
      for (let i = 0; i < n; i++) {
        const r = beams.C[i * 16], g = beams.C[i * 16 + 1], b = beams.C[i * 16 + 2], a = beams.C[i * 16 + 3];
        const tint = beams.Q[i * 16 + 3];
        if (tint > 0.5 && g > 1.3 && b > 1.5 && r < 0.5 && a > 0.15) cyan++;
        if (r > 2.1 && g < 0.25 && b < 0.15 && a > 0.4 && tint < 0.5) {
          laser++;
          if (!laserRGB) laserRGB = [+r.toFixed(3), +g.toFixed(3), +b.toFixed(3)];
        }
      }
      return { n, cyan, laser, laserRGB, markPings: G.markPings, spotters: G.spotters, underwater: G.underwater, camUnder, lock: G.lock.phase, mark: +G.mark.toFixed(3), frozen };
    },
    shipCam: () => ({ ship: shipPos.toArray(), cam: camera.position.toArray() }),
  },
};

if (params.get('autostart') === '1') startGame();
loop();
