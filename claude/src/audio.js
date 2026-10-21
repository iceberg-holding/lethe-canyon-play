// Procedural WebAudio sound design (no samples). Signal flow:
//   voices -> [panner] -> world bus -> underwater low-pass -> pre-master
//            \-> reverb send (generated canyon impulse) + slap echo (delay feedback) -/
//   pre-master -> bus compressor -> volume -> limiter -> destination
const LS_KEY = 'lethe.audio';

export class Audio {
  constructor() {
    this.ctx = null;
    this.vol = 0.8; this.muted = false;
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (typeof s.vol === 'number') this.vol = Math.min(1, Math.max(0, s.vol));
      if (typeof s.muted === 'boolean') this.muted = s.muted;
    } catch (e) { /* private mode */ }
    this.gun = 0;
    this.listeners = [];
  }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC();
    // output chain
    this.out = c.createGain(); this.out.gain.value = this.muted ? 0 : this.vol;
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.1;
    this.out.connect(limiter); limiter.connect(c.destination);
    this.bus = c.createDynamicsCompressor();       // glue + punch
    this.bus.threshold.value = -18; this.bus.knee.value = 8; this.bus.ratio.value = 4; this.bus.attack.value = 0.004; this.bus.release.value = 0.18;
    this.bus.connect(this.out);
    this.lp = c.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 18000; this.lp.Q.value = 0.5;
    this.lp.connect(this.bus);
    this.world = c.createGain(); this.world.connect(this.lp);
    this.ui = c.createGain(); this.ui.connect(this.bus);   // HUD beeps bypass the underwater filter
    // canyon reverb: generated impulse with discrete early wall slaps + diffuse tail
    this.verb = c.createConvolver();
    this.verb.buffer = this.makeImpulse(1.6);
    this.verbIn = c.createGain(); this.verbIn.gain.value = 0.55;
    this.verbIn.connect(this.verb); this.verb.connect(this.lp);
    // slap echo off the far wall
    this.echo = c.createDelay(1); this.echo.delayTime.value = 0.13;
    const fb = c.createGain(); fb.gain.value = 0.28;
    const ef = c.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 2600;
    this.echoIn = c.createGain(); this.echoIn.gain.value = 0.35;
    this.echoIn.connect(this.echo); this.echo.connect(ef); ef.connect(fb); fb.connect(this.echo); ef.connect(this.lp);
    // noise buffers
    const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    // soft-clip curve for grit (explosion crunch, boost growl)
    this.curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; this.curve[i] = Math.tanh(x * 3.2); }

    // ---- engine: detuned saws + sub + filtered turbine noise; boost growl layer
    this.engGain = c.createGain(); this.engGain.gain.value = 0;
    this.engLP = c.createBiquadFilter(); this.engLP.type = 'lowpass'; this.engLP.frequency.value = 400; this.engLP.Q.value = 1.2;
    this.osc1 = this.osc('sawtooth', 55, this.engLP); this.osc2 = this.osc('sawtooth', 55.7, this.engLP);
    this.osc3 = this.osc('triangle', 110, this.engLP);
    this.sub = c.createGain(); this.sub.gain.value = 0.5; this.sub.connect(this.engGain);
    this.osc4 = this.osc('sine', 27.5, this.sub);
    this.engLP.connect(this.engGain); this.engGain.connect(this.world);
    this.turb = this.loopNoise('bandpass', 1200, 2.5);
    this.growlG = c.createGain(); this.growlG.gain.value = 0;
    const gws = c.createWaveShaper(); gws.curve = this.curve;
    const glp = c.createBiquadFilter(); glp.type = 'lowpass'; glp.frequency.value = 900;
    this.growl = this.osc('sawtooth', 41, gws);
    this.growlLfo = this.osc('sine', 23, null);
    const lfoG = c.createGain(); lfoG.gain.value = 6; this.growlLfo.connect(lfoG); lfoG.connect(this.growl.frequency);
    gws.connect(glp); glp.connect(this.growlG); this.growlG.connect(this.world);
    // ---- environment beds
    this.wind = this.loopNoise('bandpass', 900, 0.6);
    this.rush = this.loopNoise('lowpass', 700, 0.7);      // water rush when flying low
    this.spray = this.loopNoise('highpass', 2500, 0.7);
    this.bubble = this.loopNoise('lowpass', 300, 1);
    // ---- drone whine voice (nearest spotter): doppler pitch + stereo pan
    this.whineG = c.createGain(); this.whineG.gain.value = 0;
    this.whinePan = c.createStereoPanner ? c.createStereoPanner() : null;
    const wbp = c.createBiquadFilter(); wbp.type = 'bandpass'; wbp.frequency.value = 900; wbp.Q.value = 2;
    this.whine = this.osc('sawtooth', 430, wbp);
    this.whine2 = this.osc('square', 437, wbp);
    const vib = this.osc('sine', 11, null), vg = c.createGain(); vg.gain.value = 9; vib.connect(vg); vg.connect(this.whine.frequency); vg.connect(this.whine2.frequency);
    wbp.connect(this.whineG);
    if (this.whinePan) { this.whineG.connect(this.whinePan); this.whinePan.connect(this.world); } else this.whineG.connect(this.world);
    // ---- shield resonant hum bed (excited by hits)
    this.humG = c.createGain(); this.humG.gain.value = 0;
    this.hum = this.osc('sine', 174, this.humG);
    this.hum2 = this.osc('sine', 261.5, this.humG);
    this.humG.connect(this.world);
    this.lastProx = 0;
  }
  osc(type, f, dest) {
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = f;
    if (dest) o.connect(dest);
    o.start();
    return o;
  }
  makeImpulse(sec) {
    const c = this.ctx, n = Math.floor(c.sampleRate * sec), b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        const t = i / c.sampleRate;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t / sec, 3.2) * 0.32 * (t < 0.012 ? t / 0.012 : 1);
      }
      // early reflections from the canyon walls (different per ear)
      for (const [dt, g] of [[0.045, 0.6], [0.093, 0.45], [0.16, 0.35], [0.27, 0.22], [0.41, 0.12]]) {
        const at = Math.floor((dt + (ch ? 0.011 : 0)) * c.sampleRate);
        for (let k = 0; k < 160 && at + k < n; k++) d[at + k] += (Math.random() * 2 - 1) * g * (1 - k / 160);
      }
    }
    return b;
  }
  loopNoise(type, f, q) {
    const c = this.ctx, src = c.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = c.createGain(); g.gain.value = 0;
    src.connect(fl); fl.connect(g); g.connect(this.world); src.start(0, Math.random() * 1.9);
    return { g, fl };
  }
  // ---------------------------------------------------------------- volume
  setVolume(v) { this.vol = Math.min(1, Math.max(0, v)); this.applyVol(); }
  toggleMute() { this.muted = !this.muted; this.applyVol(); return this.muted; }
  applyVol() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ vol: this.vol, muted: this.muted })); } catch (e) { /* ignore */ }
    if (this.ctx) this.out.gain.setTargetAtTime(this.muted ? 0 : this.vol, this.ctx.currentTime, 0.03);
    for (const f of this.listeners) f(this.muted, this.vol);
  }
  set(param, v, k = 0.08) { param.setTargetAtTime(v, this.ctx.currentTime, k); }
  // continuous layers; prox = 0..1 closeness to walls/arches (doppler-ish swell), alt = ship height
  update(speed, boost, underwater, skim, running, prox = 0, alt = 10) {
    if (!this.ctx) return;
    const sp = Math.min(speed / 95, 1.2);
    const on = running ? 1 : 0;
    const swell = prox * prox;
    this.set(this.engGain.gain, on * (0.07 + 0.05 * sp + boost * 0.035 + swell * 0.04));
    const base = underwater ? 38 : 48 + sp * 34 + boost * 10 + swell * 6;
    this.set(this.osc1.frequency, base); this.set(this.osc2.frequency, base * 1.012); this.set(this.osc3.frequency, base * 2.01); this.set(this.osc4.frequency, base * 0.5);
    this.set(this.engLP.frequency, underwater ? 220 : 280 + sp * 700 + boost * 600 + swell * 900);
    this.set(this.turb.g.gain, on * (underwater ? 0.02 : 0.025 + 0.03 * sp + boost * 0.03));
    this.set(this.turb.fl.frequency, 700 + sp * 1600 + boost * 900);
    this.set(this.growlG.gain, on * boost * (underwater ? 0 : 0.11));
    this.set(this.growl.frequency, 36 + sp * 18);
    this.set(this.wind.g.gain, on * (underwater ? 0 : 0.03 + 0.09 * sp * sp + boost * 0.05 + swell * 0.16), prox > this.lastProx ? 0.05 : 0.25);
    this.set(this.wind.fl.frequency, 500 + sp * 900 + swell * 1400);
    const low = Math.max(0, 1 - Math.max(0, alt) / 9);
    this.set(this.rush.g.gain, on * (underwater ? 0 : low * low * 0.18 * Math.min(1, sp * 1.4)));
    this.set(this.rush.fl.frequency, 400 + sp * 900);
    this.set(this.spray.g.gain, on * skim * 0.12);
    this.set(this.bubble.g.gain, on * (underwater ? 0.16 : 0));
    this.set(this.lp.frequency, underwater ? 600 : 18000, 0.12);
    this.set(this.verbIn.gain, underwater ? 0.15 : 0.55);
    this.set(this.echoIn.gain, underwater ? 0 : 0.35);
    this.lastProx = prox;
  }
  // nearest drone: gain 0..1, pan -1..1, doppler ratio (approaching > 1)
  droneVoice(gain, pan, ratio) {
    if (!this.ctx) return;
    this.set(this.whineG.gain, gain * 0.05, 0.1);
    this.set(this.whine.frequency, 430 * ratio, 0.1); this.set(this.whine2.frequency, 437 * ratio, 0.1);
    if (this.whinePan) this.set(this.whinePan.pan, Math.max(-1, Math.min(1, pan)), 0.1);
  }
  // ---------------------------------------------------------------- one-shot helpers
  env(node, t0, a, peak, dec) {
    node.gain.setValueAtTime(0.0001, t0);
    node.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + a);
    node.gain.exponentialRampToValueAtTime(0.0001, t0 + a + dec);
  }
  route(node, o = {}) {
    // node -> [pan] -> world/ui (+ sends)
    const c = this.ctx;
    let out = node;
    if (o.pan && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = o.pan; out.connect(p); out = p; }
    out.connect(o.ui ? this.ui : this.world);
    if (o.verb) { const g = c.createGain(); g.gain.value = o.verb; out.connect(g); g.connect(this.verbIn); }
    if (o.echo) { const g = c.createGain(); g.gain.value = o.echo; out.connect(g); g.connect(this.echoIn); }
  }
  noiseHit(type, f, q, peak, dec, fEnd, o = {}) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + (o.delay || 0), src = c.createBufferSource();
    src.buffer = this.noise;
    if (o.rate) src.playbackRate.value = o.rate;
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
    if (fEnd) fl.frequency.exponentialRampToValueAtTime(fEnd, t + dec);
    const g = c.createGain();
    src.connect(fl);
    if (o.drive) { const ws = c.createWaveShaper(); ws.curve = this.curve; fl.connect(ws); ws.connect(g); } else fl.connect(g);
    this.route(g, o);
    this.env(g, t, o.attack || 0.002, peak, dec);
    src.start(t, Math.random() * 1.5); src.stop(t + dec + 0.08);
  }
  tone(type, f0, f1, peak, dec, delay = 0, o = {}) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + delay, osc = c.createOscillator(), g = c.createGain();
    osc.type = type; osc.frequency.setValueAtTime(f0, t); osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dec);
    osc.connect(g);
    this.route(g, o);
    this.env(g, t, o.attack || 0.004, peak, dec);
    osc.start(t); osc.stop(t + dec + 0.08);
  }
  // ---------------------------------------------------------------- weapons
  // LETHE-signature energy cannon: glassy crack + tight sub thump + bright "tchk" chirp + canyon slap.
  // ±7 % random pitch/filter per shot; twin cannons alternate left/right.
  shot() {
    if (!this.ctx) return;
    this.gun ^= 1;
    const v = 1 + (Math.random() * 2 - 1) * 0.07, pan = this.gun ? 0.22 : -0.22;
    const o = { pan, verb: 0.22, echo: 0.3 };
    this.noiseHit('highpass', 3200 * v, 0.9, 0.42, 0.028, 0, { ...o, attack: 0.0008 });              // crack
    this.noiseHit('bandpass', 5200 * v, 3, 0.16, 0.05, 2400, { ...o, attack: 0.0008 });               // sizzle
    this.tone('sine', 1750 * v, 520 * v, 0.07, 0.045, 0, { pan, attack: 0.001 });                     // signature chirp
    this.tone('square', 880 * v, 330 * v, 0.03, 0.035, 0.004, { pan, attack: 0.001 });
    this.tone('sine', 122 * v, 44, 0.5, 0.13, 0, { pan: pan * 0.4, attack: 0.002 });                  // thump
    this.tone('triangle', 64 * v, 36, 0.22, 0.16, 0.003, { attack: 0.003 });                          // body
  }
  // heavy rocket: deep launch thump + rising whoosh + crackle
  rocket() {
    if (!this.ctx) return;
    this.tone('sine', 95, 30, 0.75, 0.35, 0, { verb: 0.4, attack: 0.003 });
    this.tone('triangle', 55, 26, 0.4, 0.5, 0.01);
    this.noiseHit('lowpass', 260, 1.2, 0.5, 0.75, 2600, { verb: 0.35, echo: 0.25, attack: 0.02 });
    this.noiseHit('bandpass', 900, 0.8, 0.22, 0.9, 3800, { attack: 0.05, delay: 0.05 });
    for (let i = 0; i < 6; i++) this.noiseHit('highpass', 5000, 1, 0.05, 0.015, 0, { delay: 0.05 + i * 0.045 + Math.random() * 0.02 });
  }
  // layered: crack + mid crunch + long sub rumble sweep + debris rattles; distance-scaled
  explosion(big = 1, near = 1, pan = 0) {
    const k = big * (0.3 + 0.7 * near), o = { pan: pan * 0.7, verb: 0.5, echo: 0.3 };
    this.noiseHit('highpass', 2500, 0.8, 0.5 * k, 0.04, 0, { ...o, attack: 0.0008 });
    this.noiseHit('bandpass', 800, 0.9, 0.55 * k, 0.32 * big, 300, { ...o, drive: true });
    this.noiseHit('lowpass', 1600, 0.8, 0.45 * k, 1.1 * big, 70, o);
    this.tone('sine', 90, 24, 0.7 * k, 1.5 * big, 0, { verb: 0.3 });
    this.tone('triangle', 58, 22, 0.35 * k, 1.8 * big, 0.04);
    for (let i = 0; i < 7; i++) this.noiseHit('bandpass', 1800 + Math.random() * 3500, 6, 0.06 * k, 0.03, 0, { delay: 0.2 + Math.random() * 0.9, pan: pan + (Math.random() - 0.5) * 0.6 });
  }
  impact() { this.noiseHit('bandpass', 2200, 1.5, 0.12, 0.05, 0, { echo: 0.2 }); this.tone('square', 600, 200, 0.02, 0.04); }
  shieldHit() {
    this.tone('sine', 2500, 1250, 0.13, 0.22, 0, { attack: 0.001, verb: 0.2 });   // bright zing
    this.tone('sine', 3760, 1900, 0.05, 0.16, 0, { attack: 0.001 });
    this.noiseHit('bandpass', 4200, 4, 0.12, 0.12);
    if (this.ctx) {
      // excite the resonant hum bed
      const t = this.ctx.currentTime;
      this.humG.gain.cancelScheduledValues(t);
      this.humG.gain.setValueAtTime(0.09, t);
      this.humG.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      this.hum.frequency.setValueAtTime(190, t); this.hum.frequency.exponentialRampToValueAtTime(168, t + 0.6);
    }
  }
  shieldDown() {
    this.noiseHit('highpass', 1800, 0.7, 0.4, 0.06, 0, { attack: 0.0008, verb: 0.3 });   // crack
    this.tone('sawtooth', 900, 70, 0.12, 0.7); this.tone('sine', 500, 50, 0.15, 0.8, 0.05);
  }
  shieldUp() { this.tone('sine', 320, 980, 0.05, 0.9, 0, { attack: 0.25, ui: true }); this.tone('sine', 480, 1470, 0.02, 0.9, 0, { attack: 0.3, ui: true }); }
  lockTick(m) { this.tone('square', 700 + m * 900, 700 + m * 900, 0.035, 0.05, 0, { ui: true }); }
  lockOn() { this.tone('square', 1800, 1800, 0.06, 0.5, 0, { ui: true }); this.tone('square', 1805, 1805, 0.04, 0.5, 0, { ui: true }); }
  laser() { this.tone('sawtooth', 220, 180, 0.04, 0.9); }
  turretShot(pan = 0) {
    // launch whoosh + thump from the rim
    this.noiseHit('bandpass', 400, 1.2, 0.2, 0.45, 2400, { pan, verb: 0.5, attack: 0.03 });
    this.tone('sine', 140, 50, 0.22, 0.25, 0, { pan, verb: 0.3 });
    this.tone('sawtooth', 500, 90, 0.05, 0.25, 0, { pan });
  }
  lost() { this.tone('sine', 660, 330, 0.05, 0.6, 0, { ui: true }); }
  hit() { this.tone('sine', 90, 40, 0.5, 0.35); this.tone('triangle', 220, 140, 0.18, 0.25); this.noiseHit('bandpass', 700, 1.2, 0.35, 0.3, 0, { drive: true, verb: 0.2 }); }
  splash() { this.noiseHit('bandpass', 1400, 0.6, 0.45, 0.6, 400, { verb: 0.2 }); this.noiseHit('lowpass', 500, 0.7, 0.3, 0.4); this.tone('sine', 300, 90, 0.1, 0.25); }
  click() { if (this.ctx) this.noiseHit('highpass', 3500 + Math.random() * 2000, 0.5, 0.18 + Math.random() * 0.12, 0.008, 0, { ui: true, attack: 0.0005 }); }
  beep(f = 880) { this.tone('sine', f, f, 0.08, 0.12, 0, { ui: true }); }
  // force-field mast down: two-tone alarm + collapse
  collapse() {
    for (let i = 0; i < 6; i++) this.tone('square', i % 2 ? 660 : 880, i % 2 ? 660 : 880, 0.05, 0.16, i * 0.2, { ui: true, attack: 0.005 });
    this.tone('sawtooth', 700, 50, 0.12, 1.4, 0, { verb: 0.4 }); this.tone('sine', 300, 30, 0.2, 1.6, 0.1);
  }
  dive() { this.tone('sine', 260, 120, 0.12, 0.3); this.noiseHit('lowpass', 1200, 1, 0.15, 0.25); }
  score() { this.tone('sine', 880, 1320, 0.06, 0.12, 0.05, { ui: true }); this.tone('sine', 1320, 1760, 0.04, 0.12, 0.12, { ui: true }); }
  empty() { this.tone('square', 220, 200, 0.04, 0.06, 0, { ui: true }); }
}
