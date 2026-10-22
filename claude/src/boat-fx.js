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
