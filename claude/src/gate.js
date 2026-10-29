// Round 16: the LETHE gate — the mission finale. A steel frame spans the canyon with a red energy curtain hung from it.
// Round 26: the curtain is indestructible. Three antennas on top of the beam modulate it — knock all three down and a
// breach (a notch from the riverbed up) opens for a few seconds. Two gun pods under the beam guard the approach.
// Built once in the gate's local frame: x = lateral (right +), y = height above the river, -z = toward settlement B.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { colored, tr } from './naval.js?v=r31';
import { frame, wallLat, riverHalf, GATE_S, GATE_BEAM } from './world.js?v=r31';

export const ANT_HP = 8;                // cannon bolt = 1, rocket = 8 (one rocket per antenna)
export const ANT_H = 13, ANT_Y = 10.5;   // mast height above the housing; emitter ring height above the beam top
export const GATE_ANTENNAS = [-0.74, 0, 0.74];   // lat as a fraction of the river half-width
export const GATE_GUNS = [-0.86, 0.86];
export const BREACH_HW = 14, BREACH_TOP = 28;   // breach notch: half-width (m) and top height above the water (m)

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
  // round 26: the static antenna housings and gun mounts are merged into the frame (fewer draw calls)
  const top = GATE_BEAM + 2.9;
  for (const k of GATE_ANTENNAS) {
    const x = k * wr;
    box(4.2, 2.6, 4.2, x, top + 1.3, 0, dark);
    box(4.6, 0.5, 4.6, x, top + 2.7, 0, steel);
    box(4.3, 0.7, 0.2, x, top + 1.4, 2.15, hazard);
  }
  for (const k of GATE_GUNS) {
    const x = k * wr, y = GATE_BEAM - 6.3;
    box(1.2, 3.2, 1.2, x, y + 1.6, 0, dark);
    frameParts.push(colored(tr(new THREE.CylinderGeometry(1.6, 1.9, 1.6, 10), x, y - 0.2, 0), steel));
  }
  const frameMesh = new THREE.Mesh(mergeGeometries(frameParts), new THREE.MeshLambertMaterial({ vertexColors: true }));
  group.add(frameMesh);
  // lamps (emissive look via a basic material)
  const lampParts = [];
  for (let x = -WL + 3; x <= WL - 3; x += 9) lampParts.push(colored(tr(new THREE.BoxGeometry(0.9, 0.5, 0.4), x, GATE_BEAM - 3.3, -2.8), red));
  const lamps = new THREE.Mesh(mergeGeometries(lampParts), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false }));
  group.add(lamps);

    // round 26: three relay antennas on top of the beam (they modulate the field: all three down = a breach opens).
  // Each: armoured base housing, a tapered lattice mast with cross-arms, a glowing amber emitter ring (the target)
  // and a blinking tip. The upper part is its own group so it can be knocked down and rebooted.
  const amber = [2.6, 1.15, 0.28];
  const antennas = GATE_ANTENNAS.map((k) => {
    const lat = k * wr;
    const mast = [], glow = [];
    mast.push(colored(tr(new THREE.CylinderGeometry(0.26, 0.6, ANT_H, 6), 0, 2.9 + ANT_H / 2, 0), steel));
    for (const [y, w] of [[5.5, 5.2], [9.5, 3.8], [12.6, 2.6]]) {
      mast.push(colored(tr(new THREE.BoxGeometry(w, 0.32, 0.32), 0, y, 0), steel));
      mast.push(colored(tr(new THREE.BoxGeometry(0.3, 1.1, 0.3), -w / 2, y - 0.4, 0), dark));
      mast.push(colored(tr(new THREE.BoxGeometry(0.3, 1.1, 0.3), w / 2, y - 0.4, 0), dark));
    }
    // diagonal guy struts from the housing to the mast
    for (const sx of [-1, 1]) mast.push(colored(tr(new THREE.BoxGeometry(0.22, 6.2, 0.22), sx * 1.15, 5.4, 0, 0, 0, sx * 0.36), dark));
    mast.push(colored(tr(new THREE.CylinderGeometry(1.25, 1.25, 1.1, 10), 0, ANT_Y, 0), dark));
    glow.push(colored(tr(new THREE.TorusGeometry(1.9, 0.38, 6, 18), 0, ANT_Y, 0, Math.PI / 2), amber));
    glow.push(colored(tr(new THREE.TorusGeometry(1.9, 0.22, 5, 18), 0, ANT_Y, 0), amber));
    for (const [y, w] of [[5.5, 5.2], [9.5, 3.8]]) for (const sx of [-1, 1]) glow.push(colored(tr(new THREE.BoxGeometry(0.42, 0.42, 0.42), sx * w / 2, y - 1.05, 0), [2.4, 0.3, 0.12]));
    const g = new THREE.Group();
    g.position.set(lat, top, 0);
    const up = new THREE.Group();
    up.add(new THREE.Mesh(mergeGeometries(mast), frameMesh.material));
    const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false, transparent: true });
    const ring = new THREE.Mesh(mergeGeometries(glow), glowMat);
    up.add(ring);
    const tip = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.5, 0.25), fog: false, toneMapped: false }));
    tip.position.y = 2.9 + ANT_H + 0.4;
    up.add(tip);
    g.add(up);
    group.add(g);
    return { g, up, ring, glowMat, tip, lat, y: top + ANT_Y, tipY: top + 2.9 + ANT_H + 0.4 };
  });

  // two armoured gun pods hung under the beam (part of the gate; they keep firing during the breach attempt)
  const guns = GATE_GUNS.map((k) => {
    const lat = k * wr;
    const g = new THREE.Group();
    g.position.set(lat, GATE_BEAM - 6.3, 0);
    const head = new THREE.Group();
    head.position.y = -1.2;
    const hp = [];
    hp.push(colored(tr(new THREE.SphereGeometry(1.5, 10, 8), 0, 0, 0), dark));
    hp.push(colored(tr(new THREE.CylinderGeometry(0.22, 0.26, 3.4, 6), -0.5, 0, 1.9, Math.PI / 2), steel));
    hp.push(colored(tr(new THREE.CylinderGeometry(0.22, 0.26, 3.4, 6), 0.5, 0, 1.9, Math.PI / 2), steel));
    head.add(new THREE.Mesh(mergeGeometries(hp), frameMesh.material));
    head.add(new THREE.Mesh(colored(tr(new THREE.BoxGeometry(0.9, 0.34, 0.24), 0, 0.35, 1.45), [2.6, 0.3, 0.12]), lamps.material));
    g.add(head);
    group.add(g);
    return { g, head, lat, y: GATE_BEAM - 7.5 };
  });

  // energy curtain: additive red field with hex cells, scanlines and ripples around hits
  const ch = GATE_BEAM - 3 + 11;
  const curtainMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uTime: { value: 0 }, uAlpha: { value: 1 }, uHit: { value: new THREE.Vector3(0, 0, -9) }, uFog: { value: fogD },
      uGap: { value: new THREE.Vector4(0, BREACH_HW, BREACH_TOP, 0) }, uOff: { value: 0 } },
    vertexShader: `varying vec2 vP; varying float vD;
      void main(){ vP = position.xy; vec4 mv = modelViewMatrix * vec4(position,1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uTime, uAlpha, uFog, uOff; uniform vec3 uHit; uniform vec4 uGap; varying vec2 vP; varying float vD;
      float hexd(vec2 p){ p = abs(p); return max(dot(p, vec2(0.866, 0.5)), p.y); }
      void main(){
        vec2 q = vP * 0.32; vec2 r = vec2(1.0, 1.732); vec2 h = r * 0.5;
        vec2 a = mod(q, r) - h, b = mod(q - h, r) - h; vec2 g = dot(a,a) < dot(b,b) ? a : b;
        float edge = smoothstep(0.38, 0.5, hexd(g));
        float scan = 0.5 + 0.5 * sin(vP.y * 1.6 - uTime * 6.0);
        float wave = 0.5 + 0.5 * sin(vP.x * 0.25 + uTime * 1.7 + sin(vP.y * 0.2 + uTime));
        // round 26 breach: a notch from the bottom of the curtain up to uGap.z, half-width uGap.y * open, with a ragged
        // hex-cell edge that flickers and a hot rim
        float gd = 1e3;
        if (uGap.w > 0.001) {
          vec2 cid = floor(q * 1.15);
          float jit = fract(sin(dot(cid, vec2(12.9898, 78.233))) * 43758.5453);
          float hw = uGap.y * uGap.w, tp = mix(-11.0, uGap.z, min(1.0, uGap.w * 1.4));
          gd = max(abs(vP.x - uGap.x) - hw, vP.y + uOff - tp) + (jit - 0.5) * 2.2 * (0.6 + 0.4 * sin(uTime * 9.0 + jit * 6.0));
          if (gd < 0.0) discard;
        }
        float rim = uGap.w > 0.001 ? exp(-gd * 0.55) * (2.2 + 0.8 * sin(uTime * 23.0)) : 0.0;
        float hit = uHit.z > 0.0 ? exp(-length(vP - uHit.xy) * 0.18) * uHit.z : 0.0;
        float k = 0.10 + edge * 0.55 + scan * 0.08 + wave * 0.1 + hit * 1.6 + rim;
        float under = vP.y < 0.0 ? 0.55 : 1.0;
        float fogK = exp(-uFog * uFog * vD * vD * 0.6);
        gl_FragColor = vec4(vec3(1.0, 0.22, 0.09) * k * uAlpha * under * fogK, 1.0);
      }`,
  });
  const curtain = new THREE.Mesh(new THREE.PlaneGeometry(2 * WL + 6, ch, 1, 1), curtainMat);
  curtain.position.set(0, -11 + ch / 2, 0.2);
  curtain.renderOrder = 5;
  curtainMat.uniforms.uOff.value = curtain.position.y;
  group.add(curtain);
  return { group, frameMesh, lamps, curtain, curtainMat, antennas, guns, WL, curtainTop: -11 + ch };
}
