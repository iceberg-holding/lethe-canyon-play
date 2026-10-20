import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const $ = (id) => document.getElementById(id);
const ROUTE_LENGTH = 4800;
const CRUISE = 38;
const AIR_MAX = 60;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const fmtTime = (seconds) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
};
const scene = new THREE.Scene();
scene.background = new THREE.Color("#df9270");
scene.fog = new THREE.Fog("#d78a70", 270, 1050);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 2200);
const renderer = new THREE.WebGLRenderer({
  canvas: $("view"),
  antialias: false,
  powerPreference: "high-performance",
  alpha: false,
});
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;

const glowCanvas = document.createElement("canvas");
glowCanvas.width = glowCanvas.height = 128;
const glowContext = glowCanvas.getContext("2d");
const glowGradient = glowContext.createRadialGradient(64, 64, 2, 64, 64, 64);
glowGradient.addColorStop(0, "rgba(255,255,255,0.95)");
glowGradient.addColorStop(0.18, "rgba(255,255,255,0.65)");
glowGradient.addColorStop(0.48, "rgba(255,255,255,0.18)");
glowGradient.addColorStop(1, "rgba(255,255,255,0)");
glowContext.fillStyle = glowGradient;
glowContext.fillRect(0, 0, 128, 128);
const glowTexture = new THREE.CanvasTexture(glowCanvas);
glowTexture.colorSpace = THREE.SRGBColorSpace;

scene.add(new THREE.HemisphereLight(0xffd2ae, 0x452d32, 2.1));
const sunLight = new THREE.DirectionalLight(0xffd5a1, 2.2);
sunLight.position.set(-140, 240, 120);
scene.add(sunLight);
const fillLight = new THREE.DirectionalLight(0xa4d9d4, 0.55);
fillLight.position.set(100, 45, -90);
scene.add(fillLight);

const routeAnchors = [
  new THREE.Vector3(0, 0, 0), new THREE.Vector3(18, 0, 350),
  new THREE.Vector3(82, 0, 790), new THREE.Vector3(55, 0, 1230),
  new THREE.Vector3(-24, 0, 1660), new THREE.Vector3(-90, 0, 2060),
  new THREE.Vector3(-52, 0, 2500), new THREE.Vector3(35, 0, 2900),
  new THREE.Vector3(98, 0, 3320), new THREE.Vector3(38, 0, 3750),
  new THREE.Vector3(-52, 0, 4150), new THREE.Vector3(0, 0, ROUTE_LENGTH),
];
const route = new THREE.CatmullRomCurve3(routeAnchors, false, "catmullrom", 0.34);
function routeAt(z) {
  const p = route.getPointAt(clamp(z / ROUTE_LENGTH, 0, 1));
  return p.x;
}
function canyonWidth(z) {
  return 125 + 17 * Math.sin(z * 0.0021 + 0.8) + 10 * Math.sin(z * 0.0048);
}

