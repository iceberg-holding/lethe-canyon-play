// "Cormorant" (БАКЛАН). Round 7: the approved Blender model (assets/ship/baklan_lod0/1.glb, THREE.LOD) replaces
// the procedural hull once loaded; the procedural ship below (blunt armoured wedge nose, canopy, short thick wings,
// two rear engine pods, ~6k triangles) is shown until then and stays as the fallback if the GLB fails.
// Shared by both: energy shield bubble, exhaust plumes, dive armour, engine glow colour logic. Nose points to -Z.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { lerp, sanitizeNormals } from './util.js?v=r34';
import { shipTextures } from './textures.js?v=r34';

// loft an octagonal armoured cross-section along z
function loft(sections, prof) {
  prof = prof || [[1, 0.05], [0.8, 0.62], [0.32, 1], [-0.32, 1], [-0.8, 0.62], [-1, 0.05], [-0.78, -0.5], [-0.25, -0.7], [0.25, -0.7], [0.78, -0.5]];
  const P = prof.length, pos = [], uv = [], ix = [];
  sections.forEach((sc, i) => {
    for (let j = 0; j <= P; j++) {
      const q = prof[j % P];
      pos.push(q[0] * sc.w, sc.y + q[1] * sc.h, sc.z);
      uv.push(j / P, (sc.z + 8) / 16);
    }
  });
  const W = P + 1;
  for (let i = 0; i < sections.length - 1; i++) for (let j = 0; j < P; j++) {
    const a = i * W + j, b = a + 1, c = a + W, d = c + 1;
    ix.push(a, b, c, b, d, c);
  }
  const addCap = (i, flip) => {
    const sc = sections[i], ci = pos.length / 3;
    pos.push(0, sc.y, sc.z); uv.push(0.5, 0.5);
    for (let j = 0; j < P; j++) {
      const a = i * W + j, b = a + 1;
      if (flip) ix.push(ci, a, b); else ix.push(ci, b, a);
    }
  };
  addCap(0, false); addCap(sections.length - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(ix);
  const out = g.toNonIndexed();
  out.computeVertexNormals();
  return sanitizeNormals(out);
}
const T = (g, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  const out = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(m);
  out.deleteAttribute('normal');
  if (!out.attributes.uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(out.attributes.position.count * 2), 2));
  return out;
};
const merge = (list) => { list.forEach((x) => x.deleteAttribute('normal')); const g = mergeGeometries(list); g.computeVertexNormals(); return sanitizeNormals(g); };

function wingGeo(side) {
  const sh = new THREE.Shape();
  sh.moveTo(0, -1.9); sh.lineTo(3.4, 0.4); sh.lineTo(4.1, 1.5); sh.lineTo(4.0, 2.5); sh.lineTo(0, 3.1); sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.38, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 1 });
  g.rotateX(Math.PI / 2);
  g.translate(0, 0.19, 0);
  // UVs from planform so the panel texture lands sensibly
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 5 + 0.1, p.getZ(i) / 6 + 0.4);
  if (side < 0) {
    g.scale(-1, 1, 1);
    const ix = g.index;
    if (ix) for (let i = 0; i < ix.count; i += 3) { const t = ix.getX(i + 1); ix.setX(i + 1, ix.getX(i + 2)); ix.setX(i + 2, t); }
    else { const pp = g.attributes.position; for (let i = 0; i < pp.count; i += 3) for (let k = 0; k < 3; k++) { const t = pp.getComponent(i + 1, k); pp.setComponent(i + 1, k, pp.getComponent(i + 2, k)); pp.setComponent(i + 2, k, t); } }
  }
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return sanitizeNormals(g);
}

