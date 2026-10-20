// Cheap effects: additive glow points ("bloom" sprites), CPU particles, speed streaks.
import * as THREE from 'three';

const pointVS = /* glsl */`
attribute vec4 aCol; attribute float aSize;
uniform float uScale; uniform float uFogD; uniform float uMax;
varying vec4 vCol; varying float vFog;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aSize * uScale / max(-mv.z, 0.5), uMax);
  float d = -mv.z * uFogD; vFog = exp(-d * d);
  vCol = aCol;
}`;
const glowFS = /* glsl */`
varying vec4 vCol; varying float vFog;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0; float r = dot(p, p);
  if (r > 1.0) discard;
  float a = exp(-r * 5.0) * 0.8 + exp(-r * 30.0);
  gl_FragColor = vec4(vCol.rgb * a * vCol.a * vFog, 1.0);
}`;
const softFS = /* glsl */`
uniform vec3 uFogCol;
varying vec4 vCol; varying float vFog;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0; float r = dot(p, p);
  if (r > 1.0) discard;
  float a = (1.0 - r) * (1.0 - r) * vCol.a;
  gl_FragColor = vec4(mix(uFogCol, vCol.rgb, vFog), a);
}`;

function pointsMaterial(additive, fogD) {
  return new THREE.ShaderMaterial({
    vertexShader: pointVS, fragmentShader: additive ? glowFS : softFS,
    transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { uScale: { value: 400 }, uFogD: { value: fogD }, uMax: { value: 256 }, uFogCol: { value: new THREE.Color() } },
  });
}

// immediate-mode glow sprites, rebuilt each frame
export class Glows {
  constructor(cap, fogD) {
    this.cap = cap; this.n = 0;
    this.pos = new Float32Array(cap * 3); this.col = new Float32Array(cap * 4); this.size = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aCol', this.aCol); g.setAttribute('aSize', this.aSize);
    this.mat = pointsMaterial(true, fogD);
    this.obj = new THREE.Points(g, this.mat);
    this.obj.frustumCulled = false;
    this.obj.renderOrder = 5;
  }
  begin() { this.n = 0; }
  add(x, y, z, r, g, b, a, size) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
    this.size[i] = size;
  }
  end() {
    this.obj.geometry.setDrawRange(0, this.n);
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = true;
  }
}

// simple CPU particle pool
export class Particles {
  constructor(cap, additive, fogD) {
    this.cap = cap; this.n = 0;
    this.p = new Float32Array(cap * 3); this.v = new Float32Array(cap * 3);
    this.life = new Float32Array(cap); this.max = new Float32Array(cap);
    this.s0 = new Float32Array(cap); this.s1 = new Float32Array(cap);
    this.c = new Float32Array(cap * 4); this.grav = new Float32Array(cap); this.drag = new Float32Array(cap);
    this.out = new Glows(cap, fogD);
    if (!additive) {
      this.out.mat = pointsMaterial(false, fogD);
      this.out.obj.material = this.out.mat;
      this.out.obj.renderOrder = 4;
    }
    this.obj = this.out.obj;
  }
  emit(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, grav = 0, drag = 0) {
    let i = this.n;
    if (i >= this.cap) i = (Math.random() * this.cap) | 0; else this.n++;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.life[i] = 0; this.max[i] = life; this.s0[i] = s0; this.s1[i] = s1;
    this.c[i * 4] = r; this.c[i * 4 + 1] = g; this.c[i * 4 + 2] = b; this.c[i * 4 + 3] = a;
    this.grav[i] = grav; this.drag[i] = drag;
  }
  clear() { this.n = 0; }
  update(dt) {
    const o = this.out;
    o.begin();
    for (let i = 0; i < this.n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.max[i]) {
        // swap-remove
        const j = --this.n;
        if (i !== j) {
          for (let k = 0; k < 3; k++) { this.p[i * 3 + k] = this.p[j * 3 + k]; this.v[i * 3 + k] = this.v[j * 3 + k]; }
          for (let k = 0; k < 4; k++) this.c[i * 4 + k] = this.c[j * 4 + k];
          this.life[i] = this.life[j]; this.max[i] = this.max[j]; this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j];
          this.grav[i] = this.grav[j]; this.drag[i] = this.drag[j];
        }
        i--; continue;
      }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.v[i * 3] *= d; this.v[i * 3 + 1] = this.v[i * 3 + 1] * d - this.grav[i] * dt; this.v[i * 3 + 2] *= d;
      this.p[i * 3] += this.v[i * 3] * dt; this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt; this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      const t = this.life[i] / this.max[i];
      const fade = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9;
      o.add(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2], this.c[i * 4], this.c[i * 4 + 1], this.c[i * 4 + 2],
        this.c[i * 4 + 3] * fade, this.s0[i] + (this.s1[i] - this.s0[i]) * t);
    }
    o.end();
  }
}

// wrapped dust streaks around the camera; stretched along velocity => speed lines
const streakVS = /* glsl */`
attribute vec3 aBase; attribute float aEnd;
uniform vec3 uCenter; uniform vec3 uVel; uniform float uBox; uniform float uLen;
varying float vA;
void main(){
  vec3 p = mod(aBase - uCenter, uBox) - uBox * 0.5 + uCenter;
  p -= uVel * uLen * aEnd;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = length(mv.xyz);
  vA = smoothstep(2.0, 10.0, d) * (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, d)) * (1.0 - aEnd * 0.9);
  gl_Position = projectionMatrix * mv;
}`;
const streakFS = /* glsl */`
uniform vec3 uCol; uniform float uOp; varying float vA;
void main(){ gl_FragColor = vec4(uCol * vA * uOp, 1.0); }`;
export class Streaks {
  constructor(n = 260, box = 110) {
    const base = new Float32Array(n * 6), end = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = Math.random() * box, y = Math.random() * box, z = Math.random() * box;
      base.set([x, y, z, x, y, z], i * 6);
      end[i * 2] = 0; end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(base, 3));
    g.setAttribute('aBase', new THREE.BufferAttribute(base, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: streakVS, fragmentShader: streakFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uCenter: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() }, uBox: { value: box }, uLen: { value: 0.05 },
        uCol: { value: new THREE.Color(1, 0.8, 0.6) }, uOp: { value: 0.4 } },
    });
    this.obj = new THREE.LineSegments(g, this.mat);
    this.obj.frustumCulled = false;
  }
}
