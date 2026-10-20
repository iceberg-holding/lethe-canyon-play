// WebAudio synth: engine, wind, cannons, explosions, splashes, geiger crackle.
export class Audio {
  constructor() { this.ctx = null; this.under = 0; }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = 0.8;
    this.lp = c.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 18000;
    const comp = c.createDynamicsCompressor();
    this.master.connect(this.lp); this.lp.connect(comp); comp.connect(c.destination);
    // noise buffer
    const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    // engine: two detuned saws through a lowpass
    this.engGain = c.createGain(); this.engGain.gain.value = 0;
    this.engLP = c.createBiquadFilter(); this.engLP.type = 'lowpass'; this.engLP.frequency.value = 400;
    this.osc1 = c.createOscillator(); this.osc1.type = 'sawtooth'; this.osc1.frequency.value = 55;
    this.osc2 = c.createOscillator(); this.osc2.type = 'sawtooth'; this.osc2.frequency.value = 55.7;
    this.osc3 = c.createOscillator(); this.osc3.type = 'triangle'; this.osc3.frequency.value = 110;
    for (const o of [this.osc1, this.osc2, this.osc3]) { o.connect(this.engLP); o.start(); }
    this.engLP.connect(this.engGain); this.engGain.connect(this.master);
    // wind / spray noise
    this.wind = this.loopNoise('bandpass', 900, 0.6);
    this.spray = this.loopNoise('highpass', 2500, 0.7);
    this.bubble = this.loopNoise('lowpass', 300, 1);
  }
  loopNoise(type, f, q) {
    const c = this.ctx, src = c.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = c.createGain(); g.gain.value = 0;
    src.connect(fl); fl.connect(g); g.connect(this.master); src.start();
    return { g, fl };
  }
  set(param, v, k = 0.08) { param.setTargetAtTime(v, this.ctx.currentTime, k); }
  update(speed, boost, underwater, skim, running) {
    if (!this.ctx) return;
    const sp = Math.min(speed / 95, 1.2);
    const on = running ? 1 : 0;
    this.set(this.engGain.gain, on * (0.06 + 0.05 * sp + boost * 0.03));
    const base = underwater ? 38 : 48 + sp * 34 + boost * 10;
    this.set(this.osc1.frequency, base); this.set(this.osc2.frequency, base * 1.012); this.set(this.osc3.frequency, base * 2.01);
    this.set(this.engLP.frequency, underwater ? 220 : 280 + sp * 700 + boost * 500);
    this.set(this.wind.g.gain, on * (underwater ? 0 : 0.03 + 0.09 * sp * sp + boost * 0.05));
    this.set(this.wind.fl.frequency, 500 + sp * 900);
    this.set(this.spray.g.gain, on * skim * 0.12);
    this.set(this.bubble.g.gain, on * (underwater ? 0.16 : 0));
    this.set(this.lp.frequency, underwater ? 650 : 18000, 0.12);
  }
  env(node, t0, a, peak, dec) {
    node.gain.setValueAtTime(0.0001, t0);
    node.gain.exponentialRampToValueAtTime(peak, t0 + a);
    node.gain.exponentialRampToValueAtTime(0.0001, t0 + a + dec);
  }
  noiseHit(type, f, q, peak, dec, fEnd) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime, src = c.createBufferSource();
    src.buffer = this.noise;
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
    if (fEnd) fl.frequency.exponentialRampToValueAtTime(fEnd, t + dec);
    const g = c.createGain();
    src.connect(fl); fl.connect(g); g.connect(this.master);
    this.env(g, t, 0.004, peak, dec);
    src.start(t, Math.random() * 1.5); src.stop(t + dec + 0.05);
  }
  tone(type, f0, f1, peak, dec, delay = 0) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dec);
    o.connect(g); g.connect(this.master);
    this.env(g, t, 0.005, peak, dec);
    o.start(t); o.stop(t + dec + 0.05);
  }
  shot() { this.tone('square', 1300, 180, 0.05, 0.09); this.noiseHit('highpass', 3000, 0.7, 0.05, 0.05); }
  explosion(big = 1) {
    this.noiseHit('lowpass', 2400, 0.8, 0.5 * big, 0.9 * big, 80);
    this.tone('sine', 120, 35, 0.45 * big, 0.6);
  }
  hit() { this.tone('sine', 90, 40, 0.5, 0.35); this.tone('triangle', 220, 140, 0.18, 0.25); this.noiseHit('bandpass', 700, 1.2, 0.35, 0.3); }
  splash() { this.noiseHit('bandpass', 1400, 0.6, 0.45, 0.6, 400); this.noiseHit('lowpass', 500, 0.7, 0.3, 0.4); }
  click() { this.noiseHit('highpass', 4000, 0.5, 0.25, 0.012); }
  beep(f = 880) { this.tone('sine', f, f, 0.08, 0.12); }
  collapse() { this.tone('sawtooth', 700, 50, 0.16, 1.4); this.tone('sine', 300, 30, 0.2, 1.6, 0.1); }
  dive() { this.tone('sine', 260, 120, 0.12, 0.3); this.noiseHit('lowpass', 1200, 1, 0.15, 0.25); }
  score() { this.tone('sine', 880, 1320, 0.07, 0.12); }
}
