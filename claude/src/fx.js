// Cheap effects: additive glow points ("bloom" sprites), CPU particles, speed streaks.
import * as THREE from 'three';

const pointVS = /* glsl */`
attribute vec4 aCol; attribute float aSize;
uniform float uScale; uniform float uFogD; uniform float uMax;
varying vec4 vCol; varying float vFog; varying float vNear;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aSize * uScale / max(-mv.z, 0.5), uMax);
  float d = -mv.z * uFogD; vFog = exp(-d * d);
  vNear = smoothstep(2.5, 10.0, -mv.z);   // no giant blobs right at the lens
  vCol = aCol;
}`;
const glowFS = /* glsl */`
varying vec4 vCol; varying float vFog; varying float vNear;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0; float r = dot(p, p);
  if (r > 1.0) discard;
  float a = exp(-r * 5.0) * 0.8 + exp(-r * 30.0);
  gl_FragColor = vec4(vCol.rgb * a * vCol.a * vFog * vNear, 1.0);
}`;
const softFS = /* glsl */`
uniform vec3 uFogCol;
varying vec4 vCol; varying float vFog; varying float vNear;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0; float r = dot(p, p);
  if (r > 1.0) discard;
  float a = (1.0 - r) * (1.0 - r) * vCol.a * vNear;
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

// camera-facing glowing ribbons: bolts, tracers, targeting lasers (immediate mode)
const beamVS = /* glsl */`
attribute vec3 aA; attribute vec3 aB; attribute vec4 aQ; attribute vec4 aCol;
uniform float uFogD;
varying vec3 vQ; varying vec4 vCol; varying float vFog;
void main(){
  vec3 P = mix(aA, aB, aQ.y);
  vec3 dir = aB - aA;
  vec3 sd = cross(dir, cameraPosition - P);
  float l = length(sd);
  sd = l > 1e-5 ? sd / l : vec3(0.0, 1.0, 0.0);
  P += sd * aQ.z * aQ.x;
  vQ = vec3(aQ.xy, aQ.w); vCol = aCol;
  vec4 mv = viewMatrix * vec4(P, 1.0);
  float d = -mv.z * uFogD; vFog = exp(-d * d);
  gl_Position = projectionMatrix * mv;
}`;
const beamFS = /* glsl */`
varying vec3 vQ; varying vec4 vCol; varying float vFog;
void main(){
  float across = 1.0 - abs(vQ.x);
  float core = pow(across, 7.0) * 1.6;
  float glow = pow(across, 1.8) * 0.75;
  float along = pow(vQ.y, 0.8);
  // aQ.w > 0.5: core stays the ribbon colour (cold cyan pings). Otherwise the usual warm-white core.
  vec3 coreCol = mix(vec3(1.0, 0.97, 0.9), vCol.rgb, step(0.5, vQ.z));
  vec3 c = (vCol.rgb * glow + coreCol * core * along) * vCol.a * along * vFog;
  gl_FragColor = vec4(c, 1.0);
}`;
export class Beams {
  constructor(cap = 256, fogD = 0.002) {
    this.cap = cap; this.n = 0;
    const g = new THREE.BufferGeometry();
    this.A = new Float32Array(cap * 12); this.B = new Float32Array(cap * 12);
    this.Q = new Float32Array(cap * 16); this.C = new Float32Array(cap * 16);
    const ix = [];
    for (let i = 0; i < cap; i++) {
      const v = i * 4;
      ix.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      this.Q.set([-1, 0, 0, 0, 1, 0, 0, 0, -1, 1, 0, 0, 1, 1, 0, 0], i * 16);
    }
    g.setIndex(ix);
    this.aA = new THREE.BufferAttribute(this.A, 3).setUsage(THREE.DynamicDrawUsage);
    this.aB = new THREE.BufferAttribute(this.B, 3).setUsage(THREE.DynamicDrawUsage);
    this.aQ = new THREE.BufferAttribute(this.Q, 4).setUsage(THREE.DynamicDrawUsage);
    this.aC = new THREE.BufferAttribute(this.C, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aA); g.setAttribute('aA', this.aA); g.setAttribute('aB', this.aB);
    g.setAttribute('aQ', this.aQ); g.setAttribute('aCol', this.aC);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: beamVS, fragmentShader: beamFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uFogD: { value: fogD } },
    });
    this.obj = new THREE.Mesh(g, this.mat);
    this.obj.frustumCulled = false;
    this.obj.renderOrder = 6;
  }
  begin() { this.n = 0; }
  // tail (x0..) -> head (x1..); width in metres; colour (HDR ok)
  // coreTint 1 keeps the hot core in the ribbon colour (scanner pings). 0 is the default warm-white core.
  add(x0, y0, z0, x1, y1, z1, w, r, g, b, a, coreTint = 0) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    for (let k = 0; k < 4; k++) {
      this.A.set([x0, y0, z0], i * 12 + k * 3); this.B.set([x1, y1, z1], i * 12 + k * 3);
      this.Q[i * 16 + k * 4 + 2] = w;
      this.Q[i * 16 + k * 4 + 3] = coreTint;
      this.C.set([r, g, b, a], i * 16 + k * 4);
    }
  }
  end() {
    this.obj.geometry.setDrawRange(0, this.n * 6);
    this.aA.needsUpdate = this.aB.needsUpdate = this.aQ.needsUpdate = this.aC.needsUpdate = true;
  }
}

// pooled flying debris chunks (instanced, lit)
export class Debris {
  constructor(cap = 64) {
    this.cap = cap;
    const g = new THREE.IcosahedronGeometry(1, 0);
    g.scale(1, 0.45, 0.8);
    this.mesh = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.items = [];
    for (let i = 0; i < cap; i++) this.items.push({ on: false, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), s: 1, life: 0, hot: 0 });
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._c = new THREE.Color();
  }
  emit(p, v, size, hot) {
    let it = this.items.find((x) => !x.on);
    if (!it) it = this.items[(Math.random() * this.cap) | 0];
    it.on = true; it.p.copy(p); it.v.copy(v); it.s = size; it.life = 2.2 + Math.random(); it.hot = hot;
    it.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    it.w.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16);
  }
  clear() { for (const it of this.items) it.on = false; }
  update(dt, onTrail, onWater) {
    let n = 0;
    for (const it of this.items) {
      if (!it.on) continue;
      it.life -= dt;
      it.v.y -= 20 * dt;
      it.v.multiplyScalar(1 - 0.4 * dt);
      it.p.addScaledVector(it.v, dt);
      it.r.x += it.w.x * dt; it.r.y += it.w.y * dt; it.r.z += it.w.z * dt;
      it.hot = Math.max(0, it.hot - dt * 0.8);
      if (it.p.y < 0 && it.v.y < 0) { if (onWater) onWater(it); it.on = false; continue; }
      if (it.life <= 0) { it.on = false; continue; }
      if (onTrail && it.hot > 0.2) onTrail(it);
      this._q.setFromEuler(it.r);
      this._m.compose(it.p, this._q, this._s.setScalar(it.s * Math.min(1, it.life * 2)));
      this.mesh.setMatrixAt(n, this._m);
      const h = it.hot;
      this.mesh.setColorAt(n, this._c.setRGB(0.24 + h * 2.2, 0.22 + h * 0.9, 0.21 + h * 0.2));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// floating sunlit dust motes around the camera
const moteVS = /* glsl */`
attribute vec3 aBase; attribute float aSeed;
uniform vec3 uCenter; uniform float uBox; uniform float uTime; uniform float uScale;
varying float vA;
void main(){
  vec3 drift = vec3(sin(uTime * 0.3 + aSeed * 6.0), 0.15 * sin(uTime * 0.5 + aSeed * 9.0), cos(uTime * 0.25 + aSeed * 4.0)) * 2.0;
  vec3 p = mod(aBase + drift - uCenter, uBox) - uBox * 0.5 + uCenter;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = length(mv.xyz);
  vA = smoothstep(1.5, 6.0, d) * (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, d)) * (0.28 + 0.72 * pow(0.5 + 0.5 * sin(uTime * 1.2 + aSeed * 40.0), 5.0));
  gl_PointSize = clamp(0.09 * uScale / max(-mv.z, 0.5), 1.0, 6.0);
  gl_Position = projectionMatrix * mv;
}`;
const moteFS = /* glsl */`
uniform vec3 uCol; uniform float uOp; varying float vA;
void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float r = dot(p, p); if (r > 1.0) discard;
  gl_FragColor = vec4(uCol * (1.0 - r) * vA * uOp, 1.0); }`;
export class Motes {
  constructor(n = 600, box = 70) {
    const base = new Float32Array(n * 3), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) { base[i * 3] = Math.random() * box; base[i * 3 + 1] = Math.random() * box; base[i * 3 + 2] = Math.random() * box; seed[i] = Math.random(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(base, 3));
    g.setAttribute('aBase', new THREE.BufferAttribute(base, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: moteVS, fragmentShader: moteFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uCenter: { value: new THREE.Vector3() }, uBox: { value: box }, uTime: { value: 0 }, uScale: { value: 400 },
        uCol: { value: new THREE.Color(1.0, 0.85, 0.65) }, uOp: { value: 0.5 } },
    });
    this.obj = new THREE.Points(g, this.mat);
    this.obj.frustumCulled = false;
  }
}

// foamy V-wake on the river behind the ship (ribbon of recent positions)
const wakeVS = /* glsl */`
attribute vec2 aQ; attribute float aK;
varying vec2 vQ; varying float vK; varying float vFog;
uniform float uFogD;
void main(){ vQ = aQ; vK = aK; vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = -mv.z * uFogD; vFog = exp(-d * d); gl_Position = projectionMatrix * mv; }`;
const wakeFS = /* glsl */`
uniform float uTime;
varying vec2 vQ; varying float vK; varying float vFog;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
void main(){
  float x = abs(vQ.x), age = vQ.y;
  float n = vn(vec2(vQ.x * 7.0, age * 22.0 - uTime * 2.0)) * 0.6 + vn(vec2(vQ.x * 19.0, age * 50.0)) * 0.4;
  float edges = smoothstep(0.48, 0.78, x) * smoothstep(1.0, 0.88, x);
  edges *= 0.65 + 0.35 * sin(age * 110.0 - uTime * 5.0 + n * 4.0);
  float centre = smoothstep(0.35, 0.0, x) * (1.0 - age) * 0.8;
  float a = (edges + centre) * smoothstep(0.25, 0.65, n + 0.2) * (1.0 - age) * vK;
  gl_FragColor = vec4(vec3(0.9, 0.95, 0.93), clamp(a, 0.0, 1.0) * 0.75 * vFog);
}`;
export class Wake {
  constructor(n = 48) {
    this.n = n; this.pts = []; this.t = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 2 * 3); this.q = new Float32Array(n * 2 * 2); this.k = new Float32Array(n * 2);
    const ix = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2; ix.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(ix);
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aQ = new THREE.BufferAttribute(this.q, 2).setUsage(THREE.DynamicDrawUsage);
    this.aK = new THREE.BufferAttribute(this.k, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aQ', this.aQ); g.setAttribute('aK', this.aK);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: wakeVS, fragmentShader: wakeFS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uFogD: { value: 0.002 } },
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    this.obj = new THREE.Mesh(g, this.mat);
    this.obj.frustumCulled = false;
    this.obj.renderOrder = 2;
    this.life = 2.1;
  }
  clear() { this.pts.length = 0; }
  // x,z = ship position, rx,rz = right vector, k = strength 0..1
  update(dt, x, z, rx, rz, k) {
    this.t += dt;
    for (const p of this.pts) p.age += dt;
    while (this.pts.length && this.pts[this.pts.length - 1].age > this.life) this.pts.pop();
    if (this.t > 0.035) {
      this.t = 0;
      this.pts.unshift({ x, z, rx, rz, k, age: 0 });
      if (this.pts.length > this.n) this.pts.pop();
    } else if (this.pts.length) { const p = this.pts[0]; p.x = x; p.z = z; p.k = k; }
    const m = this.pts.length;
    for (let i = 0; i < this.n; i++) {
      const p = this.pts[Math.min(i, m - 1)];
      for (let s = 0; s < 2; s++) {
        const o = (i * 2 + s);
        if (!p) { this.k[o] = 0; continue; }
        const w = 1.6 + p.age * 11;
        const sd = s ? 1 : -1;
        this.pos[o * 3] = p.x + p.rx * w * sd; this.pos[o * 3 + 1] = 0.07; this.pos[o * 3 + 2] = p.z + p.rz * w * sd;
        this.q[o * 2] = sd; this.q[o * 2 + 1] = p.age / this.life;
        this.k[o] = i < m ? p.k : 0;
      }
    }
    this.aPos.needsUpdate = this.aQ.needsUpdate = this.aK.needsUpdate = true;
  }
}
