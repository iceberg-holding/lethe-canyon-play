// Procedural canvas textures: tileable rock albedo + normal map, ship panel/wear maps.
import * as THREE from 'three';
import { clamp, hash2 } from './util.js';

// periodic value noise (wraps every p cells) so the textures tile seamlessly
function pnoise(x, y, px, py) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py, x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
  const a = hash2(x0, y0), b = hash2(x1, y0), c = hash2(x0, y1), d = hash2(x1, y1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}
function pfbm(x, y, px, py, oct) {
  let s = 0, a = 0.5, n = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    s += a * pnoise(x * f, y * f, px * f, py * f);
    n += a; a *= 0.5; f *= 2;
  }
  return s / n;
}

function canvas(S) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  return cv;
}
function toTex(cv, srgb = false) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  if (srgb) t.colorSpace = THREE.NoColorSpace;
  return t;
}
// height field -> tangent-space normal map
function normalFromHeight(H, S, strength) {
  const cv = canvas(S), ctx = cv.getContext('2d'), img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const l = H[y * S + ((x - 1 + S) % S)], r = H[y * S + ((x + 1) % S)];
    const u = H[((y - 1 + S) % S) * S + x], d = H[((y + 1) % S) * S + x];
    let nx = (l - r) * strength, ny = (d - u) * strength, nz = 1;
    const il = 1 / Math.hypot(nx, ny, nz);
    nx *= il; ny *= il; nz *= il;
    const o = (y * S + x) * 4;
    img.data[o] = (nx * 0.5 + 0.5) * 255; img.data[o + 1] = (ny * 0.5 + 0.5) * 255; img.data[o + 2] = (nz * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

// Rock: u = along canyon, v = height (36 m per tile). Strata lines, cracked blocks,
// vertical erosion streaks / gullies and desert-varnish runs.
export function rockTextures(S = 512) {
  const H = new Float32Array(S * S), A = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const fy = y / S;
    // strata: sharp ledges every ~1/9 tile with soft sub-layers
    const st = fy * 9 + 0.35 * pfbm(0.5, fy * 6, 4, 6, 2);
    const ledge = Math.pow(st - Math.floor(st), 3.0);
    const layer = Math.floor(st);
    const tone = 0.86 + 0.14 * (hash2(layer, 3) - 0.5) * 2;
    for (let x = 0; x < S; x++) {
      const fx = x / S;
      const gully = pfbm(fx * 10, fy * 2, 10, 2, 3);          // long vertical runs
      const g = Math.max(0, Math.abs(pfbm(fx * 7, fy + 3, 7, 1, 2)) - 0.0);
      const cracks = 1 - Math.min(1, Math.abs(pfbm(fx * 14, fy * 14, 14, 14, 3)) * 7);
      const grain = pfbm(fx * 64, fy * 64, 64, 64, 2);
      const blocks = pfbm(fx * 5, fy * 18, 5, 18, 3);
      let h = 0.45 * (1 - ledge) + 0.25 * blocks + 0.14 * grain - 0.35 * Math.max(0, cracks) * 0.6 - 0.22 * (1 - Math.min(1, g * 5));
      h += 0.08 * gully;
      H[y * S + x] = h;
      const varnish = Math.max(0, pfbm(fx * 18, fy * 2 + 7, 18, 2, 3)) * 0.55;  // dark runs below ledges
      const dust = Math.pow(1 - ledge, 6) * 0.18;
      A[y * S + x] = clamp(tone * (0.9 + 0.12 * grain + 0.06 * blocks) - varnish * 0.35 - Math.max(0, cracks) * 0.14 + dust, 0.35, 1.2);
    }
  }
  const cv = canvas(S), ctx = cv.getContext('2d'), img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = clamp(A[i] * 0.86, 0, 1) * 255;
    img.data[i * 4] = v * 1.02; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 0.96; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { map: toTex(cv), normalMap: toTex(normalFromHeight(H, S, 6)) };
}

// Ship hull: panel lines, rivets, light soot near the rear, scratches. Used as map + roughness + bump.
export function shipTextures(S = 512) {
  const cv = canvas(S), ctx = cv.getContext('2d');
  ctx.fillStyle = '#c8c8c8';
  ctx.fillRect(0, 0, S, S);
  const R = (a, b) => a + Math.random() * (b - a);
  // panel tone variation
  for (let i = 0; i < 70; i++) {
    const w = R(30, 140), h = R(20, 90), x = R(0, S), y = R(0, S), c = R(185, 215) | 0;
    ctx.fillStyle = `rgb(${c},${c},${c + 2})`;
    ctx.fillRect(x, y, w, h);
  }
  // panel lines
  ctx.strokeStyle = 'rgba(30,30,32,0.75)';
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 26; i++) { const y = R(0, S); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y + R(-6, 6)); ctx.stroke(); }
  for (let i = 0; i < 34; i++) {
    const x = R(0, S), y = R(0, S), l = R(40, 180);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + l); ctx.stroke();
  }
  // rivets
  ctx.fillStyle = 'rgba(40,40,44,0.6)';
  for (let i = 0; i < 500; i++) ctx.fillRect(R(0, S), R(0, S), 1.6, 1.6);
  // fine scratches (light)
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 0.7;
  for (let i = 0; i < 140; i++) {
    const x = R(0, S), y = R(0, S), a = R(-0.4, 0.4), l = R(6, 30);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
  // light soot toward v=1 (rear of lofted parts)
  const g = ctx.createLinearGradient(0, S * 0.7, 0, S);
  g.addColorStop(0, 'rgba(40,30,25,0)'); g.addColorStop(1, 'rgba(40,30,25,0.35)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  const map = toTex(cv);
  // roughness: brighter = rougher; panels slightly polished, lines rough
  const cr = canvas(S / 2), rc = cr.getContext('2d');
  rc.drawImage(cv, 0, 0, S / 2, S / 2);
  rc.globalCompositeOperation = 'difference';
  rc.fillStyle = '#ffffff'; rc.fillRect(0, 0, S / 2, S / 2);
  rc.globalCompositeOperation = 'source-over';
  rc.fillStyle = 'rgba(150,150,150,0.55)'; rc.fillRect(0, 0, S / 2, S / 2);
  const rough = toTex(cr);
  return { map, rough, bump: map };
}
