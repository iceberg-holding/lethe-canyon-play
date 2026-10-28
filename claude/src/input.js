// Keyboard, mouse, multi-touch virtual stick / buttons and optional gyro tilt.
import { clamp } from './util.js?v=r29';

export const input = {
  x: 0, y: 0, fire: false, boost: false, dive: false,
  stick: { x: 0, y: 0, id: null, ox: 0, oy: 0 },
  tilt: { on: false, x: 0, y: 0, b0: null, g0: null },
  keys: new Set(), mouseFire: false, touchFire: false, touchBoost: false,
  divePressed: false, rocketPressed: false, active: false,
  consumeDive() { const d = this.divePressed; this.divePressed = false; return d; },
  consumeRocket() { const d = this.rocketPressed; this.rocketPressed = false; return d; },
};

const DIVE_KEYS = ['KeyC', 'KeyE', 'KeyQ', 'ControlLeft', 'ControlRight'];
const GAME_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyC', 'KeyE', 'KeyQ', 'KeyM', 'KeyV', 'KeyH', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight'];
export function setupInput(canvas) {
  canvas.tabIndex = -1;   // focusable, so keys keep flowing to the game after clicking it
  addEventListener('keydown', (e) => {
    if (e.altKey || e.metaKey) return;   // leave OS / browser chords alone
    if (DIVE_KEYS.includes(e.code) && !e.repeat) input.divePressed = true;
    if (e.code === 'KeyR' && !e.repeat) input.rocketPressed = true;
    // game keys never reach the browser: blocks page scroll and Ctrl+S / Ctrl+D / Ctrl+A / Ctrl+R… while Ctrl
    // is used as a dive key (Ctrl+W / Ctrl+T cannot be blocked by any page; a leave-page guard covers those)
    if (GAME_KEYS.includes(e.code) && input.active) e.preventDefault();
    else if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    input.keys.add(e.code);
  }, { capture: true });
  addEventListener('keyup', (e) => input.keys.delete(e.code), { capture: true });
  addEventListener('blur', () => { input.keys.clear(); input.mouseFire = false; });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (e.button === 0) input.mouseFire = true;
    else if (e.button === 2) input.rocketPressed = true;
  });
  addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse' && e.button === 0) input.mouseFire = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // floating virtual stick on the left side
  const zone = document.getElementById('stickZone');
  const base = document.getElementById('stickBase'), knob = document.getElementById('stickKnob');
  const R = 60;
  const st = input.stick;
  zone.addEventListener('pointerdown', (e) => {
    if (st.id !== null) return;
    st.id = e.pointerId; st.ox = e.clientX; st.oy = e.clientY;
    zone.setPointerCapture(e.pointerId);
    base.style.left = e.clientX + 'px'; base.style.top = e.clientY + 'px';
    base.classList.add('active');
    knob.style.transform = 'translate(-50%,-50%)';
    e.preventDefault();
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== st.id) return;
    let dx = e.clientX - st.ox, dy = e.clientY - st.oy;
    const l = Math.hypot(dx, dy);
    if (l > R) { dx *= R / l; dy *= R / l; }
    st.x = dx / R; st.y = -dy / R;
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  });
  const end = (e) => {
    if (e.pointerId !== st.id) return;
    st.id = null; st.x = st.y = 0;
    base.classList.remove('active');
  };
  zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);

  const hold = (id, key) => {
    const el = document.getElementById(id);
    const ids = new Set();
    el.addEventListener('pointerdown', (e) => { ids.add(e.pointerId); input[key] = true; el.classList.add('on'); el.setPointerCapture(e.pointerId); e.preventDefault(); });
    const up = (e) => { ids.delete(e.pointerId); if (!ids.size) { input[key] = false; el.classList.remove('on'); } };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  hold('btnFire', 'touchFire');
  hold('btnBoost', 'touchBoost');
  const rk = document.getElementById('btnRocket');
  rk.addEventListener('pointerdown', (e) => { input.rocketPressed = true; rk.classList.add('on'); setTimeout(() => rk.classList.remove('on'), 140); e.preventDefault(); });
  const dive = document.getElementById('btnDive');
  dive.addEventListener('pointerdown', (e) => { input.divePressed = true; e.preventDefault(); });

  const tiltBtn = document.getElementById('btnTilt');
  tiltBtn.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    const t = input.tilt;
    if (t.on) { t.on = false; t.x = t.y = 0; tiltBtn.classList.remove('on'); return; }
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') return;
      }
    } catch (err) { return; }
    t.on = true; t.b0 = null; tiltBtn.classList.add('on');
  });
  addEventListener('deviceorientation', (e) => {
    const t = input.tilt;
    if (!t.on || e.beta == null) return;
    const ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    // in landscape, beta = roll of the phone around its long axis; gamma = pitch
    let roll, pitch;
    if (ang === 90) { roll = e.beta; pitch = -e.gamma; }
    else if (ang === -90 || ang === 270) { roll = -e.beta; pitch = e.gamma; }
    else { roll = e.gamma; pitch = e.beta; }
    if (t.b0 === null) { t.b0 = roll; t.g0 = pitch; }
    t.x = clamp((roll - t.b0) / 22, -1, 1);
    t.y = clamp((pitch - t.g0) / 18, -1, 1);
  });
}

export function pollInput() {
  const k = input.keys;
  const kx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
  const ky = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
  const t = input.tilt.on ? input.tilt : { x: 0, y: 0 };
  input.x = clamp(kx + input.stick.x + t.x, -1, 1);
  input.y = clamp(ky + input.stick.y + t.y, -1, 1);
  input.fire = k.has('Space') || input.mouseFire || input.touchFire;
  input.boost = k.has('ShiftLeft') || k.has('ShiftRight') || input.touchBoost;
}
