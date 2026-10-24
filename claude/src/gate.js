// Round 16: the LETHE gate — the mission finale. A steel frame spans the canyon with a red energy curtain hung from it;
// three generator cores (two in the air on struts from the beam, one underwater on a riverbed pedestal) keep it up.
// Built once in the gate's local frame: x = lateral (right +), y = height above the river, -z = toward settlement B.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { colored, tr } from './naval.js';
import { frame, wallLat, riverHalf, GATE_S, GATE_BEAM } from './world.js';

export const CORE_HP = 22;
// lat as a fraction of the river half-width; y in metres
export const GATE_CORES = [
  { latK: -0.46, y: 13, under: false },
  { latK: 0.46, y: 25, under: false },
  { latK: 0.0, y: -5.2, under: true },
];

export function buildGate(scene, fogD) {
  const F = frame(GATE_S, {});
  const wr = riverHalf(GATE_S);
  const WL = Math.max(wallLat(GATE_S, GATE_BEAM, 1), wallLat(GATE_S, GATE_BEAM, -1));
  const group = new THREE.Group();
  group.position.set(F.x, 0, F.z);
  group.rotation.y = -F.th;
  scene.add(group);

  const steel = [0.24, 0.22, 0.21], dark = [0.13, 0.12, 0.12], hazard = [0.62, 0.36, 0.12], red = [2.4, 0.25, 0.12];
  const frameParts = [];
  const box = (w, h, d, x, y, z, c, rx = 0, ry = 0, rz = 0) => frameParts.push(colored(tr(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz), c));
  // main beam (into both walls) with a lower flange, hazard stripes and a row of red warning lamps
  const bw = 2 * WL + 14;
  box(bw, 4.6, 4.2, 0, GATE_BEAM, 0, steel);
  box(bw, 1.0, 5.4, 0, GATE_BEAM - 2.6, 0, dark);
  box(bw, 1.0, 5.4, 0, GATE_BEAM + 2.6, 0, dark);
  for (let x = -WL; x <= WL; x += 6) box(2.6, 2.2, 0.2, x, GATE_BEAM, -2.2, hazard, 0, 0, 0.6);
  // wall anchors: massive blocks pressed into the rock on both sides
  for (const side of [-1, 1]) {
    for (const y of [6, 22, 38]) {
      const wl = wallLat(GATE_S, y, side);
      box(10, 14, 9, side * (wl + 2), y, 0, steel);
      box(10.4, 1.2, 9.4, side * (wl + 2), y + 6.6, 0, dark);
    }
    const wl = wallLat(GATE_S, GATE_BEAM, side);
    box(9, 9, 10, side * (wl + 1), GATE_BEAM, 0, dark);
    // diagonal brace from the beam down to the upper anchor
    const wb = wallLat(GATE_S, 30, side);
    box(1.6, 20, 1.6, side * (wb - 4), 37, 0, steel, 0, 0, side * 0.5);
  }
  // emitter rails along the curtain edges (bottom one sits just under the water line)
  box(bw - 10, 0.8, 0.8, 0, -1.2, 0, dark);
  const frameMesh = new THREE.Mesh(mergeGeometries(frameParts), new THREE.MeshLambertMaterial({ vertexColors: true }));
  group.add(frameMesh);
  // lamps (emissive look via a basic material)
  const lampParts = [];
  for (let x = -WL + 3; x <= WL - 3; x += 9) lampParts.push(colored(tr(new THREE.BoxGeometry(0.9, 0.5, 0.4), x, GATE_BEAM - 3.3, -2.8), red));
  const lamps = new THREE.Mesh(mergeGeometries(lampParts), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false }));
  group.add(lamps);

  // generator cores: strut (or pedestal) + armour collar + glowing sphere; each is its own small group so it can be hidden
  const cores = GATE_CORES.map((c) => {
    const lat = c.latK * wr;
    const parts = [];
    if (c.under) {
      parts.push(colored(tr(new THREE.CylinderGeometry(0.9, 1.6, 6, 8), 0, -8.2 - c.y, 0), dark));
      parts.push(colored(tr(new THREE.CylinderGeometry(2.2, 2.6, 1.2, 10), 0, -11 - c.y + 0.6, 0), steel));
    } else {
      const top = GATE_BEAM - 2.6;
      parts.push(colored(tr(new THREE.CylinderGeometry(0.42, 0.42, top - c.y - 2, 6), 0, (top - c.y) / 2 + 1, 0), steel));
    }
    parts.push(colored(tr(new THREE.TorusGeometry(2.5, 0.5, 6, 16), 0, 0, 0), dark));
    parts.push(colored(tr(new THREE.TorusGeometry(2.5, 0.5, 6, 16), 0, 0, 0, 0, Math.PI / 2), dark));
    parts.push(colored(tr(new THREE.CylinderGeometry(0.7, 0.9, 1.4, 8), 0, 2.6, 0), steel));
    parts.push(colored(tr(new THREE.CylinderGeometry(0.9, 0.7, 1.4, 8), 0, -2.6, 0), steel));
    const g = new THREE.Group();
    g.position.set(lat, c.y, 0);
    g.add(new THREE.Mesh(mergeGeometries(parts), frameMesh.material));
    const glow = new THREE.Mesh(new THREE.IcosahedronGeometry(1.85, 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.5, 0.18), fog: false, toneMapped: false }));
    g.add(glow);
    group.add(g);
    return { g, glow, lat, y: c.y, under: c.under };
  });

  // energy curtain: additive red field with hex cells, scanlines and ripples around hits
  const ch = GATE_BEAM - 3 + 11;
  const curtainMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uTime: { value: 0 }, uAlpha: { value: 1 }, uHit: { value: new THREE.Vector3(0, 0, -9) }, uFog: { value: fogD } },
    vertexShader: `varying vec2 vP; varying float vD;
      void main(){ vP = position.xy; vec4 mv = modelViewMatrix * vec4(position,1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uTime, uAlpha, uFog; uniform vec3 uHit; varying vec2 vP; varying float vD;
      float hexd(vec2 p){ p = abs(p); return max(dot(p, vec2(0.866, 0.5)), p.y); }
      void main(){
        vec2 q = vP * 0.32; vec2 r = vec2(1.0, 1.732); vec2 h = r * 0.5;
        vec2 a = mod(q, r) - h, b = mod(q - h, r) - h; vec2 g = dot(a,a) < dot(b,b) ? a : b;
        float edge = smoothstep(0.38, 0.5, hexd(g));
        float scan = 0.5 + 0.5 * sin(vP.y * 1.6 - uTime * 6.0);
        float wave = 0.5 + 0.5 * sin(vP.x * 0.25 + uTime * 1.7 + sin(vP.y * 0.2 + uTime));
        float hit = uHit.z > 0.0 ? exp(-length(vP - uHit.xy) * 0.18) * uHit.z : 0.0;
        float k = 0.10 + edge * 0.55 + scan * 0.08 + wave * 0.1 + hit * 1.6;
        float under = vP.y < 0.0 ? 0.55 : 1.0;
        float fogK = exp(-uFog * uFog * vD * vD * 0.6);
        gl_FragColor = vec4(vec3(1.0, 0.22, 0.09) * k * uAlpha * under * fogK, 1.0);
      }`,
  });
  const curtain = new THREE.Mesh(new THREE.PlaneGeometry(2 * WL + 6, ch, 1, 1), curtainMat);
  curtain.position.set(0, -11 + ch / 2, 0.2);
  curtain.renderOrder = 5;
  group.add(curtain);
  return { group, frameMesh, lamps, curtain, curtainMat, cores, WL };
}
