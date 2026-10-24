// Procedural WebAudio sound design (no samples). Signal flow:
//   voices -> [panner] -> world bus -> underwater low-pass -> pre-master
//            \-> reverb send (generated canyon impulse) + slap echo (delay feedback) -/
//   pre-master -> bus compressor -> volume -> limiter -> destination
const LS_KEY = 'lethe.audio', LS_ENGINE = 'lethe.engine';
export const ENGINES = [
  { id: 'whisper', en: 'Jet whisper', ru: 'Шёпот' },
  { id: 'turbine', en: 'Turbine', ru: 'Турбина' },
  { id: 'ion', en: 'Ion hum', ru: 'Ионный гул' },
];
const ENGINE_ALIASES = { whisper: 'whisper', 'jet whisper': 'whisper', jet: 'whisper', turbine: 'turbine', ion: 'ion', 'ion hum': 'ion' };

export class Audio {
  constructor() {
    this.ctx = null;
    this.vol = 0.8; this.muted = false;
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (typeof s.vol === 'number') this.vol = Math.min(1, Math.max(0, s.vol));
      if (typeof s.muted === 'boolean') this.muted = s.muted;
    } catch (e) { /* private mode */ }
    this.engine = 'whisper';
    try { const e = localStorage.getItem(LS_ENGINE); if (ENGINE_ALIASES[e]) this.engine = ENGINE_ALIASES[e]; } catch (e) { /* ignore */ }
    this.gun = 0;
    this.listeners = [];
    // round 11 tutorial slow-mo: 0..1 depth -> pitch drop on every voice + a master low-pass
    this.slowK = 0; this.pitch = 1; this.loops = [];
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
    // soft-clip curve for grit (explosion crunch)
    this.curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; this.curve[i] = Math.tanh(x * 3.2); }

    // ---- engine: light, airy presets on their own bus. Engine bus -> 2x high-pass (≈170 Hz, 24 dB/oct, no
    // motorboat rumble) -> soft low-pass -> duck (dips under weapons / impacts so it never masks them) -> world
    this.engBus = c.createGain(); this.engBus.gain.value = 0;
    const hp1 = c.createBiquadFilter(); hp1.type = 'highpass'; hp1.frequency.value = 170; hp1.Q.value = 0.6;
    const hp2 = c.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = 170; hp2.Q.value = 0.6;
    this.engSoft = c.createBiquadFilter(); this.engSoft.type = 'lowpass'; this.engSoft.frequency.value = 9000; this.engSoft.Q.value = 0.4;
    this.engDuck = c.createGain(); this.engDuck.gain.value = 1;
    this.engBus.connect(hp1); hp1.connect(hp2); hp2.connect(this.engSoft); this.engSoft.connect(this.engDuck); this.engDuck.connect(this.world);
    this.eng = {};
    // 'whisper' — airy filtered noise + faint high whine
    {
      const g = c.createGain(); g.gain.value = 0; g.connect(this.engBus);
      const air = this.loopNoise('bandpass', 2200, 0.7, g), hiss = this.loopNoise('highpass', 6000, 0.5, g);
      const wg = c.createGain(); wg.gain.value = 0; wg.connect(g);
      const w1 = this.osc('sine', 2400, wg), w2 = this.osc('sine', 2412, wg);
      const vib = this.osc('sine', 5.3, null), vg = c.createGain(); vg.gain.value = 7; vib.connect(vg); vg.connect(w1.frequency); vg.connect(w2.frequency);
      this.eng.whisper = { g, air, hiss, wg, w1, w2 };
    }
    // 'turbine' — clean rising turbine whine (fundamental + soft 2nd harmonic + blade shimmer) tracking speed
    {
      const g = c.createGain(); g.gain.value = 0; g.connect(this.engBus);
      const lvl = c.createGain(); lvl.gain.value = 0.045; lvl.connect(g);
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.9; bp.frequency.value = 1400; bp.connect(lvl);
      const hg = c.createGain(); hg.gain.value = 0.32; hg.connect(bp);
      const f1 = this.osc('sine', 700, bp), f2 = this.osc('triangle', 1404, hg), f3 = this.osc('sine', 703.5, bp);
      const blades = this.loopNoise('bandpass', 2800, 6, g);
      this.eng.turbine = { g, bp, f1, f2, f3, blades };
    }
    // 'ion' — soft smooth synthetic hum (open fifth, slow chorus) with a gentle tremolo shimmer on top
    {
      const g = c.createGain(); g.gain.value = 0; g.connect(this.engBus);
      const lvl = c.createGain(); lvl.gain.value = 0.03; lvl.connect(g);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400; lp.Q.value = 0.3; lp.connect(lvl);
      const h1 = this.osc('sine', 220, lp), h2 = this.osc('sine', 330.6, lp), h3 = this.osc('triangle', 440.8, lp), h4 = this.osc('sine', 221.2, lp);
      const sg = c.createGain(); sg.gain.value = 0; const sh = this.osc('sine', 1760, sg), sh2 = this.osc('sine', 2641, sg);
      const am = c.createGain(); am.gain.value = 0.5; am.connect(g); sg.connect(am);
      const trem = this.osc('sine', 6.2, null), tg = c.createGain(); tg.gain.value = 0.5; trem.connect(tg); tg.connect(am.gain);
      const ch = this.osc('sine', 0.23, null), cg = c.createGain(); cg.gain.value = 1.4; ch.connect(cg); cg.connect(h4.frequency);
      this.eng.ion = { g, lp, h1, h2, h3, h4, sg, sh, sh2 };
    }
    // boost: an airy rising rush (no low growl)
    this.boostAir = this.loopNoise('bandpass', 1800, 0.9, this.engBus);
    // round 6: soft steam hiss while the engines burn cargo water (on the ducked engine bus: never masks the guns)
    this.steamHiss = this.loopNoise('bandpass', 5200, 0.9, this.engBus);
    this.previewUntil = 0;
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
  loopNoise(type, f, q, dest) {
    const c = this.ctx, src = c.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = c.createGain(); g.gain.value = 0;
    src.connect(fl); fl.connect(g); g.connect(dest || this.world); src.start(0, Math.random() * 1.9);
    this.loops.push(src);
    return { g, fl, src };
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
  update(speed, boost, underwater, skim, running, prox = 0, alt = 10, dampK = 0) {
    if (!this.ctx) return;
    const sp = Math.min(speed / 95, 1.2);
    const on = running ? 1 : 0;
    const swell = prox * prox;
    this.updateEngine(sp, boost, underwater, running ? 1 : 0, swell, dampK);
    this.set(this.wind.g.gain, on * (underwater ? 0 : 0.03 + 0.09 * sp * sp + boost * 0.05 + swell * 0.16), prox > this.lastProx ? 0.05 : 0.25);
    this.set(this.wind.fl.frequency, 500 + sp * 900 + swell * 1400);
    const low = Math.max(0, 1 - Math.max(0, alt) / 9);
    this.set(this.rush.g.gain, on * (underwater ? 0 : low * low * 0.18 * Math.min(1, sp * 1.4)));
    this.set(this.rush.fl.frequency, 400 + sp * 900);
    this.set(this.spray.g.gain, on * skim * 0.12);
    this.set(this.bubble.g.gain, on * (underwater ? 0.16 : 0));
    this.set(this.lp.frequency, Math.min(underwater ? 600 : 18000, 18000 * Math.pow(0.05, this.slowK)), 0.12);
    this.set(this.verbIn.gain, underwater ? 0.15 : 0.55);
    this.set(this.echoIn.gain, underwater ? 0 : 0.35);
    this.lastProx = prox;
  }
  // steam 0..1: water being flashed in the engines (quiet airy hiss with a slow flutter)
  steam(v) {
    if (!this.ctx) return;
    const fl = 0.85 + 0.15 * Math.sin(this.ctx.currentTime * 7.3);
    this.set(this.steamHiss.g.gain, v * 0.05 * fl, 0.12);
    this.set(this.steamHiss.fl.frequency, 4600 + v * 1400, 0.2);
  }
  // ---------------------------------------------------------------- engine presets
  setEngine(name) {
    const id = ENGINE_ALIASES[String(name).toLowerCase()];
    if (!id) return this.engine;
    this.engine = id;
    try { localStorage.setItem(LS_ENGINE, id); } catch (e) { /* ignore */ }
    return id;
  }
  engineInfo() { return ENGINES.find((e) => e.id === this.engine); }
  // short audition of the current preset at cruise (start screen)
  preview(sec = 1.6) { if (this.ctx) this.previewUntil = this.ctx.currentTime + sec; }
  updateEngine(sp, boost, underwater, on, swell, dampK = 0) {
    const prev = this.ctx.currentTime < this.previewUntil;
    if (prev && !on) { on = 1; sp = 0.75; boost = 0; underwater = false; swell = 0; }
    const uw = underwater ? 0.55 : 1;
    this.set(this.engBus.gain, on * uw * (0.85 + 0.25 * sp + 0.2 * swell), prev ? 0.05 : 0.08);
    const open = underwater ? 1400 : 7000 + sp * 3000 + swell * 2000;
    this.set(this.engSoft.frequency, open * (1 - 0.72 * Math.max(0, Math.min(1, dampK))));
    const sel = (id) => (this.engine === id ? 1 : 0);
    const W = this.eng.whisper, T = this.eng.turbine, I = this.eng.ion;
    // whisper
    this.set(W.g.gain, sel('whisper'), 0.12);
    this.set(W.air.g.gain, 0.05 + 0.05 * sp + boost * 0.03 + swell * 0.03);
    this.set(W.air.fl.frequency, 1300 + sp * 1500 + boost * 900 + swell * 700);
    this.set(W.hiss.g.gain, 0.012 + 0.014 * sp + boost * 0.012);
    this.set(W.wg.gain, 0.0045 + 0.004 * sp + boost * 0.003);
    const wf = (2100 + sp * 900 + boost * 400 + swell * 150) * this.pitch;
    this.set(W.w1.frequency, wf); this.set(W.w2.frequency, wf * 1.005);
    // turbine
    this.set(T.g.gain, sel('turbine'), 0.12);
    const tf = (430 + sp * 620 + boost * 260 + swell * 60) * this.pitch;
    this.set(T.f1.frequency, tf, 0.25); this.set(T.f3.frequency, tf * 1.005, 0.25); this.set(T.f2.frequency, tf * 2.006, 0.25);
    this.set(T.bp.frequency, tf * 1.6);
        this.set(T.blades.g.gain, 0.012 + 0.016 * sp + boost * 0.016);
    this.set(T.blades.fl.frequency, tf * 4);
    // ion hum: an open fifth that lifts gently with speed; shimmer brightens with boost
    this.set(I.g.gain, sel('ion'), 0.12);
    const hf = (205 + sp * 40 + boost * 18) * this.pitch;
    this.set(I.h1.frequency, hf, 0.3); this.set(I.h4.frequency, hf * 1.006, 0.3); this.set(I.h2.frequency, hf * 1.5, 0.3); this.set(I.h3.frequency, hf * 2.003, 0.3);
    this.set(I.lp.frequency, 700 + sp * 700 + boost * 500);
    this.set(I.sg.gain, 0.012 + 0.012 * sp + boost * 0.02 + swell * 0.01);
    this.set(I.sh.frequency, hf * 8, 0.3); this.set(I.sh2.frequency, hf * 12.01, 0.3);
    // boost rush (all presets)
    this.set(this.boostAir.g.gain, on * boost * (underwater ? 0 : 0.035));
    this.set(this.boostAir.fl.frequency, 1500 + sp * 1200);
  }
  // briefly dip the engine so weapon / impact transients cut through
  duck(depth = 0.45, hold = 0.12) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, g = this.engDuck.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(1 - depth, t, 0.008);
    g.setTargetAtTime(1, t + hold, 0.18);
  }
  // nearest drone: gain 0..1, pan -1..1, doppler ratio (approaching > 1)
  droneVoice(gain, pan, ratio) {
    if (!this.ctx) return;
    this.set(this.whineG.gain, gain * 0.05, 0.1);
    ratio *= this.pitch;
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
    if (o.pan && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, o.pan)); out.connect(p); out = p; }
    out.connect(o.ui ? this.ui : this.world);
    if (o.verb) { const g = c.createGain(); g.gain.value = o.verb; out.connect(g); g.connect(this.verbIn); }
    if (o.echo) { const g = c.createGain(); g.gain.value = o.echo; out.connect(g); g.connect(this.echoIn); }
  }
  noiseHit(type, f, q, peak, dec, fEnd, o = {}) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + (o.delay || 0), src = c.createBufferSource(), pk = o.raw ? 1 : this.pitch;
    src.buffer = this.noise;
    f *= pk; fEnd *= pk;
    if (o.rate || pk !== 1) src.playbackRate.value = (o.rate || 1) * pk;
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
    if (!o.raw) { f0 *= this.pitch; f1 *= this.pitch; }
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
    this.duck(0.35, 0.06);
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
    this.duck(0.6, 0.5);
    this.tone('sine', 95, 30, 0.75, 0.35, 0, { verb: 0.4, attack: 0.003 });
    this.tone('triangle', 55, 26, 0.4, 0.5, 0.01);
    this.noiseHit('lowpass', 260, 1.2, 0.5, 0.75, 2600, { verb: 0.35, echo: 0.25, attack: 0.02 });
    this.noiseHit('bandpass', 900, 0.8, 0.22, 0.9, 3800, { attack: 0.05, delay: 0.05 });
    for (let i = 0; i < 6; i++) this.noiseHit('highpass', 5000, 1, 0.05, 0.015, 0, { delay: 0.05 + i * 0.045 + Math.random() * 0.02 });
  }
  // layered: crack + mid crunch + long sub rumble sweep + debris rattles; distance-scaled
  explosion(big = 1, near = 1, pan = 0) {
    const k = big * (0.3 + 0.7 * near), o = { pan: pan * 0.7, verb: 0.5, echo: 0.3 };
    this.duck(0.3 + 0.4 * near, 0.25 + 0.4 * big);
    this.noiseHit('highpass', 2500, 0.8, 0.5 * k, 0.04, 0, { ...o, attack: 0.0008 });
    this.noiseHit('bandpass', 800, 0.9, 0.55 * k, 0.32 * big, 300, { ...o, drive: true });
    this.noiseHit('lowpass', 1600, 0.8, 0.45 * k, 1.1 * big, 70, o);
    this.tone('sine', 90, 24, 0.7 * k, 1.5 * big, 0, { verb: 0.3 });
    this.tone('triangle', 58, 22, 0.35 * k, 1.8 * big, 0.04);
    for (let i = 0; i < 7; i++) this.noiseHit('bandpass', 1800 + Math.random() * 3500, 6, 0.06 * k, 0.03, 0, { delay: 0.2 + Math.random() * 0.9, pan: pan + (Math.random() - 0.5) * 0.6 });
  }
  // hit marker: crisp high double tick on the UI bus (cuts through everything); the score chime confirms the kill
  hitTick() { this.duck(0.4, 0.1); this.tone('square', 2900, 2700, 0.045, 0.03, 0, { ui: true, attack: 0.0006 }); this.tone('sine', 4200, 3900, 0.04, 0.025, 0.035, { ui: true, attack: 0.0006 }); }
  impact() { this.noiseHit('bandpass', 2200, 1.5, 0.12, 0.05, 0, { echo: 0.2 }); this.tone('square', 600, 200, 0.02, 0.04); }
  shieldHit() {
    this.duck(0.45, 0.2);
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
  // spotter scanner: one light cold sine tick per cyan ping, panned to the drone.
  // The second tap of the pair sits a little higher. Distinct from the square MARK beep on the UI bus.
  markPing(pan = 0, m = 0, second = false) {
    if (!this.ctx) return;
    const f = (second ? 2280 : 1860) + m * 260;
    const peak = (second ? 0.015 : 0.024) + m * 0.01;
    this.tone('sine', f, f * 0.93, peak, 0.036, 0, { pan, attack: 0.001, verb: 0.18 });
  }
  lockOn() { this.tone('square', 1800, 1800, 0.06, 0.5, 0, { ui: true }); this.tone('square', 1805, 1805, 0.04, 0.5, 0, { ui: true }); }
  laser() { this.tone('sawtooth', 220, 180, 0.04, 0.9); }
  turretShot(pan = 0) {
    // launch whoosh + thump from the rim
    this.noiseHit('bandpass', 400, 1.2, 0.2, 0.45, 2400, { pan, verb: 0.5, attack: 0.03 });
    this.tone('sine', 140, 50, 0.22, 0.25, 0, { pan, verb: 0.3 });
    this.tone('sawtooth', 500, 90, 0.05, 0.25, 0, { pan });
  }
  lost() { this.tone('sine', 660, 330, 0.05, 0.6, 0, { ui: true }); }
  hit() { this.duck(0.5, 0.25); this.tone('sine', 90, 40, 0.5, 0.35); this.tone('triangle', 220, 140, 0.18, 0.25); this.noiseHit('bandpass', 700, 1.2, 0.35, 0.3, 0, { drive: true, verb: 0.2 }); }
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
  // ---------------------------------------------------------------- round 4: naval layer
  // armour ricochet: bright metallic ting + short whine
  ricochet(pan = 0) {
    if (!this.ctx) return;
    const v = 1 + (Math.random() - 0.5) * 0.12;
    this.tone('triangle', 3300 * v, 2500 * v, 0.07, 0.14, 0, { pan, attack: 0.0008, verb: 0.15 });
    this.tone('sine', 5200 * v, 4700 * v, 0.035, 0.09, 0.004, { pan, attack: 0.0008 });
    this.tone('sine', 1900 * v, 900 * v, 0.03, 0.22, 0.03, { pan });
    this.noiseHit('highpass', 4000, 1, 0.12, 0.02, 0, { pan, attack: 0.0006 });
  }
  // hunter-sub acquiring: sonar ping with a long tail
  sonar(pan = 0) { if (this.ctx) { this.tone('sine', 1450, 1440, 0.09, 0.9, 0, { pan, attack: 0.004, verb: 0.6 }); this.tone('sine', 1450, 1440, 0.04, 0.6, 0.45, { pan, verb: 0.6 }); } }
  hunterCharge(pan = 0) { if (this.ctx) this.tone('sine', 420, 1500, 0.05, 0.5, 0, { pan, attack: 0.4 }); }
  hunterShot(pan = 0) { if (this.ctx) { this.tone('sine', 900, 160, 0.12, 0.25, 0, { pan, attack: 0.002 }); this.noiseHit('lowpass', 900, 1, 0.18, 0.2, 200, { pan }); } }
  // patrol boat about to fire: two short horn blips
  boatApproach(pan = 0) { this.tone('sawtooth', 72, 65, 0.045, 1.3, 0, {pan, attack:0.15, verb:0.25}); this.tone('triangle', 180, 155, 0.08, 0.7, 0.15, {pan, attack:0.08, verb:0.4}); }
  boatAlarm(pan = 0) { if (this.ctx) for (let i = 0; i < 2; i++) this.tone('square', 540, 520, 0.035, 0.12, i * 0.16, { pan, attack: 0.004 }); }
  // round 11 tutorial slow-mo depth 0..1: everything drops up to ~a fourth and loses its top end (the sting is exempt)
  slowmo(k) {
    if (!this.ctx || Math.abs(k - this.slowK) < 1e-3) return;
    this.slowK = k; this.pitch = 1 - 0.3 * k;
    for (const s of this.loops) s.playbackRate.setTargetAtTime(this.pitch, this.ctx.currentTime, 0.05);
    this.set(this.lp.frequency, 18000 * Math.pow(0.05, k), 0.05);
  }
  // "Boat ahead!" sting: a radio-voice formant chirp ("wo-AH"), a two-tone horn under it and a rising whoosh.
  // On the UI bus and exempt from the slow-mo pitch drop so it cuts through the muffled world.
  tutorialSting() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, out = c.createGain(); out.gain.value = 1; out.connect(this.ui);
    const vs = c.createGain(); vs.gain.value = 0.0001; vs.connect(out);
    vs.gain.setValueAtTime(0.0001, t); vs.gain.exponentialRampToValueAtTime(0.5, t + 0.04);
    vs.gain.setValueAtTime(0.5, t + 0.32); vs.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
    // two glottal pulses through three gliding formants (/o/ -> /a/)
    const src = c.createOscillator(), src2 = c.createOscillator(); src.type = src2.type = 'sawtooth';
    src.frequency.setValueAtTime(150, t); src.frequency.linearRampToValueAtTime(205, t + 0.18); src.frequency.exponentialRampToValueAtTime(128, t + 0.6);
    src2.frequency.setValueAtTime(151.5, t); src2.frequency.linearRampToValueAtTime(207, t + 0.18); src2.frequency.exponentialRampToValueAtTime(129, t + 0.6);
    for (const [fa, fb, q, g] of [[480, 760, 9, 0.9], [850, 1250, 11, 0.55], [2400, 2600, 14, 0.22]]) {
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q;
      bp.frequency.setValueAtTime(fa, t); bp.frequency.linearRampToValueAtTime(fb, t + 0.2);
      const gg = c.createGain(); gg.gain.value = g; src.connect(bp); src2.connect(bp); bp.connect(gg); gg.connect(vs);
    }
    src.start(t); src2.start(t); src.stop(t + 0.7); src2.stop(t + 0.7);
    // two-tone horn (low, soft) after the chirp
    this.tone('sawtooth', 233, 231, 0.05, 0.28, 0.12, { ui: true, raw: true, attack: 0.03 });
    this.tone('sawtooth', 311, 309, 0.04, 0.28, 0.42, { ui: true, raw: true, attack: 0.03 });
    // whoosh: band-passed noise sweeping up, then down into the slow-mo
    this.noiseHit('bandpass', 280, 1.4, 0.32, 0.55, 2600, { ui: true, raw: true, attack: 0.3 });
    this.noiseHit('lowpass', 2400, 0.7, 0.18, 0.9, 260, { ui: true, raw: true, attack: 0.05, delay: 0.5 });
  }
  empty() { this.tone('square', 220, 200, 0.04, 0.06, 0, { ui: true }); }
  // ---------------------------------------------------------------- round 12: torpedo + close-range punish
  // launch: hull "thunk" + compressed-air bubble gurgle, then a ~2.4 s receding propeller whirr (tremolo, falling lowpass)
  torpedo() {
    if (!this.ctx) return;
    this.duck(0.55, 0.4);
    this.tone('sine', 120, 38, 0.7, 0.32, 0, { verb: 0.3, attack: 0.003 });
    this.tone('triangle', 70, 30, 0.35, 0.45, 0.01);
    this.noiseHit('lowpass', 700, 2.5, 0.45, 0.5, 160, { verb: 0.3, attack: 0.01 });
    for (let i = 0; i < 9; i++) this.tone('sine', 380 + Math.random() * 520, 900 + Math.random() * 700, 0.05, 0.05 + Math.random() * 0.05, 0.04 + i * 0.035 + Math.random() * 0.02, { attack: 0.003 });
    const c = this.ctx, t = c.currentTime + 0.12, dur = 2.4, k = this.pitch;
    const osc = c.createOscillator(), lp = c.createBiquadFilter(), g = c.createGain(), trem = c.createOscillator(), tg = c.createGain();
    osc.type = 'sawtooth'; osc.frequency.setValueAtTime(95 * k, t); osc.frequency.exponentialRampToValueAtTime(210 * k, t + 0.5); osc.frequency.exponentialRampToValueAtTime(170 * k, t + dur);
    lp.type = 'lowpass'; lp.Q.value = 4; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(260, t + dur);
    trem.frequency.value = 22; tg.gain.value = 0.5; trem.connect(tg); tg.connect(g.gain);
    osc.connect(lp); lp.connect(g); this.route(g, { verb: 0.25 });
    this.env(g, t, 0.15, 0.12, dur);
    osc.start(t); trem.start(t); osc.stop(t + dur + 0.1); trem.stop(t + dur + 0.1);
  }
  // lock acquired: two short sonar-ish pings on the UI bus
  torpedoLock() { if (this.ctx) { this.tone('sine', 1180, 1180, 0.06, 0.09, 0, { ui: true }); this.tone('sine', 1570, 1570, 0.06, 0.12, 0.1, { ui: true }); } }
  // close-range punish telegraph: rising siren on the boat
  punishAlarm(pan = 0) { if (this.ctx) { this.tone('sawtooth', 380, 1250, 0.06, 0.55, 0, { pan, attack: 0.02 }); this.tone('square', 760, 2500, 0.025, 0.55, 0, { pan, attack: 0.02 }); } }
  // round 15: boat scan. A rising chirp as the beam catches, a dull lock tone, then a soft tick while it holds.
  scanCatch(pan = 0) {
    if (!this.ctx) return;
    this.tone('sine', 520, 860, 0.045, 0.2, 0, { pan, attack: 0.012, verb: 0.22 });
    this.tone('triangle', 1040, 1480, 0.022, 0.16, 0.05, { pan, attack: 0.01 });
  }
  scanLock(pan = 0) {
    if (!this.ctx) return;
    this.tone('sawtooth', 180, 90, 0.05, 0.38, 0, { pan, attack: 0.02, verb: 0.28 });
    this.tone('square', 410, 260, 0.028, 0.22, 0.02, { pan, attack: 0.008 });
    this.noiseHit('bandpass', 880, 1.6, 0.07, 0.32, 220, { pan, attack: 0.02 });
  }
  scanTick(pan = 0) {
    if (!this.ctx) return;
    this.tone('sine', 760, 700, 0.028, 0.07, 0, { pan, ui: true, attack: 0.004 });
  }
  // breach punch under the explosion: a short sub thump and a pressure whoosh. No samples.
  shockWave(pan = 0) {
    if (!this.ctx) return;
    this.tone('sine', 46, 20, 0.5, 0.62, 0, { pan, verb: 0.4, attack: 0.003 });
    this.tone('triangle', 70, 28, 0.18, 0.4, 0.01, { pan, verb: 0.25 });
    this.noiseHit('lowpass', 480, 0.7, 0.32, 0.4, 70, { pan, verb: 0.3, attack: 0.002 });
  }
  // round 14: a hull giving way — low metal groan, flooding hiss, bubble ticks. No samples.
  boatSink(pan = 0) {
    if (!this.ctx) return;
    this.duck(0.35, 0.35);
    this.tone('sawtooth', 130, 36, 0.14, 1.35, 0, { pan, verb: 0.45, attack: 0.03 });
    this.tone('triangle', 78, 26, 0.2, 1.7, 0.05, { pan, verb: 0.3, attack: 0.04 });
    this.noiseHit('lowpass', 820, 0.7, 0.26, 1.5, 110, { pan, verb: 0.35, attack: 0.06 });
    for (let i = 0; i < 8; i++) {
      this.tone('sine', 400 + Math.random() * 360, 680 + Math.random() * 480, 0.035, 0.05 + Math.random() * 0.05, 0.1 + i * 0.12 + Math.random() * 0.04, { pan, attack: 0.004 });
    }
  }
}
