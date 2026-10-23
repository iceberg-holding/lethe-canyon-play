
// Shared instanced water effects: fixed draw budget, no per-boat lights or textures.
import * as THREE from 'three';
const NOISE = `float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+1.0),f.x),f.y);}`;
export const WAKE_W = 30;
export function buildBoatFX(n) {
  const make = (name, geometry, fragment, uniforms = {}, onWater = true) => {
    // water decals are pulled toward the camera in depth so distant wakes do not z-fight the waves
    const material = new THREE.ShaderMaterial({ transparent:true, depthWrite:false, side:THREE.DoubleSide, blending:THREE.AdditiveBlending, uniforms,
      polygonOffset:onWater, polygonOffsetFactor:onWater?-4:0, polygonOffsetUnits:onWater?-60:0,
      vertexShader:`varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);}`,
      fragmentShader:`uniform float uTime, uL, uW; varying vec2 vUv; ${NOISE} void main(){${fragment}}` });
    const mesh = new THREE.InstancedMesh(geometry, material, n); mesh.name=name; mesh.frustumCulled=false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  };
  // Wake plane starts at the bow; z = metres behind the bow, x = metres across.
  // Kelvin V arms spread from the bow at ~20 degrees, a churned foam band trails the stern.
  const wakeU = { uTime:{value:0}, uL:{value:60}, uW:{value:WAKE_W} };
  return {
    wake:make('boat-wake',new THREE.PlaneGeometry(1,1).rotateX(-Math.PI/2),`
      float z=(1.0-vUv.y)*uL, x=abs(vUv.x-0.5)*uW, fade=pow(1.0-z/uL,1.3);
      float churn=n(vec2(x*0.9,z*0.45-uTime*2.6))*0.6+n(vec2(x*2.7,z*1.3-uTime*4.0))*0.4;
      float arm=exp(-pow((x-(2.0+z*0.36))/(1.0+z*0.07),2.0))*(0.5+0.8*churn);
      float sheen=(1.0-smoothstep(0.0,2.2+z*0.4,x))*0.22;
      float hb=2.0+max(0.0,z-12.0)*0.14;
      float band=smoothstep(10.0,14.0,z)*(1.0-smoothstep(hb*0.55,hb,x))*smoothstep(0.25,0.6,churn+0.15);
      float a=(arm*1.5+band*1.5+sheen)*fade*smoothstep(0.0,1.5,z);
      gl_FragColor=vec4(vec3(0.9,0.97,1.0),clamp(a,0.0,1.0));`, wakeU),
    bow:make('boat-bow-wave',new THREE.PlaneGeometry(1,1).rotateX(-Math.PI/2),`vec2 p=(vUv-0.5)*2.0; float r=length(p); float c=n(p*5.0+uTime*3.0);float a=(1.0-smoothstep(0.5,1.0,r+c*0.25))*smoothstep(0.1,0.4,r);gl_FragColor=vec4(vec3(1.0),a);`, wakeU),
    beam:make('boat-searchlight',new THREE.ConeGeometry(1,1,12,1,true).translate(0,-0.5,0).rotateX(Math.PI/2),`float a=pow(vUv.y,0.4)*(1.0-vUv.y)*0.12;gl_FragColor=vec4(0.85,0.9,1.0,a);`, {}, false),
    pool:make('boat-light-pool',new THREE.PlaneGeometry(1,1).rotateX(-Math.PI/2),`float r=length((vUv-0.5)*2.0);gl_FragColor=vec4(0.85,0.9,1.0,pow(max(0.0,1.0-r),2.0)*0.35);`),
  };
}