// warm canyon environment for metal reflections (built once into a PMREM cube)
export function makeEnvMap(renderer) {
  const sc = new THREE.Scene();
  const m = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 d; void main(){ d = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 d; void main(){ vec3 n = normalize(d);
      vec3 sky = mix(vec3(0.95,0.62,0.45), vec3(0.55,0.33,0.28), smoothstep(0.0,0.7,n.y));
      vec3 wall = mix(vec3(0.42,0.2,0.12), vec3(0.65,0.36,0.22), smoothstep(-0.1,0.35,n.y));
      vec3 c = mix(wall, sky, smoothstep(0.25,0.45,n.y));
      c = mix(c, vec3(0.08,0.35,0.36), smoothstep(-0.05,-0.25,n.y));
      c += vec3(1.6,1.2,0.8) * pow(max(dot(n, normalize(vec3(0.3,0.33,-0.9))),0.0), 60.0) * 3.0;
      gl_FragColor = vec4(c, 1.0); }`,
  }));
  sc.add(m);
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(sc, 0.02);
  pm.dispose();
  m.geometry.dispose(); m.material.dispose();
  return rt.texture;
}

const shieldVS = /* glsl */`
varying vec3 vN; varying vec3 vV; varying vec3 vL;
void main(){
  vL = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const shieldFS = /* glsl */`
uniform float uTime; uniform float uCharge; uniform float uHit; uniform float uFlash; uniform float uOn; uniform float uRegen;
uniform vec3 uHitDir; uniform vec3 uCol; uniform vec3 uHitCol;
varying vec3 vN; varying vec3 vV; varying vec3 vL;
void main(){
  vec3 L = normalize(vL);                       // per-fragment: no faceting from vertex interpolation
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);
  // hex cells in spherical coords
  vec2 p = vec2(atan(L.z, L.x) * 5.0, L.y * 9.0 + uTime * 0.4);
  vec2 r = vec2(1.0, 1.732), h = r * 0.5;
  vec2 a = mod(p, r) - h, b = mod(p - h, r) - h;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  float hex = smoothstep(0.38, 0.5, max(abs(g.x) * 0.866 + abs(g.y) * 0.5, abs(g.y)));
  float sweep = 0.5 + 0.5 * sin(L.z * 6.0 - uTime * 3.0);
  float idle = fres * (0.05 + 0.05 * hex * sweep) * uCharge;
  // impact: smooth gaussian spot + expanding ripple ring; both fade toward the face-on centre
  // so a hit never paints a flat bright disc over the ship (and back faces only get a whisper)
  float d = acos(clamp(dot(L, uHitDir), -1.0, 1.0));
  float face = (0.25 + 0.75 * fres) * (gl_FrontFacing ? 1.0 : 0.35);
  float spot = exp(-d * d * 4.5) * uHit * uHit;
  float rq = (d - (1.0 - uHit) * 1.4) * 4.0;
  float ring = exp(-rq * rq) * uHit;
  float ripple = 0.75 + 0.25 * sin(d * 22.0 - uTime * 18.0);
  vec3 col = uCol * (idle + uRegen * fres * 0.35 * (0.5 + 0.5 * hex));
  col += uHitCol * (spot * 0.55 * ripple + ring * 0.4) * face;
  col += uCol * uFlash * fres * (0.55 + 0.15 * hex);
  col *= uOn;
  col = col / (1.0 + col * 0.8);                // soft-clip: no saturated block for bloom to smear
  gl_FragColor = vec4(col, 1.0);
}`;

const plumeVS = /* glsl */`
varying vec2 vUv; varying float vVd;
void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal); vVd = abs(dot(n, normalize(cameraPosition - wp.xyz)));
  gl_Position = projectionMatrix * viewMatrix * wp; }`;
const plumeFS = /* glsl */`
uniform vec3 uCol; uniform float uTime; uniform float uPow;
varying vec2 vUv; varying float vVd;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
void main(){
  float along = 1.0 - vUv.y;               // 1 at nozzle, 0 at tip
  float n = vn(vec2(vUv.x * 10.0, along * 6.0 + uTime * 28.0));
  float a = pow(along, 1.6) * pow(vVd, 1.5) * (0.6 + 0.6 * n) * uPow;
  gl_FragColor = vec4(uCol * a, 1.0);
}`;

const GLB_URL = [new URL('../assets/ship/baklan_lod0.glb', import.meta.url).href, new URL('../assets/ship/baklan_lod1.glb', import.meta.url).href];
const MODEL_SCALE = 1.05;    // the 14.2 m model -> 14.9 body units, span 11.3 (procedural: hull 15.2 / 16.3 with barrels, span 11.4)
export const LOD_FAR = 70;   // camera distance (m) where LOD1 (~3.9k tris) takes over from LOD0 (~17k)

export class Ship {
  constructor(envMap) {
    this.group = new THREE.Group();
    const body = new THREE.Group();
    this.body = body;
    this.group.add(body);
    const tx = shipTextures(512);
    // hull materials soft-knee their output below the bloom threshold so the ship never melts into a white blob
    // (facing the sun, with spec + env reflections); only the engine discs / lamps are allowed to bloom
    const knee = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', `
        { float m = max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b));
          if (m > 0.72) gl_FragColor.rgb *= (0.72 + 0.16 * (1.0 - exp(-(m - 0.72) * 3.0))) / m; }
        #include <dithering_fragment>`);
    };
    const std = (o) => { const m = new THREE.MeshStandardMaterial({ envMap, envMapIntensity: 0.7, ...o }); m.onBeforeCompile = knee; return m; };
    const metal = std({ color: 0x8a8d91, metalness: 0.6, roughness: 0.52, map: tx.map, roughnessMap: tx.rough });
    const gun = std({ color: 0x3a3c40, metalness: 0.75, roughness: 0.38, map: tx.map });
    const dark = std({ color: 0x2a2c30, metalness: 0.5, roughness: 0.55 });
    const pale = std({ color: 0xc9cbcc, metalness: 0.35, roughness: 0.45, map: tx.map });
    const ochre = std({ color: 0xc08a30, metalness: 0.25, roughness: 0.55 });
    const glass = std({ color: 0x1b2328, metalness: 0.2, roughness: 0.06, envMapIntensity: 1.4, emissive: 0x3a1c06, emissiveIntensity: 0.4 });
    const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 0.8, 0.25) });
    this.mats = { metal, gun, dark, pale, ochre, glass, lamp };
    this.meshes = [];

    // hull: blunt armoured wedge nose, fat mid-body, tapered tail
    const hull = loft([
      { z: -7.6, w: 1.05, h: 0.36, y: -0.2 },
      { z: -7.1, w: 1.45, h: 0.58, y: -0.1 },
      { z: -5.6, w: 1.72, h: 0.82, y: 0.0 },
      { z: -3.4, w: 1.9, h: 1.0, y: 0.08 },
      { z: -0.5, w: 2.0, h: 1.15, y: 0.15 },
      { z: 2.8, w: 1.88, h: 1.08, y: 0.12 },
      { z: 5.4, w: 1.45, h: 0.84, y: 0.12 },
      { z: 6.9, w: 1.0, h: 0.56, y: 0.12 },
    ]);
    const parts = [hull];
    for (const sx of [-1, 1]) {
      // engine pods: barrel + intake cowl + rear shroud
      parts.push(T(new THREE.CylinderGeometry(1.08, 1.2, 5.4, 16), sx * 2.7, 0.0, 3.95, Math.PI / 2));
      parts.push(T(new THREE.CylinderGeometry(0.62, 1.08, 1.4, 16), sx * 2.7, 0.0, 0.55, Math.PI / 2));
      parts.push(T(new THREE.CylinderGeometry(1.28, 1.22, 1.0, 16), sx * 2.7, 0.0, 6.4, Math.PI / 2));
      // pylon joining pod to hull
      parts.push(T(new THREE.BoxGeometry(1.6, 0.6, 3.4), sx * 1.85, 0.22, 3.8));
      // dorsal armour plates on pods
      parts.push(T(new THREE.BoxGeometry(1.1, 0.18, 3.6), sx * 2.7, 1.1, 3.8));
    }
    // canted tail fins
    for (const sx of [-1, 1]) parts.push(T(new THREE.BoxGeometry(0.14, 1.25, 2.2), sx * 0.8, 1.45, 5.3, 0.5, 0, -sx * 0.45));
    // armour chin and ventral keel
    parts.push(T(new THREE.BoxGeometry(2.0, 0.3, 3.0), 0, -0.68, -5.3, 0.12));
    parts.push(T(new THREE.BoxGeometry(0.5, 0.45, 7.0), 0, -0.9, 1.4));
    const metalMesh = this.add(merge(parts), metal);

    const darkParts = [];
    for (const sx of [-1, 1]) {
      darkParts.push(T(new THREE.CylinderGeometry(1.0, 1.1, 0.9, 16, 1, true), sx * 2.7, 0, 7.1, Math.PI / 2));
      darkParts.push(T(new THREE.TorusGeometry(0.68, 0.2, 8, 18), sx * 2.7, 0, -0.15));
      // intake grille vanes
      for (let k = -2; k <= 2; k++) darkParts.push(T(new THREE.BoxGeometry(1.1, 0.06, 0.1), sx * 2.7, k * 0.2, -0.05));
      // cooling fins along the pods
      for (let k = 0; k < 4; k++) darkParts.push(T(new THREE.BoxGeometry(0.08, 0.35, 1.0), sx * (2.7 + 1.18), 0.1, 2.4 + k * 1.1));
      // side vents
      darkParts.push(T(new THREE.BoxGeometry(0.06, 0.4, 1.6), sx * 1.92, 0.1, -1.6));
      // folded landing skids
      darkParts.push(T(new THREE.BoxGeometry(0.2, 0.18, 3.2), sx * 1.2, -1.02, 0.2));
    }
    // dorsal spine, intakes, antenna
    darkParts.push(T(new THREE.BoxGeometry(0.5, 0.25, 4.2), 0, 1.3, 2.6));
    darkParts.push(T(new THREE.CylinderGeometry(0.03, 0.05, 1.6, 4), 0.4, 1.95, 3.6, -0.5));
    this.add(merge(darkParts), dark);

    // nose cannons: barrels, muzzle shrouds
    const gunParts = [];
    for (const sx of [-1, 1]) {
      gunParts.push(T(new THREE.CylinderGeometry(0.12, 0.16, 2.4, 8), sx * 0.66, -0.42, -7.7, Math.PI / 2));
      gunParts.push(T(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 8), sx * 0.66, -0.42, -8.7, Math.PI / 2));
      gunParts.push(T(new THREE.BoxGeometry(0.55, 0.4, 1.4), sx * 0.66, -0.45, -6.3));
    }
    this.add(merge(gunParts), gun);

    // light grey replacement panel, water tank belly, ochre hazard stripes
    this.add(merge([
      T(new THREE.BoxGeometry(0.06, 0.55, 2.0), -1.62, 0.15, -4.6, 0, -0.06, 0),
      T(new THREE.CapsuleGeometry(0.62, 3.4, 3, 12), 0, -0.95, 0.8, Math.PI / 2),
    ]), pale);
    this.add(merge([
      T(new THREE.BoxGeometry(0.06, 0.16, 2.6), 1.68, 0.3, -4.2, 0, 0.07, 0),
      T(new THREE.BoxGeometry(0.06, 0.16, 2.6), -1.68, -0.1, -4.2, 0, -0.07, 0),
      T(new THREE.CylinderGeometry(1.215, 1.215, 0.35, 16, 1, true), 2.7, 0, 5.2, Math.PI / 2),
      T(new THREE.CylinderGeometry(1.215, 1.215, 0.35, 16, 1, true), -2.7, 0, 5.2, Math.PI / 2),
      T(new THREE.BoxGeometry(1.0, 0.04, 0.25), 0, 1.42, 0.6),
    ]), ochre);
    // amber running-light strips (emissive, bloom)
    this.add(merge([
      T(new THREE.BoxGeometry(0.05, 0.06, 1.4), 1.75, -0.15, -5.0, 0, 0.07, 0),
      T(new THREE.BoxGeometry(0.05, 0.06, 1.4), -1.75, -0.15, -5.0, 0, -0.07, 0),
      T(new THREE.BoxGeometry(0.05, 0.05, 2.2), 2.7 + 1.22, -0.25, 4.2),
      T(new THREE.BoxGeometry(0.05, 0.05, 2.2), -2.7 - 1.22, -0.25, 4.2),
    ]), lamp);

    // canopy with frame ribs
    const canopy = loft([
      { z: -4.4, w: 0.3, h: 0.2, y: 0.95 },
      { z: -3.4, w: 0.78, h: 0.5, y: 1.08 },
      { z: -1.2, w: 0.9, h: 0.62, y: 1.16 },
      { z: 0.7, w: 0.72, h: 0.42, y: 1.12 },
    ]);
    this.add(canopy, glass);
    this.add(merge([
      T(new THREE.BoxGeometry(0.12, 0.14, 4.6), 0, 1.78, -1.8, 0.07),
      T(new THREE.TorusGeometry(0.82, 0.07, 4, 12, Math.PI), 0, 1.08, -2.6, 0, 0, 0, 1.05, 0.72, 1),
      T(new THREE.TorusGeometry(0.8, 0.07, 4, 12, Math.PI), 0, 1.08, -0.9, 0, 0, 0, 1.0, 0.74, 1),
    ]), dark);
    // dive armour: slides over the canopy
    this.shield = this.add(loft([
      { z: -4.5, w: 0.38, h: 0.25, y: 0.97 },
      { z: -3.4, w: 0.86, h: 0.57, y: 1.09 },
      { z: -1.2, w: 0.98, h: 0.7, y: 1.17 },
      { z: 0.8, w: 0.8, h: 0.48, y: 1.12 },
    ]), dark);
    this.shield.scale.set(1, 0.2, 0.25);
    this.shield.position.set(0, 0.95, 1.6);

    // wings on pivots at the root, with ochre tip marker and nav lights
    this.wings = [];
    this.navLights = [];
    for (const sx of [-1, 1]) {
      const piv = new THREE.Group();
      piv.position.set(sx * 1.6, -0.5, 0.4);
      const w = new THREE.Mesh(wingGeo(sx), metal);
      w.castShadow = true;
      this.meshes.push(w);
      piv.add(w);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 1.3), ochre);
      tip.position.set(sx * 4.0, 0.2, 1.95);
      piv.add(tip);
      const flap = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.5), dark);
      flap.position.set(sx * 1.9, 0.18, 3.0);
      piv.add(flap);
      body.add(piv);
      this.wings.push(piv);
      this.navLights.push(new THREE.Vector3(sx * 4.1, 0.2, 1.3));
    }
    this._piv = this.wings;

    // engine glow discs + iris rings + exhaust plumes
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xffa040 });
    this.plumeMat = new THREE.ShaderMaterial({
      vertexShader: plumeVS, fragmentShader: plumeFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uCol: { value: new THREE.Color(1, 0.55, 0.2) }, uTime: { value: 0 }, uPow: { value: 1 } },
    });
    this.irises = [];
    this.nozzles = [];
    this.plumes = [];
    for (const sx of [-1, 1]) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.92, 20), this.glowMat);
      disc.position.set(sx * 2.7, 0, 7.3);
      body.add(disc);
      const iris = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.15, 6, 18), dark);
      iris.position.set(sx * 2.7, 0, 7.4);
      body.add(iris);
      this.irises.push(iris);
      const pl = new THREE.Mesh(new THREE.ConeGeometry(0.85, 6, 16, 1, true), this.plumeMat);
      pl.rotation.x = Math.PI / 2;
      pl.position.set(sx * 2.7, 0, 7.4 + 3);
      body.add(pl);
      this.plumes.push(pl);
      this.nozzles.push(new THREE.Vector3(sx * 2.7, 0, 7.6));
    }
    this.muzzles = [new THREE.Vector3(-0.66, -0.42, -9.0), new THREE.Vector3(0.66, -0.42, -9.0)];

    // energy shield bubble
    this.shieldMat = new THREE.ShaderMaterial({
      vertexShader: shieldVS, fragmentShader: shieldFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 }, uCharge: { value: 1 }, uHit: { value: 0 }, uFlash: { value: 0 }, uOn: { value: 1 }, uRegen: { value: 0 },
        uHitDir: { value: new THREE.Vector3(0, 0, -1) }, uCol: { value: new THREE.Color(0.35, 0.9, 1.0) }, uHitCol: { value: new THREE.Color(1.0, 0.8, 0.45) },
      },
    });
    this.bubble = new THREE.Mesh(new THREE.SphereGeometry(1, 36, 20), this.shieldMat);
    this.bubble.scale.set(5.6, 2.9, 9.8);
    this.bubble.position.set(0, 0.15, -0.2);
    this.bubble.renderOrder = 6;
    body.add(this.bubble);

    body.traverse((o) => { if (o.isMesh && o.material !== this.shieldMat && o.material !== this.plumeMat && o.material !== this.glowMat && o.material !== lamp) { o.castShadow = true; } });
    // everything but the plumes + bubble is the procedural hull, dropped when the GLB arrives
    this._proc = body.children.filter((o) => o !== this.bubble && !this.plumes.includes(o));
    this._plumeZ = 7.4;
    this._plumeR = 1;
    this.lifts = [];                                  // ventral lift-engine glow points (GLB only)
    this.rocketPort = new THREE.Vector3(0, -1.15, -5.5);
    this.shipModel = 'procedural';
    this._env = envMap;
    this._knee = knee;
    this._tier = null;
    this._levels = [null, null];                      // built LOD0 / LOD1 groups
    this._req = [false, false];
    this.diveT = 0;
    this._amber = new THREE.Color(1.0, 0.62, 0.22);
    this._cold = new THREE.Color(0.25, 1.0, 0.92);
    this._steam = new THREE.Color(0xe8f4ff);   // round 6: water flashed to steam/plasma whitens the exhaust
    this.glowColor = new THREE.Color();
  }
  add(geo, mat) {
    const m = new THREE.Mesh(geo, mat);
    this.body.add(m);
    return m;
  }

  // ---------------------------------------------------------------- round 7: Blender model + LOD
  // main.js calls this on every quality change: LOD1 is always fetched (small), LOD0 only above 'low';
  // 'low' pins LOD1, the other tiers switch at LOD_FAR metres of camera distance
  setQuality(tier) {
    this._tier = tier;
    this._request(1);
    if (tier !== 'low') this._request(0);
    this._lodMode();
  }
  _request(i) {
    if (this._req[i]) return;
    this._req[i] = true;
    const loader = Ship.loader || (Ship.loader = new GLTFLoader());
    loader.load(GLB_URL[i], (gltf) => {
      try {
        this._levels[i] = this._build(gltf.scene);
        this._install();
      } catch (err) { console.warn('ship: GLB LOD' + i + ' not used', err); }
    }, undefined, (err) => console.warn('ship: GLB LOD' + i + ' failed to load, keeping the procedural hull', err));
  }
  // glTF material -> game look: display-referred colours (ColorManagement is off; the grade pass decodes), scene
  // env map, the same highlight soft-knee as the procedural hull; EmissiveOrange becomes the shared engine material
  _mat(m) {
    if (m.name === 'EmissiveOrange') {
      if (!this.engineMat) this.engineMat = new THREE.MeshStandardMaterial({ color: 0x1c0e06, roughness: 0.4, metalness: 0, emissive: 0xffa040, envMap: this._env, envMapIntensity: 0.3 });
      return this.engineMat;
    }
    if (m.userData.r7) return m;
    m.userData.r7 = true;
    m.color.convertLinearToSRGB();
    if (m.map) m.map.colorSpace = THREE.NoColorSpace;
    m.envMap = this._env;
    m.envMapIntensity = m.name === 'Glass' ? 1.4 : 1.0;
    // the Blender renders had a bright sky dome; our canyon env is dim, so let more diffuse through on armour
    if (m.name !== 'Glass') m.metalness *= 0.55;
    m.onBeforeCompile = this._knee;
    if (m.transparent) { m.depthWrite = false; m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2; }
    return m;
  }
  // one draw call per material: bake node transforms (into `space`) and merge
  _merged(byMat, parent) {
    for (const [mat, geos] of byMat) {
      const g = geos.length > 1 ? mergeGeometries(geos) : geos[0];
      for (const x of (g ? [g] : geos)) {
        const mesh = new THREE.Mesh(x, this._mat(mat));
        mesh.castShadow = mesh.material !== this.engineMat && !mesh.material.transparent;
        if (mesh.material.transparent) mesh.renderOrder = 1;
        parent.add(mesh);
      }
    }
  }
  _build(root) {
    root.updateMatrixWorld(true);
    const used = new Set(), M = new THREE.Matrix4(), inv = new THREE.Matrix4();
    const node = (n) => root.getObjectByName(n);
    const collect = (obj, space, byMat) => obj.traverse((o) => {
      if (!o.isMesh || used.has(o)) return;
      used.add(o);
      if (space) M.multiplyMatrices(space, o.matrixWorld); else M.copy(o.matrixWorld);
      const g = o.geometry.clone().applyMatrix4(M);
      if (!byMat.has(o.material)) byMat.set(o.material, []);
      byMat.get(o.material).push(g);
    });
    const group = new THREE.Group();
    // wings on their own pivots (node origin = root), tips -> nav lights in pivot space
    const wings = [], tips = [];
    for (const side of ['L', 'R']) {
      const wn = node('Wing_' + side), piv = new THREE.Group(), byMat = new Map();
      piv.position.setFromMatrixPosition(wn.matrixWorld);
      inv.copy(wn.matrixWorld).invert();
      collect(wn, inv, byMat);
      let ext = 0;
      for (const gs of byMat.values()) for (const g of gs) { const p = g.attributes.position; for (let k = 0; k < p.count; k++) ext = Math.max(ext, side === 'L' ? -p.getX(k) : p.getX(k)); }
      const tip = new THREE.Vector3(); let n = 0;
      for (const gs of byMat.values()) for (const g of gs) {
        const p = g.attributes.position;
        for (let k = 0; k < p.count; k++) if ((side === 'L' ? -p.getX(k) : p.getX(k)) > ext - 0.08) { tip.x += p.getX(k); tip.y += p.getY(k); tip.z += p.getZ(k); n++; }
      }
      tips.push(tip.divideScalar(n));
      this._merged(byMat, piv);
      group.add(piv);
      wings.push(piv);
    }
    // anchors (model space)
    const box = (n) => new THREE.Box3().setFromObject(node(n));
    const ctr = (b) => b.getCenter(new THREE.Vector3());
    const nozzles = ['MainNozzle_L', 'MainNozzle_R'].map(box);
    const lifts = ['LiftEngine_L', 'LiftEngine_R', 'LiftEngine_C'].map(box).map((b) => ctr(b).setY(b.min.y + 0.05));
    const guns = new Map(); collect(node('Guns'), null, guns);
    const gunGeos = [...guns.values()].flat();
    let zMin = Infinity;
    for (const g of gunGeos) { const p = g.attributes.position; for (let k = 0; k < p.count; k++) zMin = Math.min(zMin, p.getZ(k)); }
    const muz = [new THREE.Vector3(), new THREE.Vector3()], mn = [0, 0];
    for (const g of gunGeos) {
      const p = g.attributes.position;
      for (let k = 0; k < p.count; k++) if (p.getZ(k) < zMin + 0.03) { const i = p.getX(k) < 0 ? 0 : 1; muz[i].x += p.getX(k); muz[i].y += p.getY(k); muz[i].z += p.getZ(k); mn[i]++; }
    }
    muz.forEach((v, i) => v.divideScalar(mn[i] || 1).setZ(zMin - 0.1));
    const canopy = new Map(); collect(node('Canopy'), null, canopy);
    const canopyGeo = mergeGeometries([...canopy.values()].flat().map((g) => { const c = new THREE.BufferGeometry(); c.setAttribute('position', g.attributes.position); c.setAttribute('normal', g.attributes.normal); c.setIndex(g.index); return c; }));
    const tank = box('Tank');
    const bounds = new THREE.Box3().setFromObject(root);
    // the rest of the ship, merged per material
    const byMat = new Map();
    for (const [m, gs] of guns) byMat.set(m, gs.slice());
    for (const [m, gs] of canopy) byMat.set(m, (byMat.get(m) || []).concat(gs));
    collect(root, null, byMat);
    this._merged(byMat, group);
    return {
      group, wings, tips, bounds, canopyGeo, muzzles: muz, lifts,
      nozzles: nozzles.map((b) => ({ p: ctr(b).setZ(b.max.z - 0.15), exit: b.max.z, r: (b.max.x - b.min.x) / 2 })),
      rocket: ctr(tank).setY(tank.min.y - 0.1).setZ(tank.min.z + 0.8),
    };
  }
  _install() {
    const L = this._levels, first = L[0] || L[1];
    if (!first) return;
    const S = MODEL_SCALE, toBody = (v) => v.clone().multiplyScalar(S);
    if (!this.model) {
      for (const o of this._proc) { this.body.remove(o); if (o.geometry) o.geometry.dispose(); }
      this.model = new THREE.Group();
      this.model.scale.setScalar(S);
      this.body.add(this.model);
      this.lod = new THREE.LOD();
      this.model.add(this.lod);
      // anchors: engine exits, lift glows, gun tips, rocket rail, nav lights (pivot space), shield fit
      this.nozzles = first.nozzles.map((n) => toBody(n.p));
      this._plumeZ = first.nozzles[0].exit * S;
      this._plumeR = (first.nozzles[0].r * 0.8 * S) / 0.85;
      this.plumes.forEach((p, i) => p.position.set(this.nozzles[i].x, this.nozzles[i].y, this._plumeZ + 3));
      this.lifts = first.lifts.map(toBody);
      this.muzzles = first.muzzles.map(toBody);
      this.rocketPort = toBody(first.rocket);
      this.navLights = first.tips;
      const b = first.bounds, c = toBody(b.getCenter(new THREE.Vector3())), h = toBody(b.getSize(new THREE.Vector3()).multiplyScalar(0.5));
      this.bubble.scale.set(h.x * 1.02, Math.max(h.y * 1.45, 2.9), h.z * 1.17);
      this.bubble.position.copy(c);
      // dive armour: the canopy shape, a size up, dark metal; rises out of the spine behind the canopy
      const g = first.canopyGeo;
      g.computeBoundingBox();
      const cc = g.boundingBox.getCenter(new THREE.Vector3()), cs = g.boundingBox.getSize(new THREE.Vector3());
      g.translate(-cc.x, -cc.y, -cc.z).scale(1.1, 1.1, 1.05);
      this.shield = new THREE.Mesh(g, this.mats.dark);
      this.shield.castShadow = true;
      this.shield.userData = { rest: cc, h: cs.y, len: cs.z };
      this.shield.visible = false;
      this.model.add(this.shield);
      this.shipModel = 'glb';
    }
    // (re)build the LOD levels from what has loaded so far
    for (const lv of [...this.lod.levels]) this.lod.remove(lv.object);
    this.lod.levels.length = 0;
    if (L[0]) this.lod.addLevel(L[0].group, 0);
    if (L[1]) this.lod.addLevel(L[1].group, L[0] ? LOD_FAR : 0);
    this.wings = (L[0] || L[1]).wings;
    this._lodMode();
  }
  _lodMode() {
    if (!this.lod) return;
    const L = this._levels, pin = this._tier === 'low' && L[1];
    this.lod.autoUpdate = !pin;
    if (pin) { if (L[0]) L[0].group.visible = false; L[1].group.visible = true; }
  }
  // dive: 0 = flight config, 1 = submerged config (~0.4 s transition); steam 0..1 = cargo water being burned
  animate(dt, diving, boost, time, power = 1, steam = 0) {
    const target = diving ? 1 : 0;
    const k = dt / 0.4;
    this.diveT += Math.max(-k, Math.min(k, target - this.diveT));
    const d = this.diveT, e = d * d * (3 - 2 * d);
    if (this.shipModel === 'procedural') {
      this.wings[0].rotation.y = -e * 0.61;   // 35 deg sweep back
      this.wings[1].rotation.y = e * 0.61;
      this.shield.scale.set(1, lerp(0.2, 1, e), lerp(0.25, 1, e));
      this.shield.position.set(0, lerp(0.95, 0, e), lerp(1.6, 0, e));
    } else {
      // GLB: wings stay put (a sweep would cut through the lift pods); the armour shell rises out of the spine
      const a = this.shield, r = a.userData.rest;
      a.visible = e > 0.01;
      a.scale.set(lerp(0.7, 1, e), lerp(0.15, 1, e), lerp(0.3, 1, e));
      a.position.set(r.x, r.y - (1 - e) * a.userData.h * 0.45, r.z + (1 - e) * a.userData.len * 0.55);
    }
    for (const ir of this.irises) ir.scale.setScalar(lerp(1, 0.72, e));
    const flick = 0.92 + 0.08 * Math.sin(time * 60) + boost * 0.25;
    this.glowColor.copy(this._amber).lerp(this._cold, e).lerp(this._steam, steam * 0.5);
    // HDR engine discs (>1 => bloom)
    this.glowMat.color.copy(this.glowColor).multiplyScalar(flick * (1.15 + boost * 0.5) * (0.4 + 0.6 * power));
    if (this.engineMat) this.engineMat.emissive.copy(this.glowMat.color);
    this.plumeMat.uniforms.uTime.value = time;
    this.plumeMat.uniforms.uCol.value.copy(this.glowColor).multiplyScalar(1.2);
    this.plumeMat.uniforms.uPow.value = power * (0.22 + boost * 0.4) * (1 - e * 0.6);
    for (const p of this.plumes) { p.scale.set(this._plumeR, 0.7 + boost * 0.7 + 0.08 * Math.sin(time * 47), this._plumeR); p.position.z = this._plumeZ + 3 * p.scale.y; }
    this.mats.lamp.color.setRGB(1.5, 0.8, 0.25).multiplyScalar(0.8 + 0.2 * Math.sin(time * 3));
  }
}
