// Post-processing chain + adaptive quality tiers.
// RenderPass -> UnrealBloomPass -> GradePass (display->linear, warm/teal grade, vignette, grain) -> OutputPass (ACES + sRGB).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.035 }, uVig: { value: 0.32 },
    uTint: { value: new THREE.Vector3(0, 0, 0) }, uTintK: { value: 0 }, uExpo: { value: 1.08 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse; uniform float uTime; uniform float uGrain; uniform float uVig; uniform vec3 uTint; uniform float uTintK; uniform float uExpo;
varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  // scene colours are authored display-referred: decode to linear for the filmic curve
  c = pow(max(c, 0.0), vec3(2.2)) * uExpo;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // split-tone: teal shadows, warm ochre highlights
  vec3 sh = vec3(0.92, 1.0, 1.06), hi = vec3(1.06, 1.0, 0.9);
  c *= mix(sh, hi, smoothstep(0.02, 0.5, l));
  // gentle saturation lift
  c = mix(vec3(l), c, 1.08);
  c = mix(c, uTint, uTintK);
  // vignette
  vec2 q = vUv - 0.5;
  c *= 1.0 - uVig * smoothstep(0.25, 0.85, dot(q, q) * 2.2);
  // film grain
  c += (h(vUv * 1000.0 + fract(uTime) * 91.0) - 0.5) * uGrain * (0.25 + l);
  gl_FragColor = vec4(max(c, 0.0), 1.0);
}`,
};

export const TIERS = {
  low: { name: 'low', post: false, bloomHalf: true, shadows: false, grain: false, dpr: 1.0, detail: false, glintK: 0.7 },
  med: { name: 'med', post: true, bloomHalf: true, shadows: false, grain: false, dpr: 1.25, detail: true, glintK: 1 },
  high: { name: 'high', post: true, bloomHalf: false, shadows: true, grain: true, dpr: 1.5, detail: true, glintK: 1 },
};
const ORDER = ['low', 'med', 'high'];

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 1.0);
    this.grade = new ShaderPass(GradeShader);
    this.output = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);
    this.composer.addPass(this.output);
    this.tier = null;
  }
  apply(tier, w, h, deviceDpr) {
    const T = TIERS[tier];
    this.tier = T;
    const r = this.renderer;
    const dpr = Math.min(deviceDpr, T.dpr);
    r.setPixelRatio(dpr);
    r.setSize(w, h);
    if (T.post) {
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = 1.0;
      r.outputColorSpace = THREE.SRGBColorSpace;
    } else {
      r.toneMapping = THREE.NoToneMapping;
      r.outputColorSpace = THREE.LinearSRGBColorSpace;
    }
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    const bs = T.bloomHalf ? 0.5 : 1;
    this.bloom.resolution.set(w * dpr * bs, h * dpr * bs);
    this.bloom.setSize(Math.round(w * dpr * bs), Math.round(h * dpr * bs));
    this.grade.uniforms.uGrain.value = T.grain ? 0.03 : 0;
    r.shadowMap.enabled = T.shadows;
  }
  resize(w, h, deviceDpr) { if (this.tier) this.apply(this.tier.name, w, h, deviceDpr); }
  render(time) {
    if (this.tier.post) {
      this.grade.uniforms.uTime.value = time;
      this.composer.render();
    } else this.renderer.render(this.scene, this.camera);
  }
}

// rolling-window fps governor with hysteresis
export class QualityGovernor {
  constructor(start, locked, onChange) {
    this.idx = ORDER.indexOf(start); this.locked = locked; this.onChange = onChange;
    this.acc = 0; this.n = 0; this.hold = 3; this.good = 0; this.max = 2;
  }
  get name() { return ORDER[this.idx]; }
  frame(dt) {
    if (this.locked || document.hidden) return;
    if (this.hold > 0) { this.hold -= dt; return; }
    this.acc += dt; this.n++;
    if (this.acc < 2.5) return;
    const fps = this.n / this.acc;
    this.acc = 0; this.n = 0;
    if (fps < 45 && this.idx > 0) { this.idx--; this.good = 0; this.hold = 3; this.onChange(this.name, fps); }
    else if (fps > 58 && this.idx < this.max) {
      if (++this.good >= 3) { this.idx++; this.good = 0; this.hold = 3; this.onChange(this.name, fps); }
    } else this.good = 0;
  }
}