// Round 12: the boat seen from below. Both meshes sit just under the water surface and are shown only while the
// camera is underwater. They use the scene's own underwater fog (uFogD = the unchanged FOG_D_WATER), so the murk
// stays exactly as it was: they only add light *around* the hull, which then reads as a dark silhouette.
//  - under: Snell's-window glow patch around the hull + moving caustic ripples + wake turbulence behind the stern
//  - wash:  churning propeller-bubble band trailing the stern
export function buildBoatUnderFX(n, fogD) {
  const make = (name, fragment) => {
    const material = new THREE.ShaderMaterial({ transparent:true, depthWrite:false, side:THREE.DoubleSide, blending:THREE.AdditiveBlending,
      uniforms:{ uTime:{value:0}, uFogD:{value:fogD} },
      vertexShader:`varying vec2 vUv; varying float vFog; uniform float uFogD;
        void main(){vUv=uv; vec4 mv=modelViewMatrix*instanceMatrix*vec4(position,1.0); float d=-mv.z*uFogD; vFog=exp(-d*d); gl_Position=projectionMatrix*mv;}`,
      fragmentShader:`uniform float uTime; varying vec2 vUv; varying float vFog; ${NOISE} void main(){${fragment}}` });
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1).rotateX(-Math.PI/2), material, n);
    mesh.name=name; mesh.frustumCulled=false; mesh.renderOrder=3; mesh.visible=false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const z=new THREE.Matrix4().makeScale(0,0,0); for(let i=0;i<n;i++) mesh.setMatrixAt(i,z);
    return mesh;
  };
  return {
    // plane 44 m across x 80 m long, centred 18 m behind the hull centre: hull centre at (x 0, z -18), stern wake toward +z
    under:make('boat-under-glow',`
      vec2 q=vec2((vUv.x-0.5)*44.0,(0.5-vUv.y)*80.0+18.0);   // metres: q.y = along the hull (bow -7, stern +7)
      vec2 e=vec2(q.x,q.y*0.62);
      float r=length(e);
      float glow=exp(-r*r/150.0);                              // Snell's-window light pooling around the hull
      vec2 p=q*0.32;
      float c1=n(p+vec2(uTime*0.35,uTime*0.2)), c2=n(p*1.7-vec2(uTime*0.25,-uTime*0.3));
      float caust=pow(1.0-abs(c1-c2),7.0);                     // moving caustic ripples
      float zw=q.y-7.0, wide=2.5+max(zw,0.0)*0.28;
      float churn=n(vec2(q.x*0.45,zw*0.35-uTime*3.0))*0.6+n(vec2(q.x*1.3,zw*0.9-uTime*5.0))*0.4;
      float wake=step(0.0,zw)*(1.0-smoothstep(wide*0.5,wide,abs(q.x)))*exp(-max(zw,0.0)/30.0)*smoothstep(0.35,0.75,churn);
      float edge=(1.0-smoothstep(16.0,21.0,abs(q.x)))*(1.0-smoothstep(30.0,40.0,abs(q.y-18.0)));
      vec3 col=vec3(0.55,0.95,1.0)*(glow*0.95+caust*(0.25+glow)*0.9)+vec3(0.85,1.0,1.0)*wake*0.9;
      gl_FragColor=vec4(col*edge*vFog,1.0);`),
    // bubble band: 10 m wide x 40 m long, starting at the stern
    wash:make('boat-prop-wash',`
      float z=(0.5-vUv.y)*40.0+20.0, x=(vUv.x-0.5)*10.0;           // z: metres behind the stern
      float w=0.9+z*0.11;
      vec2 g=vec2(x*2.2,z*1.1-uTime*7.0);
      vec2 id=floor(g), f=fract(g)-0.5;
      float rnd=h(id), b=smoothstep(0.22,0.05,length(f-vec2(rnd-0.5,h(id+7.0)-0.5)*0.5))*step(0.45,rnd);
      float foam=n(vec2(x*1.5,z*0.6-uTime*4.0));
      float band=(1.0-smoothstep(w*0.45,w,abs(x)))*exp(-z/16.0);
      float a=band*(b*1.4+smoothstep(0.4,0.9,foam)*0.55);
      gl_FragColor=vec4(vec3(0.8,1.0,1.0)*a*vFog,1.0);`),
  };
}

// Round 15: expanding shock rings for a boat breach. A small pool, one material each, no textures.
export function buildShockRings(n = 6) {
  const geo = new THREE.RingGeometry(0.84, 1, 48);
  geo.rotateX(-Math.PI / 2);
  const rings = [];
  for (let i = 0; i < n; i++) {
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uFogD: { value: 0.0019 }, uCol: { value: new THREE.Color(1, 0.8, 0.4) }, uFade: { value: 0 } },
      vertexShader: `varying float vFog; uniform float uFogD;
        void main(){vec4 mv=modelViewMatrix*vec4(position,1.0); float d=max(0.0,-mv.z)*uFogD; vFog=exp(-d*d); gl_Position=projectionMatrix*mv;}`,
      fragmentShader: `uniform vec3 uCol; uniform float uFade; varying float vFog;
        void main(){ gl_FragColor=vec4(uCol*uFade*vFog, 1.0); }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 8;
    rings.push({ mesh, on: false, t: 0, dur: 0.8, r0: 1, r1: 20 });
  }
  return {
    rings,
    burst(x, y, z, r1, dur, col, r0 = 1.4) {
      let slot = rings.find((r) => !r.on);
      if (!slot) slot = rings.reduce((a, b) => (a.t > b.t ? a : b));
      slot.on = true; slot.t = 0; slot.dur = dur; slot.r0 = r0; slot.r1 = r1;
      slot.mesh.visible = true;
      slot.mesh.position.set(x, y, z);
      slot.mesh.scale.set(r0, 1, r0);
      slot.mesh.material.uniforms.uCol.value.setRGB(col[0], col[1], col[2]);
      slot.mesh.material.uniforms.uFade.value = 1;
    },
    update(dt) {
      for (const r of rings) {
        if (!r.on) continue;
        r.t += dt;
        const u = r.t / r.dur;
        if (u >= 1) { r.on = false; r.mesh.visible = false; continue; }
        const rad = r.r0 + (r.r1 - r.r0) * Math.pow(u, 0.7);
        r.mesh.scale.set(rad, 1, rad);
        r.mesh.material.uniforms.uFade.value = Math.sin(Math.PI * Math.min(u, 1)) * (1.15 - 0.4 * u);
      }
    },
    live() { return rings.reduce((n, r) => n + (r.on ? 1 : 0), 0); },
  };
}