const skyGroup = new THREE.Group();
scene.add(skyGroup);
function makeSky() {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1800, 20, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: "varying vec3 vP; void main(){vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: `
        varying vec3 vP;
        void main(){
          float h=normalize(vP).y;
          vec3 low=vec3(0.73,0.32,0.25);
          vec3 mid=vec3(0.93,0.54,0.39);
          vec3 high=vec3(0.19,0.17,0.22);
          vec3 c=mix(low,mid,smoothstep(-0.18,0.32,h));
          c=mix(c,high,smoothstep(0.38,0.92,h));
          gl_FragColor=vec4(c,1.0);
        }`,
    }),
  );
  sky.position.set(0, 0, 0);
  skyGroup.add(sky);
  const sun = new THREE.Mesh(new THREE.SphereGeometry(14, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffe7bd }));
  sun.position.set(-185, 170, 790);
  skyGroup.add(sun);
  const sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color: 0xffb878, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending }));
  sunHalo.position.copy(sun.position);
  sunHalo.scale.set(100, 100, 1);
  skyGroup.add(sunHalo);
  const mirror = new THREE.Mesh(new THREE.SphereGeometry(7, 14, 10), new THREE.MeshBasicMaterial({ color: 0xe5f3ec }));
  mirror.position.set(95, 132, 850);
  skyGroup.add(mirror);
  const mirrorGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color: 0xc2f4f0, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }));
  mirrorGlow.position.copy(mirror.position);
  mirrorGlow.scale.set(50, 50, 1);
  skyGroup.add(mirrorGlow);
}
makeSky();

function makeVertexTerrain(z0, z1, side) {
  const rows = Math.ceil((z1 - z0) / 18) + 1;
  const columns = 6;
  const positions = [];
  const colors = [];
  const indices = [];
  const color = new THREE.Color();
  for (let row = 0; row < rows; row++) {
    const z = z0 + (z1 - z0) * row / (rows - 1);
    const center = routeAt(z);
    const width = canyonWidth(z) * 0.5;
    const inner = width * 0.50;
    const ridge = 42 + 10 * Math.sin(z * 0.005 + side) + 9 * Math.sin(z * 0.013 + side * 2);
    const offsets = [inner, inner + 3, inner + 9, inner + 20, inner + 43, inner + 84];
    const heights = [5, 15, ridge * 0.64, ridge * 0.94, ridge * 0.98, ridge * 0.82];
    for (let col = 0; col < columns; col++) {
      const f = col / (columns - 1);
      const x = center + side * offsets[col];
      let y = heights[col];
      y += 2.2 * Math.sin(z * 0.023 + col * 2.1 + side) + 1.2 * Math.cos(z * 0.057 + col);
      positions.push(x, y, z);
      const strata = Math.sin(y * 0.72 + z * 0.004) > 0.94 ? 1.18 : 1;
      const shade = (0.82 + 0.12 * Math.sin(z * 0.03 + col * 4 + side)) * strata;
      color.set(side < 0 ? "#9f4d3b" : "#b86243");
      color.multiplyScalar(shade * (1 - f * 0.16));
      colors.push(color.r, color.g, color.b);
    }
  }
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < columns - 1; col++) {
      const a = row * columns + col;
      const b = a + columns;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function makeRiver(z0, z1) {
  const rows = Math.ceil((z1 - z0) / 16) + 1;
  const pos = [];
  const col = [];
  const uv = [];
  const idx = [];
  const left = new THREE.Color("#13888c");
  const right = new THREE.Color("#42c8b6");
  for (let row = 0; row < rows; row++) {
    const z = z0 + (z1 - z0) * row / (rows - 1);
    const cx = routeAt(z);
    const half = 19 + Math.sin(z * 0.013) * 2.2;
    const wave = Math.sin(z * 0.026) * 0.22;
    pos.push(cx - half, 0.25 + wave, z, cx + half, 0.25 - wave, z);
    uv.push(0, row * 0.3, 1, row * 0.3);
    col.push(left.r, left.g, left.b, right.r, right.g, right.b);
    if (row < rows - 1) {
      const a = row * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.2, metalness: 0.12, side: THREE.DoubleSide,
    emissive: new THREE.Color("#06484c"), emissiveIntensity: 0.22,
  });
  return new THREE.Mesh(g, material);
}

function buildTerrain() {
  const chunkLength = 600;
  const terrainMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, flatShading: true, side: THREE.DoubleSide });
  for (let start = 0; start < ROUTE_LENGTH; start += chunkLength) {
    const end = Math.min(ROUTE_LENGTH, start + chunkLength + 8);
    const chunk = new THREE.Group();
    const left = makeVertexTerrain(start, end, -1);
    const right = makeVertexTerrain(start, end, 1);
    const canyon = mergeGeometries([left, right]);
    left.dispose();
    right.dispose();
    chunk.add(new THREE.Mesh(canyon, terrainMaterial), makeRiver(start, end));
    scene.add(chunk);
  }
}
buildTerrain();

const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
const rockMaterial = new THREE.MeshStandardMaterial({ color: "#9e5943", roughness: 0.94, flatShading: true });
const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, 280);
const dummy = new THREE.Object3D();
for (let i = 0; i < 280; i++) {
  const z = 35 + i * (ROUTE_LENGTH - 70) / 280;
  const side = i % 2 ? 1 : -1;
  const width = canyonWidth(z) / 2;
  const scale = 1.4 + Math.random() * 8;
  dummy.position.set(routeAt(z) + side * (width + 5 + Math.random() * 29), 3 + Math.random() * 11, z);
  dummy.rotation.set(Math.random() * 1.5, Math.random() * 6, Math.random() * 1.5);
  dummy.scale.set(scale, scale * (0.5 + Math.random() * 0.8), scale * (0.7 + Math.random() * 0.8));
  dummy.updateMatrix();
  rocks.setMatrixAt(i, dummy.matrix);
}
rocks.instanceMatrix.needsUpdate = true;
scene.add(rocks);

function addArch(z) {
  const radius = canyonWidth(z) * 0.46;
  const points = [];
  for (let i = 0; i <= 28; i++) {
    const u = -1 + 2 * i / 28;
    points.push(new THREE.Vector3(routeAt(z) + u * radius, 5 + 31 * Math.sqrt(Math.max(0, 1 - u * u)), z));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  return {
    z, radius, base: 5, peak: 36,
    geometry: new THREE.TubeGeometry(curve, 32, 5.2, 5, false),
  };
}
const arches = [520, 1270, 2090, 2980, 3890].map(addArch);
const archGeometry = mergeGeometries(arches.map((arch) => arch.geometry));
for (const arch of arches) {
  arch.geometry.dispose();
  delete arch.geometry;
}
scene.add(new THREE.Mesh(
  archGeometry,
  new THREE.MeshStandardMaterial({ color: "#875044", roughness: 0.98, flatShading: true }),
));

function makeSettlement(z, end = false) {
  const group = new THREE.Group();
  const x = routeAt(z);
  const mat = new THREE.MeshStandardMaterial({ color: end ? "#c5a78b" : "#9e8270", roughness: 0.85 });
  const domeMat = new THREE.MeshStandardMaterial({
    color: "#c7a68c", roughness: 0.8, metalness: 0.05,
    emissive: end ? "#27685e" : "#533d32", emissiveIntensity: end ? 0.18 : 0.14,
  });
  for (let i = 0; i < 4; i++) {
    const offset = (i - 1.5) * 18;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(7 + (i % 2) * 2, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), domeMat);
    dome.position.set(x + offset, 3, z + (i % 2) * 13);
    group.add(dome);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(6.8 + (i % 2) * 2, 7, 3, 12), mat);
    base.position.set(x + offset, 1, z + (i % 2) * 13);
    group.add(base);
  }
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(27, 27, 0.7, 24), new THREE.MeshStandardMaterial({ color: "#60514b", roughness: 0.9 }));
  pad.position.set(x, 0, z - (end ? 45 : -55));
  group.add(pad);
  scene.add(group);
}
makeSettlement(-125, false);
makeSettlement(ROUTE_LENGTH - 22, true);

const ship = new THREE.Group();
const hullMat = new THREE.MeshStandardMaterial({ color: "#737a79", roughness: 0.56, metalness: 0.46, flatShading: true });
const lightHull = new THREE.MeshStandardMaterial({ color: "#b0b5ae", roughness: 0.65, metalness: 0.32, flatShading: true });
const darkMat = new THREE.MeshStandardMaterial({ color: "#373b3d", roughness: 0.7, metalness: 0.45, flatShading: true });
const amberMat = new THREE.MeshBasicMaterial({ color: "#ff9d45" });
const cyanMat = new THREE.MeshBasicMaterial({ color: "#65fff0" });
const glassMat = new THREE.MeshStandardMaterial({ color: "#18353c", roughness: 0.16, metalness: 0.6, transparent: true, opacity: 0.8 });
const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 9), hullMat);
hull.scale.set(1.1, 0.52, 2.1);
ship.add(hull);
const engineHalos = [];
const nose = new THREE.Mesh(new THREE.ConeGeometry(0.84, 1.8, 8), lightHull);
nose.rotation.x = Math.PI / 2;
nose.position.set(0, 0.02, 1.78);
ship.add(nose);
const leftPanel = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.11, 0.83), lightHull);
leftPanel.position.set(-0.45, 0.38, 0.93);
ship.add(leftPanel);
const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.68, 12, 8), glassMat);
cockpit.scale.set(0.77, 0.58, 1.15);
cockpit.position.set(0, 0.51, 0.48);
ship.add(cockpit);
const canopyRim = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.07, 6, 12), darkMat);
canopyRim.scale.set(1.03, 0.78, 1.25);
canopyRim.position.copy(cockpit.position);
ship.add(canopyRim);
const wingGeometry = new THREE.BoxGeometry(1, 0.22, 1);
for (const side of [-1, 1]) {
  const wing = new THREE.Mesh(wingGeometry, hullMat);
  wing.scale.set(2.7, 1, 1.2);
  wing.position.set(side * 1.85, -0.03, -0.2);
  wing.rotation.y = side * -0.1;
  ship.add(wing);
  const wingTip = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.23, 0.65), lightHull);
  wingTip.position.set(side * 3.05, 0, -0.18);
  ship.add(wingTip);
  const engine = new THREE.Group();
  const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.57, 0.69, 1.95, 12), darkMat);
  pod.rotation.x = Math.PI / 2;
  engine.add(pod);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.11, 8, 14), hullMat);
  ring.position.z = -0.98;
  engine.add(ring);
  const glow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 12), amberMat);
  glow.position.z = -1.03;
  engine.add(glow);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color: "#ff963d", transparent: true, opacity: 0.65, depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.position.z = -1.12;
  halo.scale.set(2.4, 2.4, 1);
  engine.add(halo);
  engineHalos.push(halo);
  engine.position.set(side * 1.18, 0, -1.45);
  ship.add(engine);
}
const cargoCell = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.46, 1.25), new THREE.MeshStandardMaterial({ color: "#3b7774", roughness: 0.55, metalness: 0.42 }));
cargoCell.position.set(0, -0.54, -0.6);
ship.add(cargoCell);
const noseGunMat = new THREE.MeshStandardMaterial({ color: "#302e2d", metalness: 0.7, roughness: 0.45 });
for (const side of [-1, 1]) {
  const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.62, 7), noseGunMat);
  gun.rotation.x = Math.PI / 2;
  gun.position.set(side * 0.56, -0.13, 1.42);
  ship.add(gun);
}
const diveShield = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.11, 0.24), darkMat);
diveShield.position.set(0, 0.89, 0.6);
ship.add(diveShield);
function mergeStaticMeshes(root, excluded) {
  root.updateMatrixWorld(true);
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const batches = new Map();
  root.traverse((child) => {
    if (!child.isMesh || excluded.has(child)) return;
    const geometry = child.geometry.clone();
    geometry.applyMatrix4(inverseRoot.clone().multiply(child.matrixWorld));
    if (!batches.has(child.material)) batches.set(child.material, []);
    batches.get(child.material).push(geometry);
  });
  const originals = [];
  root.traverse((child) => {
    if (child.isMesh && !excluded.has(child)) originals.push(child);
  });
  for (const [material, geometries] of batches) {
    const merged = mergeGeometries(geometries);
    for (const geometry of geometries) geometry.dispose();
    root.add(new THREE.Mesh(merged, material));
  }
  for (const mesh of originals) mesh.parent.remove(mesh);
}
mergeStaticMeshes(ship, new Set([diveShield]));
scene.add(ship);

const sprayPositions = new Float32Array(180 * 3);
const sprayGeometry = new THREE.BufferGeometry();
sprayGeometry.setAttribute("position", new THREE.BufferAttribute(sprayPositions, 3));
const sprayPoints = new THREE.Points(sprayGeometry, new THREE.PointsMaterial({ color: "#b8fff0", size: 1.5, transparent: true, opacity: 0.68, depthWrite: false, sizeAttenuation: true }));
scene.add(sprayPoints);
const sprayLife = new Float32Array(180);
const bubblePositions = new Float32Array(120 * 3);
const bubbleGeometry = new THREE.BufferGeometry();
bubbleGeometry.setAttribute("position", new THREE.BufferAttribute(bubblePositions, 3));
const bubbles = new THREE.Points(bubbleGeometry, new THREE.PointsMaterial({ color: "#a7fff1", size: 0.8, transparent: true, opacity: 0.6, depthWrite: false }));
scene.add(bubbles);
const speedLineGeometry = new THREE.BufferGeometry();
const speedLinePositions = new Float32Array(48 * 2 * 3);
speedLineGeometry.setAttribute("position", new THREE.BufferAttribute(speedLinePositions, 3));
const speedLines = new THREE.LineSegments(speedLineGeometry, new THREE.LineBasicMaterial({ color: "#ffe1bf", transparent: true, opacity: 0.24, depthWrite: false }));
scene.add(speedLines);

const targets = [];
const masts = [];
const fields = [];
const mastInstances = {
  feet: new THREE.InstancedMesh(new THREE.CylinderGeometry(1.4, 2.4, 2, 8), darkMat, 6),
  poles: new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.34, 0.52, 22, 7),
    new THREE.MeshStandardMaterial({ color: "#8f7766", metalness: 0.45, roughness: 0.55 }),
    6,
  ),
  heads: new THREE.InstancedMesh(
    new THREE.OctahedronGeometry(2.3, 0),
    new THREE.MeshStandardMaterial({ color: "#b7e9d8", emissive: "#4b9f88", emissiveIntensity: 1.1, metalness: 0.5 }),
    6,
  ),
};
for (const mesh of Object.values(mastInstances)) {
  mesh.frustumCulled = false;
  scene.add(mesh);
}
const targetMeshes = {
  droneBodies: new THREE.InstancedMesh(
    new THREE.SphereGeometry(1.25, 10, 8),
    new THREE.MeshStandardMaterial({ color: "#75827e", metalness: 0.68, roughness: 0.38 }),
    11,
  ),
  droneArms: new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.13, 0.12, 2.6),
    darkMat,
    22,
  ),
  droneLights: new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.22, 6, 6),
    new THREE.MeshBasicMaterial({ color: "#ffb76b" }),
    22,
  ),
  beaconStems: new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.27, 0.42, 5.8, 7),
    new THREE.MeshStandardMaterial({ color: "#72665c", metalness: 0.4, roughness: 0.8 }),
    10,
  ),
  beaconHeads: new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.83, 8, 6),
    new THREE.MeshBasicMaterial({ color: "#ff5544" }),
    10,
  ),
};
for (const mesh of Object.values(targetMeshes)) {
  mesh.frustumCulled = false;
  scene.add(mesh);
}
const targetDummy = new THREE.Object3D();
const targetColor = new THREE.Color();
function setTargetInstance(mesh, index, x, y, z, scaleX = 1, scaleY = scaleX, scaleZ = scaleX) {
  targetDummy.position.set(x, y, z);
  targetDummy.scale.set(scaleX, scaleY, scaleZ);
  targetDummy.updateMatrix();
  mesh.setMatrixAt(index, targetDummy.matrix);
}
function addTarget(kind, z, xOffset, y, score) {
  const group = new THREE.Group();
  const positionX = routeAt(z) + xOffset;
  group.position.set(positionX, y, z);
  const target = { kind, group, x: positionX, z, y, score, destroyed: false, phase: Math.random() * 7 };
  if (kind === "drone") {
    target.bodyIndex = targets.filter((item) => item.kind === "drone").length;
    target.armIndex = target.bodyIndex * 2;
    setTargetInstance(targetMeshes.droneBodies, target.bodyIndex, positionX, y, z);
    for (const side of [-1, 1]) {
      setTargetInstance(targetMeshes.droneArms, target.armIndex + (side > 0 ? 1 : 0), positionX + side * 1.6, y, z);
      setTargetInstance(targetMeshes.droneLights, target.armIndex + (side > 0 ? 1 : 0), positionX + side * 2.65, y, z);
    }
  } else {
    target.beaconIndex = targets.filter((item) => item.kind === "beacon").length;
    setTargetInstance(targetMeshes.beaconStems, target.beaconIndex, positionX, y + 2.9, z);
    setTargetInstance(targetMeshes.beaconHeads, target.beaconIndex, positionX, y + 6.1, z);
  }
  targets.push(target);
}

function addMast(zoneIndex) {
  const startZ = zoneIndex * 800;
  const z = startZ + 170;
  const side = zoneIndex % 2 === 0 ? -1 : 1;
  const x = routeAt(z) + side * (canyonWidth(z) / 2 + 5);
  const instanceIndex = masts.length;
  setTargetInstance(mastInstances.feet, instanceIndex, x, 1, z);
  setTargetInstance(mastInstances.poles, instanceIndex, x, 12, z);
  setTargetInstance(mastInstances.heads, instanceIndex, x, 23, z);
  const mast = { x, z, zoneIndex, active: true, instanceIndex };
  masts.push(mast);

  const fieldZ = startZ + 505;
  const fieldWidth = canyonWidth(fieldZ) * 0.5 + 5;
  const positions = [];
  const colors = [];
  const indices = [];
  const columns = 20;
  const rows = 10;
  const tint = new THREE.Color("#61dacc");
  for (let row = 0; row <= rows; row++) {
    const v = row / rows;
    for (let col = 0; col <= columns; col++) {
      const u = -1 + 2 * col / columns;
      const xPos = routeAt(fieldZ) + u * fieldWidth;
      const archHeight = 4 + 38 * Math.sqrt(Math.max(0, 1 - u * u));
      positions.push(xPos, 1 + archHeight * v, fieldZ + Math.sin(u * 9 + v * 10) * 0.24);
      const glowAmount = 0.15 + Math.sin(Math.PI * v) * 0.8;
      colors.push(tint.r * glowAmount, tint.g * glowAmount, tint.b * glowAmount);
      if (row < rows && col < columns) {
        const a = row * (columns + 1) + col;
        const b = a + columns + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshBasicMaterial({
    color: "#91fff0", vertexColors: true, transparent: true, opacity: 0.16,
    side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const curtain = new THREE.Mesh(geometry, material);
  scene.add(curtain);
  fields.push({ mesh: curtain, material, z: fieldZ, zoneIndex, phase: zoneIndex * 1.5, collapsing: false });
}
for (let i = 0; i < 6; i++) addMast(i);
for (const mesh of Object.values(mastInstances)) mesh.instanceMatrix.needsUpdate = true;
const droneSpots = [
  [280, -18, 17], [700, 17, 14], [1110, 25, 18], [1500, -23, 15],
  [1810, 14, 16], [2280, -18, 17], [2630, 22, 14], [3180, -20, 18],
  [3500, 18, 15], [4050, -15, 17], [4390, 15, 14],
];
for (const [z, x, y] of droneSpots) addTarget("drone", z, x, y, 120);
const beaconSpots = [
  [420, -55], [930, 53], [1370, -56], [1950, 54], [2440, -55],
  [2780, 54], [3350, -55], [3680, 55], [4260, -55], [4540, 54],
];
for (const [z, x] of beaconSpots) addTarget("beacon", z, x, 1, 80);

const projectiles = [];
const projectileGeometry = new THREE.CylinderGeometry(0.11, 0.11, 3.6, 5);
projectileGeometry.rotateX(Math.PI / 2);
const projectileMaterial = new THREE.MeshBasicMaterial({ color: "#ffdf9b" });
const projectileCapacity = 48;
const projectileInstances = new THREE.InstancedMesh(projectileGeometry, projectileMaterial, projectileCapacity);
projectileInstances.frustumCulled = false;
const projectileSlots = new Uint8Array(projectileCapacity);
const projectileDummy = new THREE.Object3D();
for (let i = 0; i < projectileCapacity; i++) {
  projectileDummy.scale.setScalar(0);
  projectileDummy.updateMatrix();
  projectileInstances.setMatrixAt(i, projectileDummy.matrix);
}
projectileInstances.instanceMatrix.needsUpdate = true;
scene.add(projectileInstances);
const flashMaterial = new THREE.SpriteMaterial({ map: glowTexture, color: "#ffae56", transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending });
const explosions = [];
const explosionGeometry = new THREE.BufferGeometry();
const explosionPositions = new Float32Array(45 * 3);
explosionGeometry.setAttribute("position", new THREE.BufferAttribute(explosionPositions, 3));
const explosionPoints = new THREE.Points(explosionGeometry, new THREE.PointsMaterial({ color: "#ffd18a", size: 2.4, transparent: true, opacity: 0.9, depthWrite: false }));
scene.add(explosionPoints);

const state = {
  t: 0, speed: 0, distToB: ROUTE_LENGTH, cargo: 100, health: 100, air: AIR_MAX, score: 0,
  radiation: 0, underwater: false, phase: "title", z: 0, xOffset: 0, y: 7, targetY: 7,
};
window.__lethe = {
  state: () => ({
    t: state.t, speed: state.speed, distToB: Math.max(0, state.distToB),
    cargo: state.cargo, health: state.health, air: state.air, radiation: state.radiation, score: state.score,
    underwater: state.underwater, phase: state.phase,
  }),
};

const input = { left: 0, right: 0, up: 0, down: 0, fire: false, boost: false, tilt: false };
const keys = new Set();
let diveIntent = false;
let shotCooldown = 0;
let lastHitAt = -10;
let lastSplashAt = -10;
let startWallTime = 0;
let audioContext = null;
let geigerOsc = null;
let geigerGain = null;
let geigerTimer = 0;
let tiltBase = null;
let tiltX = 0;
let tiltY = 0;

function unlockAudio() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  if (!audioContext) audioContext = new AudioCtx();
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
}
function tone(frequency, duration, type = "sine", volume = 0.04) {
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency * (state.underwater ? 0.72 : 1), audioContext.currentTime);
  gain.gain.setValueAtTime(volume * (state.underwater ? 0.62 : 1), audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + duration);
}

function beginRun() {
  $("start").classList.add("hidden");
  $("result").classList.add("hidden");
  unlockAudio();
  if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
  state.t = 0;
  state.z = 0;
  state.xOffset = 0;
  state.y = 7;
  state.targetY = 7;
  state.speed = CRUISE;
  state.distToB = ROUTE_LENGTH;
  state.cargo = 100;
  state.health = 100;
  state.air = AIR_MAX;
  state.score = 0;
  state.radiation = 0;
  state.underwater = false;
  state.phase = "flight";
  state.damageCount = 0;
  diveIntent = false;
  shotCooldown = 0;
  startWallTime = performance.now();
  $("radiation").style.opacity = "0";
  document.body.classList.remove("underwater");
  for (const target of targets) {
    target.destroyed = false;
    target.group.visible = true;
    target.group.scale.setScalar(1);
  }
  for (const mast of masts) {
    mast.active = true;
    setTargetInstance(mastInstances.feet, mast.instanceIndex, mast.x, 1, mast.z);
    setTargetInstance(mastInstances.poles, mast.instanceIndex, mast.x, 12, mast.z);
    setTargetInstance(mastInstances.heads, mast.instanceIndex, mast.x, 23, mast.z);
  }
  for (const mesh of Object.values(mastInstances)) mesh.instanceMatrix.needsUpdate = true;
  for (const field of fields) {
    field.material.opacity = 0.16;
    field.mesh.visible = true;
    field.collapsing = false;
  }
  for (const p of projectiles) {
    projectileSlots[p.slot] = 0;
    projectileDummy.position.set(0, 0, 0);
    projectileDummy.scale.setScalar(0);
    projectileDummy.updateMatrix();
    projectileInstances.setMatrixAt(p.slot, projectileDummy.matrix);
  }
  projectileInstances.instanceMatrix.needsUpdate = true;
  projectiles.length = 0;
}

function showResult(success, reason) {
  if (state.phase !== "flight") return;
  state.phase = success ? "success" : "failed";
  $("result-title").textContent = success ? "DELIVERY COMPLETE" : "FLIGHT LOST";
  $("result-kicker").textContent = success ? "CARGO RECEIVED · WELL SETTLEMENT" : "MISSION TERMINATED · LETHE NETWORK";
  $("result-copy").textContent = success
    ? "The water reached Well. The pilot left the landing lights behind."
    : reason;
  $("result-time").textContent = fmtTime(state.t);
  $("result-cargo").textContent = `${Math.round(state.cargo)}%`;
  $("result-score").textContent = String(state.score).padStart(6, "0");
  $("result-health").textContent = `${Math.round(state.health)}%`;
  $("result").classList.remove("hidden");
  if (audioContext) tone(success ? 560 : 180, 0.5, success ? "sine" : "triangle", 0.07);
}

function addExplosion(position, mast = false) {
  const count = explosions.length;
  explosions.push({ x: position.x, y: position.y, z: position.z, age: 0, duration: mast ? 1.1 : 0.65, seed: Math.random() * 100 });
  const sprite = new THREE.Sprite(flashMaterial.clone());
  sprite.position.copy(position);
  sprite.scale.set(mast ? 12 : 6, mast ? 12 : 6, 1);
  scene.add(sprite);
  explosions[count].sprite = sprite;
  tone(mast ? 95 : 260, mast ? 0.45 : 0.16, "triangle", mast ? 0.05 : 0.025);
}

function fire() {
  if (shotCooldown > 0 || state.phase !== "flight" || state.underwater) return;
  shotCooldown = 0.22;
  for (const side of [-1, 1]) {
    const slot = projectileSlots.indexOf(0);
    if (slot < 0) break;
    projectileSlots[slot] = 1;
    const x = routeAt(state.z) + state.xOffset + side * 0.55;
    const y = state.y - 0.08;
    const z = state.z + 2.2;
    projectileDummy.position.set(x, y, z);
    projectileDummy.scale.setScalar(1);
    projectileDummy.updateMatrix();
    projectileInstances.setMatrixAt(slot, projectileDummy.matrix);
    projectiles.push({ slot, x, y, z, age: 0 });
  }
  projectileInstances.instanceMatrix.needsUpdate = true;
  tone(440, 0.07, "square", 0.018);
}

function breakMast(mast) {
  mast.active = false;
  setTargetInstance(mastInstances.feet, mast.instanceIndex, mast.x, 0, mast.z, 0);
  setTargetInstance(mastInstances.poles, mast.instanceIndex, mast.x, 0, mast.z, 0);
  setTargetInstance(mastInstances.heads, mast.instanceIndex, mast.x, 0, mast.z, 0);
  for (const mesh of Object.values(mastInstances)) mesh.instanceMatrix.needsUpdate = true;
  const field = fields.find((item) => item.zoneIndex === mast.zoneIndex);
  if (field) field.collapsing = true;
  state.score += 20;
  addExplosion(new THREE.Vector3(mast.x, 18, mast.z), true);
}

function damage(amount, kind) {
  if (state.t - lastHitAt < 0.55) return;
  lastHitAt = state.t;
  state.cargo = Math.max(0, state.cargo - amount);
  state.damageCount++;
  state.speed *= 0.64;
  state.xOffset += (state.xOffset >= 0 ? -1 : 1) * 9;
  ship.rotation.z += state.xOffset >= 0 ? 0.24 : -0.24;
  $("alert").textContent = kind === "arch" ? "ARCH STRIKE · CARGO IMPACT" : "CANYON WALL · CARGO IMPACT";
  $("alert").classList.add("show");
  setTimeout(() => $("alert").classList.remove("show"), 1300);
  tone(120, 0.28, "triangle", 0.07);
  if (state.cargo <= 0) showResult(false, "The cargo tanks failed before the ship reached Well.");
}

function spawnSpray(x, y, z, count = 12) {
  for (let i = 0; i < sprayLife.length; i++) {
    if (sprayLife[i] <= 0) {
      sprayPositions[i * 3] = x + (Math.random() - 0.5) * 2;
      sprayPositions[i * 3 + 1] = y + Math.random() * 1.8;
      sprayPositions[i * 3 + 2] = z - Math.random() * 4;
      sprayLife[i] = 0.45 + Math.random() * 0.45;
      count--;
      if (count <= 0) break;
    }
  }
  sprayGeometry.attributes.position.needsUpdate = true;
}

function updateParticles(dt) {
  const sprayAttribute = sprayGeometry.attributes.position;
  for (let i = 0; i < sprayLife.length; i++) {
    if (sprayLife[i] > 0) {
      sprayLife[i] -= dt;
      sprayAttribute.array[i * 3] += (Math.random() - 0.5) * dt * 8;
      sprayAttribute.array[i * 3 + 1] += dt * 9;
      sprayAttribute.array[i * 3 + 2] -= dt * (state.speed * 1.6);
      if (sprayLife[i] <= 0) sprayAttribute.array[i * 3 + 1] = -2000;
    }
  }
  sprayAttribute.needsUpdate = true;
  const bubbleAttribute = bubbleGeometry.attributes.position;
  if (state.underwater) {
    for (let i = 0; i < 120; i++) {
      if (bubbleAttribute.array[i * 3 + 1] < -100 || Math.random() < dt * 0.5) {
        bubbleAttribute.array[i * 3] = ship.position.x + (Math.random() - 0.5) * 5;
        bubbleAttribute.array[i * 3 + 1] = state.y + (Math.random() - 0.5) * 4;
        bubbleAttribute.array[i * 3 + 2] = state.z - Math.random() * 22;
      } else {
        bubbleAttribute.array[i * 3 + 1] += dt * 5;
        bubbleAttribute.array[i * 3 + 2] -= dt * state.speed;
      }
    }
  } else {
    for (let i = 0; i < 120; i++) bubbleAttribute.array[i * 3 + 1] = -200;
  }
  bubbleAttribute.needsUpdate = true;
  speedLines.visible = state.phase === "flight" && !state.underwater && state.speed > 45;
  speedLines.material.opacity = state.underwater ? 0 : clamp((state.speed - 35) / 90, 0, 0.45);
  for (let i = 0; i < 48; i++) {
    const offset = i * 6;
    const x = ship.position.x + (Math.sin(i * 12.989) * 0.5 + Math.sin(i * 3.7) * 0.5) * 42;
    const y = ship.position.y + (Math.cos(i * 7.21) * 0.5 + Math.sin(i * 1.9) * 0.5) * 22;
    const z = ship.position.z + 25 - (i % 8) * 2;
    speedLinePositions[offset] = x;
    speedLinePositions[offset + 1] = y;
    speedLinePositions[offset + 2] = z;
    speedLinePositions[offset + 3] = x;
    speedLinePositions[offset + 4] = y;
    speedLinePositions[offset + 5] = z - 10 - (state.speed - 35) * 0.18;
  }
  speedLineGeometry.attributes.position.needsUpdate = true;
}

function setRadiation(active) {
  $("radiation").style.opacity = active ? String(0.22 + Math.sin(state.t * 15) * 0.08) : "0";
  $("zone").textContent = active ? "UNSHIELDED · RADIATION" : "SHIELDED";
  $("zone").classList.toggle("show", active);
  $("zone").classList.toggle("danger", active);
  if (active) {
    geigerTimer -= 1 / 60;
    if (geigerTimer <= 0) {
      geigerTimer = 0.1 + Math.random() * 0.23;
      tone(900 + Math.random() * 1600, 0.025 + Math.random() * 0.035, "square", 0.009);
    }
  }
}

function updateTargetMotion(dt) {
  for (const target of targets) {
    const alive = !target.destroyed && target.group.visible;
    const y = target.y + (target.kind === "drone" ? Math.sin(state.t * 1.8 + target.phase) * 2.2 : 0);
    const x = target.kind === "drone" ? target.x + Math.sin(state.t * 0.62 + target.phase) * 4.5 : target.x;
    target.group.position.set(x, y, target.z);
    if (target.kind === "drone") {
      const visibleScale = alive ? 1 : 0;
      setTargetInstance(targetMeshes.droneBodies, target.bodyIndex, x, y, target.z, visibleScale * 1.35, visibleScale * 0.56, visibleScale * 0.82);
      for (const side of [-1, 1]) {
        const index = target.armIndex + (side > 0 ? 1 : 0);
        setTargetInstance(targetMeshes.droneArms, index, x + side * 1.6, y, target.z, visibleScale);
        setTargetInstance(targetMeshes.droneLights, index, x + side * 2.65, y, target.z, visibleScale);
      }
    } else {
      setTargetInstance(targetMeshes.beaconStems, target.beaconIndex, x, y + 2.9, target.z, alive ? 1 : 0);
      setTargetInstance(targetMeshes.beaconHeads, target.beaconIndex, x, y + 6.1, target.z, alive ? 1 : 0);
      targetMeshes.beaconHeads.setColorAt(
        target.beaconIndex,
        targetColor.setHex(Math.sin(state.t * 7 + target.phase) > 0 ? 0xff483e : 0x713a36),
      );
    }
  }
  for (const mesh of Object.values(targetMeshes)) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  for (const field of fields) {
    if (field.collapsing) {
      field.material.opacity = Math.max(0, field.material.opacity - dt * 0.24);
      if (field.material.opacity === 0) field.mesh.visible = false;
    } else if (field.material.opacity > 0.01) {
      field.material.opacity = 0.105 + (Math.sin(state.t * 2.4 + field.phase) + 1) * 0.035;
      const position = field.mesh.geometry.attributes.position;
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i);
        const y = position.getY(i);
        const u = (i % 21) / 20;
        const v = Math.floor(i / 21) / 10;
        position.setZ(i, field.z + Math.sin(u * 11 + v * 9 + state.t * 2 + field.phase) * 0.3);
      }
      position.needsUpdate = true;
    }
  }
}

function updateShots(dt) {
  shotCooldown = Math.max(0, shotCooldown - dt);
  if (input.fire || keys.has(" ") || keys.has("mouse")) fire();
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.age += dt;
    p.z += dt * 270;
    projectileDummy.position.set(p.x, p.y, p.z);
    projectileDummy.scale.setScalar(1);
    projectileDummy.updateMatrix();
    projectileInstances.setMatrixAt(p.slot, projectileDummy.matrix);
    let hit = false;
    for (const target of targets) {
      if (target.destroyed) continue;
      const dx = p.x - target.group.position.x;
      const dy = p.y - target.group.position.y;
      const dz = p.z - target.z;
      if (dx * dx + dy * dy + dz * dz < (target.kind === "drone" ? 18 : 14)) {
        target.destroyed = true;
        target.group.visible = false;
        state.score += target.score;
        addExplosion(target.group.position.clone());
        hit = true;
        break;
      }
    }
    if (!hit) {
      for (const mast of masts) {
        if (!mast.active) continue;
        const dx = p.x - mast.x;
        const dy = p.y - 15;
        const dz = p.z - mast.z;
        if (dx * dx + dy * dy + dz * dz < 19) {
          breakMast(mast);
          hit = true;
          break;
        }
      }
    }
    if (hit || p.age > 1.0) {
      projectileSlots[p.slot] = 0;
      projectileDummy.position.set(0, 0, 0);
      projectileDummy.scale.setScalar(0);
      projectileDummy.updateMatrix();
      projectileInstances.setMatrixAt(p.slot, projectileDummy.matrix);
      projectiles.splice(i, 1);
    }
  }
  projectileInstances.instanceMatrix.needsUpdate = true;
  for (let i = explosions.length - 1; i >= 0; i--) {
    const e = explosions[i];
    e.age += dt;
    e.sprite.material.opacity = Math.max(0, 0.8 * (1 - e.age / e.duration));
    const scale = 5 + e.age * 14;
    e.sprite.scale.set(scale, scale, 1);
    if (e.age >= e.duration) {
      scene.remove(e.sprite);
      explosions.splice(i, 1);
    }
  }
}

function updateHUD() {
  $("distance").textContent = (Math.max(0, state.distToB) / 1000).toFixed(1);
  $("speed").textContent = String(Math.round(state.speed * 3.6)).padStart(3, "0");
  $("cargo-text").textContent = `${Math.round(state.cargo)}%`;
  $("health-text").textContent = `${Math.round(state.health)}%`;
  $("radiation-text").textContent = state.radiation > 0 ? `${Math.round(state.radiation)}%` : "SAFE";
  $("air-text").textContent = `${Math.ceil(state.air)}s`;
  $("score").textContent = String(state.score).padStart(6, "0");
  $("cargo-bar").style.width = `${state.cargo}%`;
  $("health-bar").style.width = `${state.health}%`;
  $("radiation-bar").style.width = `${state.radiation}%`;
  $("air-bar").style.width = `${state.air / AIR_MAX * 100}%`;
  $("clock").textContent = fmtTime(state.t);
}

function updateFlight(dt) {
  if (state.phase === "landing") {
    state.t += dt;
    state.landingTime += dt;
    state.speed = Math.max(0, state.speed - dt * 10);
    state.y += (2.2 - state.y) * Math.min(1, dt * 1.8);
    ship.position.set(routeAt(state.z), state.y, state.z);
    camera.position.lerp(new THREE.Vector3(routeAt(state.z), state.y + 10, state.z - 20), Math.min(1, dt * 1.4));
    camera.lookAt(routeAt(state.z), 2, state.z + 10);
    updateHUD();
    if (state.landingTime > 1.8) showResult(true, "The water reached Well. The pilot left the landing lights behind.");
    return;
  }
  if (state.phase !== "flight") return;
  state.t += dt;
  const keyboardX = (keys.has("a") || keys.has("arrowleft") ? -1 : 0) + (keys.has("d") || keys.has("arrowright") ? 1 : 0);
  const keyboardY = (keys.has("w") || keys.has("arrowup") ? 1 : 0) + (keys.has("s") || keys.has("arrowdown") ? -1 : 0);
  const tiltMultiplier = input.tilt ? 0.8 : 0;
  const steerX = clamp(input.left + input.right + keyboardX + tiltX * tiltMultiplier, -1, 1);
  const steerY = clamp(input.up + input.down + keyboardY + tiltY * tiltMultiplier, -1, 1);
  const boost = input.boost || keys.has("shift");
  const landingSpeed = state.distToB < 180 ? Math.max(8, CRUISE * smooth(0, 180, state.distToB)) : CRUISE;
  const desiredSpeed = state.underwater ? 24 : boost ? 62 : landingSpeed;
  state.speed += (desiredSpeed - state.speed) * Math.min(1, dt * 1.7);
  state.xOffset += steerX * dt * 30;
  state.xOffset *= 1 - dt * 0.12;
  if (!diveIntent) state.targetY = 7 + steerY * 13;
  else state.targetY = -5 + steerY * 4;
  state.y += (state.targetY - state.y) * Math.min(1, dt * 3.2);
  const previousUnderwater = state.underwater;
  state.underwater = state.y < -0.15;
  if (state.underwater) state.air = Math.max(0, state.air - dt);
  else state.air = Math.min(AIR_MAX, state.air + dt * 1.7);
  if (state.air <= 0 && state.underwater) {
    diveIntent = false;
    state.health = Math.max(0, state.health - dt * 12);
    state.targetY = 7;
  }
  if (previousUnderwater !== state.underwater) {
    $("dive").classList.toggle("active", diveIntent);
    document.body.classList.toggle("underwater", state.underwater);
    if (state.underwater) {
      spawnSpray(ship.position.x, 0, state.z, 60);
      tone(190, 0.5, "sine", 0.04);
    } else {
      spawnSpray(ship.position.x, 0, state.z, 60);
      tone(360, 0.35, "sine", 0.035);
    }
  }

  const zSpeed = state.speed * (state.underwater ? 0.73 : 1);
  state.z = Math.min(ROUTE_LENGTH, state.z + dt * zSpeed);
  state.distToB = ROUTE_LENGTH - state.z;
  const centerX = routeAt(state.z);
  const halfWidth = canyonWidth(state.z) * 0.5;
  if (Math.abs(state.xOffset) > halfWidth - 12) damage(13, "wall");
  for (const arch of arches) {
    if (Math.abs(state.z - arch.z) < 8) {
      const normalizedX = Math.abs(state.xOffset) / arch.radius;
      const archBottom = arch.base + (arch.peak - arch.base) * Math.sqrt(Math.max(0, 1 - normalizedX * normalizedX));
      if (state.y + 1.2 > archBottom && normalizedX < 0.96) damage(15, "arch");
    }
  }
  const skim = !state.underwater && state.y < 2.3;
  if (skim && state.t - lastSplashAt > 0.35) {
    lastSplashAt = state.t;
    spawnSpray(centerX + state.xOffset, 0, state.z, 5);
  }
  if (state.underwater) {
    scene.fog.color.set("#164f5b");
    scene.fog.near = 75;
    scene.fog.far = 370;
    fillLight.intensity = 0.15;
    sunLight.intensity = 0.38;
    amberMat.color.set("#58f4e4");
    for (const halo of engineHalos) halo.material.color.set("#58f4e4");
    document.body.classList.add("underwater");
  } else {
    scene.fog.color.set("#d78a70");
    scene.fog.near = 270;
    scene.fog.far = 1050;
    fillLight.intensity = 0.55;
    sunLight.intensity = 2.2;
    amberMat.color.set("#ff9d45");
    for (const halo of engineHalos) halo.material.color.set("#ff963d");
    document.body.classList.remove("underwater");
  }
  ship.position.set(centerX + state.xOffset, state.y, state.z);
  ship.rotation.z += (steerX * -0.25 - ship.rotation.z) * dt * 2.6;
  ship.rotation.x += (steerY * 0.1 - ship.rotation.x) * dt * 2.1;
  diveShield.visible = state.underwater;

  const cameraTarget = new THREE.Vector3(centerX + state.xOffset * 0.72, state.y + 5.8, state.z - 16);
  const desiredCamera = new THREE.Vector3(centerX + state.xOffset * 0.9, state.y + 11.5, state.z - 24);
  camera.position.lerp(desiredCamera, Math.min(1, dt * 2.6));
  camera.lookAt(cameraTarget);
  camera.fov += ((boost ? 70 : state.underwater ? 58 : 62) - camera.fov) * Math.min(1, dt * 2.5);
  camera.updateProjectionMatrix();
  const shake = state.t - lastHitAt < 0.45 ? (Math.random() - 0.5) * 0.5 : 0;
  camera.position.x += shake;

  updateTargetMotion(dt);
  updateShots(dt);
  updateParticles(dt);
  const zone = Math.min(5, Math.floor(state.z / 800));
  const activeMast = masts[zone] && masts[zone].active;
  const radiation = !activeMast && !state.underwater;
  setRadiation(radiation);
  state.radiation = radiation ? Math.min(100, state.radiation + dt * 30) : Math.max(0, state.radiation - dt * 26);
  if (radiation) state.health = Math.max(0, state.health - dt * 5.2);
  if (state.health <= 0) showResult(false, "Radiation exposure overwhelmed the pilot outside the shielded flight corridor.");
  if (state.cargo <= 0) showResult(false, "The cargo tanks failed before the ship reached Well.");
  if (state.distToB <= 0) {
    state.speed = Math.min(state.speed, 18);
    state.phase = "landing";
    state.landingTime = 0;
    $("alert").textContent = "LANDING ZONE · WELL";
    $("alert").classList.add("show");
  }
  if (state.phase === "flight") updateHUD();
}

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (state.phase === "flight" || state.phase === "landing") updateFlight(dt);
  else {
    updateTargetMotion(dt);
    updateParticles(dt);
  }
  skyGroup.position.copy(camera.position);
  renderer.render(scene, camera);
}
animate();

function toggleDive() {
  if (state.phase !== "flight") return;
  diveIntent = !diveIntent;
  $("dive").classList.toggle("active", diveIntent);
}
function bindHold(button, key) {
  const element = $(button);
  const down = (event) => {
    event.preventDefault();
    input[key] = true;
    element.classList.add("active");
    element.setPointerCapture?.(event.pointerId);
  };
  const up = (event) => {
    event.preventDefault();
    input[key] = false;
    element.classList.remove("active");
  };
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", up);
  element.addEventListener("lostpointercapture", up);
}
bindHold("fire", "fire");
bindHold("boost", "boost");
$("dive").addEventListener("pointerdown", (event) => {
  event.preventDefault();
  toggleDive();
});

const stick = $("stick");
const knob = $("stick-knob");
let stickPointer = null;
function updateStick(event) {
  const rect = stick.getBoundingClientRect();
  const radius = Math.min(rect.width, rect.height) * 0.38;
  const dx = event.clientX - (rect.left + rect.width / 2);
  const dy = event.clientY - (rect.top + rect.height / 2);
  const length = Math.hypot(dx, dy);
  const scale = length > radius ? radius / length : 1;
  const x = dx * scale;
  const y = dy * scale;
  knob.style.transform = `translate(${x}px,${y}px)`;
  input.left = clamp(x / radius, -1, 0);
  input.right = clamp(x / radius, 0, 1);
  input.up = clamp(-y / radius, 0, 1);
  input.down = clamp(y / radius, 0, 1);
}
stick.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  stickPointer = event.pointerId;
  stick.setPointerCapture(event.pointerId);
  updateStick(event);
});
stick.addEventListener("pointermove", (event) => {
  if (event.pointerId === stickPointer) updateStick(event);
});
function releaseStick(event) {
  if (event.pointerId !== stickPointer) return;
  stickPointer = null;
  input.left = input.right = input.up = input.down = 0;
  knob.style.transform = "";
}
stick.addEventListener("pointerup", releaseStick);
stick.addEventListener("pointercancel", releaseStick);

window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  keys.add(key);
  if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) event.preventDefault();
  if (key === "c" || key === "e") {
    if (!event.repeat) toggleDive();
  }
  if (key === " " && !event.repeat) input.fire = true;
  if (key === "enter" && state.phase === "title") beginRun();
});
window.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  keys.delete(key);
  if (key === " ") input.fire = false;
});
window.addEventListener("blur", () => {
  keys.clear();
  input.fire = input.boost = false;
});
renderer.domElement.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.button === 0 && state.phase === "flight") input.fire = true;
});
window.addEventListener("pointerup", (event) => {
  if (event.pointerType === "mouse") input.fire = false;
});
$("start-button").addEventListener("click", beginRun);
$("retry").addEventListener("click", beginRun);

let tiltEnabled = false;
async function toggleTilt() {
  if (tiltEnabled) {
    tiltEnabled = false;
    input.tilt = false;
    $("tilt").textContent = "TILT: OFF";
    window.removeEventListener("deviceorientation", onOrientation);
    return;
  }
  const orientationPermission = window.DeviceOrientationEvent?.requestPermission;
  if (orientationPermission) {
    let permission;
    try {
      permission = await orientationPermission.call(window.DeviceOrientationEvent);
    } catch {
      permission = "denied";
    }
    if (permission !== "granted") {
      $("tilt").textContent = "TILT: DENIED";
      return;
    }
  }
  tiltEnabled = true;
  input.tilt = true;
  $("tilt").textContent = "TILT: ON";
  window.addEventListener("deviceorientation", onOrientation);
}
function onOrientation(event) {
  if (tiltBase === null) tiltBase = event.gamma || 0;
  tiltX = clamp(((event.gamma || 0) - tiltBase) / 24, -1, 1);
  tiltY = clamp((event.beta || 0) / 35, -1, 1);
}
$("tilt").addEventListener("click", toggleTilt);
window.addEventListener("resize", () => {
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

if (new URLSearchParams(location.search).get("autostart") === "1") beginRun();
