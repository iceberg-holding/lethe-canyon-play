// Round 29: the four Part 1 films (intro, briefing, success, fail) as a fullscreen letterboxed overlay.
// Round 33: voice-over + subtitles.
//   Video+voice files are muxed per voice language: assets/films/<name>.<voiceLang>.mp4 (one media element = no A/V drift,
//   one autoplay unlock on mobile). Subtitles are separate WebVTT files, assets/films/subs/<name>.<lang>.vtt, drawn by us
//   (not burned in, not <track>, so the style is ours and identical everywhere).
//   Voice: game language if it has a recording, else VOICE_FALLBACK. Subtitles: game language if a .vtt exists, else none.
//   To add a language later: drop <name>.<lang>.mp4 and/or subs/<name>.<lang>.vtt and list it in VOICE / SUBS below.
// play(name) -> Promise that resolves when the film ends, is skipped (SKIP button, tap anywhere, Esc / Enter / Space)
// or fails to load/play (never blocks the game). While a film is on, `films.active` is true and main.js pauses its loop.
// Sound follows the game setting (mute + volume, M key / speaker button in the film); the game's own WebAudio is
// suspended while a film plays. If the browser refuses sound autoplay, the film still plays muted and the speaker
// button (a user gesture) turns the voice on.
import { t as tx, getLang } from './i18n.js?v=r36';
const V = '?v=r36';
const NAMES = ['intro', 'briefing', 'success', 'fail'];
const VOICE = ['ru', 'en', 'de', 'es', 'pl'];             // languages with a recorded voice-over
const VOICE_FALLBACK = 'ru';        // everyone else hears this one (for now: Russian voice, no subtitles)
const SUBS = ['ru', 'en', 'de', 'es', 'pl'];              // languages with subtitle files
const STALL_S = 12;   // nothing decoded for this long -> give up quietly
const voiceLang = () => { const l = getLang(); return VOICE.includes(l) ? l : VOICE_FALLBACK; };
const subLang = () => { const l = getLang(); return SUBS.includes(l) ? l : null; };
const srcOf = (name) => `assets/films/${name}.${voiceLang()}.mp4${V}`;
let root = null, vid = null, skipBtn = null, sndBtn = null, subEl = null, done = null, cur = null, stallT = 0, lastT = -1, stallIv = 0;
let audio = null, ctxSuspended = false, forcedMute = false, cues = [], cueShown = -2, raf = 0;
const vttCache = new Map();
function parseVtt(txt) {
  const out = [], ts = (s) => { const p = s.trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  for (const block of txt.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n'), i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->'); const text = lines.slice(i + 1).join('\n').trim();
    if (text) out.push({ a: ts(a), b: ts(b.trim().split(/\s+/)[0]), text });
  }
  return out;
}
function loadSubs(name) {
  const l = subLang(); if (!l) return Promise.resolve([]);
  const url = `assets/films/subs/${name}.${l}.vtt${V}`;
  if (!vttCache.has(url)) vttCache.set(url, fetch(url).then((r) => (r.ok ? r.text() : '')).then(parseVtt).catch(() => []));
  return vttCache.get(url);
}
function subTick() {
  raf = 0;
  if (!films.active) return;
  const t = vid.currentTime; let k = -1;
  for (let i = 0; i < cues.length; i++) if (t >= cues[i].a && t < cues[i].b) { k = i; break; }
  if (k !== cueShown) { cueShown = k; subEl.textContent = k >= 0 ? cues[k].text : ''; subEl.classList.toggle('on', k >= 0); }
  raf = requestAnimationFrame(subTick);
}
function wantMuted() { return !!(audio && audio.muted); }
function applySound() {
  if (!vid) return;
  const m = wantMuted() || forcedMute;
  vid.muted = m; vid.volume = audio ? Math.max(0, Math.min(1, audio.vol)) : 1;
  sndBtn.classList.toggle('muted', m); sndBtn.classList.toggle('ask', forcedMute && !wantMuted());
}
function toggleSound() {
  if (forcedMute) { forcedMute = false; if (audio && audio.muted) audio.toggleMute(); }   // user gesture: voice on
  else if (audio) audio.toggleMute(); else forcedMute = !forcedMute;
  applySound();
  if (vid && films.active && vid.paused) vid.play().catch(() => {});
}
function build() {
  if (root) return;
  root = document.createElement('div'); root.id = 'film'; root.className = 'hide';
  root.innerHTML = '<video playsinline webkit-playsinline preload="auto" disablepictureinpicture></video>' +
    '<div id="filmSub" aria-live="off"></div>' +
    '<button type="button" id="filmSnd" aria-label="sound"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>' +
    '<path class="w" d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path class="x" d="M16 9l6 6M22 9l-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>' +
    '<button type="button" id="filmSkip"><span data-i18n="film.skip"></span><b>›</b></button>';
  document.body.appendChild(root);
  vid = root.querySelector('video'); skipBtn = root.querySelector('#filmSkip'); sndBtn = root.querySelector('#filmSnd'); subEl = root.querySelector('#filmSub');
  vid.playsInline = true;
  vid.addEventListener('ended', () => finish('ended'));
  vid.addEventListener('error', () => finish('error'));
  const skip = (e) => { e.preventDefault(); e.stopPropagation(); finish('skip'); };
  skipBtn.addEventListener('click', skip);
  sndBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleSound(); });
  root.addEventListener('click', skip);
  for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'touchend']) root.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  // capture phase: the game's own Enter / Space handler must not also start or restart the mission
  addEventListener('keydown', (e) => {
    if (!films.active) return;
    e.stopImmediatePropagation(); e.preventDefault();
    if (e.repeat) return;
    if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'Space') finish('skip');
    else if (e.code === 'KeyM') toggleSound();
  }, true);
}
function suspendGame() {
  try { if (audio && audio.ctx && audio.ctx.state === 'running') { audio.ctx.suspend(); ctxSuspended = true; } } catch (e) { /* ignore */ }
}
function resumeGame() {
  if (!ctxSuspended) return; ctxSuspended = false;
  try { audio.ctx.resume(); } catch (e) { /* ignore */ }
}
function finish(how) {
  if (!films.active) return;
  films.active = false; films.last = { name: cur, how };
  clearInterval(stallIv); if (raf) cancelAnimationFrame(raf); raf = 0;
  try { vid.pause(); } catch (e) { /* ignore */ }
  vid.removeAttribute('src'); try { vid.load(); } catch (e) { /* ignore */ }
  subEl.textContent = ''; subEl.classList.remove('on'); cues = []; cueShown = -2;
  root.classList.add('hide'); document.body.classList.remove('film-on');
  resumeGame();
  const d = done; done = null; cur = null;
  if (d) d(how);
}
export const films = {
  active: false, last: null, enabled: true,
  get name() { return cur; },
  get soundBlocked() { return forcedMute; },
  get voice() { return voiceLang(); },
  get subs() { return subLang(); },
  get cue() { return subEl ? subEl.textContent : ''; },
  // main.js hands over the game's Audio so films follow its mute / volume and pause its WebAudio while playing
  bindAudio(a) { audio = a; if (a && a.listeners) a.listeners.push(() => applySound()); },
  play(name) {
    if (!films.enabled || !NAMES.includes(name)) return Promise.resolve('off');
    build();
    if (films.active) finish('replaced');
    cur = name; films.active = true; forcedMute = false;
    const lbl = skipBtn.querySelector('span'); lbl.textContent = tx('film.skip');
    root.dataset.film = name;
    root.classList.remove('hide'); document.body.classList.add('film-on');
    cues = []; cueShown = -2; subEl.textContent = ''; subEl.classList.remove('on');
    loadSubs(name).then((c) => { if (cur === name) cues = c; });
    suspendGame();
    applySound();
    vid.src = srcOf(name); vid.currentTime = 0;
    stallT = 0; lastT = -1;
    clearInterval(stallIv);
    stallIv = setInterval(() => {
      if (!films.active) return;
      if (vid.currentTime !== lastT) { lastT = vid.currentTime; stallT = 0; } else if ((stallT += 0.5) >= STALL_S) finish('stall');
    }, 500);
    raf = requestAnimationFrame(subTick);
    const p = vid.play();
    if (p && p.catch) p.catch((err) => {
      if (!films.active || cur !== name) return;
      // autoplay with sound refused (no user gesture yet): play muted, the speaker button turns the voice on
      if (!vid.muted && err && err.name === 'NotAllowedError') { forcedMute = true; applySound(); vid.play().catch(() => finish('blocked')); return; }
      setTimeout(() => { if (films.active && vid.paused && cur === name) vid.play().catch(() => finish('blocked')); }, 300);
    });
    return new Promise((res) => { done = res; });
  },
  skip() { finish('skip'); },
  relabel() { if (skipBtn) skipBtn.querySelector('span').textContent = tx('film.skip'); },
};
