// Round 29: the four silent Part 1 films (intro, briefing, success, fail) as a fullscreen letterboxed overlay.
// play(name) -> Promise that resolves when the film ends, is skipped (SKIP button, tap anywhere, Esc / Enter / Space)
// or fails to load/play (never blocks the game). While a film is on, `films.active` is true and main.js pauses its loop.
import { t as tx } from './i18n.js?v=r32';
const SRC = { intro: 'assets/films/intro.mp4?v=r32', briefing: 'assets/films/briefing.mp4?v=r32', success: 'assets/films/success.mp4?v=r32', fail: 'assets/films/fail.mp4?v=r32' };
const STALL_S = 12;   // nothing decoded for this long -> give up quietly
let root = null, vid = null, skipBtn = null, done = null, cur = null, stallT = 0, lastT = -1, stallIv = 0;
function build() {
  if (root) return;
  root = document.createElement('div'); root.id = 'film'; root.className = 'hide';
  root.innerHTML = '<video playsinline webkit-playsinline muted preload="auto" disablepictureinpicture></video>' +
    '<button type="button" id="filmSkip"><span data-i18n="film.skip"></span><b>›</b></button>';
  document.body.appendChild(root);
  vid = root.querySelector('video'); skipBtn = root.querySelector('#filmSkip');
  vid.muted = true; vid.defaultMuted = true; vid.playsInline = true;
  vid.addEventListener('ended', () => finish('ended'));
  vid.addEventListener('error', () => finish('error'));
  const skip = (e) => { e.preventDefault(); e.stopPropagation(); finish('skip'); };
  skipBtn.addEventListener('click', skip);
  root.addEventListener('click', skip);
  for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'touchend']) root.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  // capture phase: the game's own Enter / Space handler must not also start or restart the mission
  addEventListener('keydown', (e) => {
    if (!films.active) return;
    e.stopImmediatePropagation(); e.preventDefault();
    if (!e.repeat && (e.code === 'Escape' || e.code === 'Enter' || e.code === 'Space')) finish('skip');
  }, true);
}
function finish(how) {
  if (!films.active) return;
  films.active = false; films.last = { name: cur, how };
  clearInterval(stallIv);
  try { vid.pause(); } catch (e) { /* ignore */ }
  vid.removeAttribute('src'); try { vid.load(); } catch (e) { /* ignore */ }
  root.classList.add('hide'); document.body.classList.remove('film-on');
  const d = done; done = null; cur = null;
  if (d) d(how);
}
export const films = {
  active: false, last: null, enabled: true,
  get name() { return cur; },
  play(name) {
    if (!films.enabled || !SRC[name]) return Promise.resolve('off');
    build();
    if (films.active) finish('replaced');
    cur = name; films.active = true;
    const lbl = skipBtn.querySelector('span'); lbl.textContent = tx('film.skip');
    root.dataset.film = name;
    root.classList.remove('hide'); document.body.classList.add('film-on');
    vid.src = SRC[name]; vid.currentTime = 0;
    stallT = 0; lastT = -1;
    clearInterval(stallIv);
    stallIv = setInterval(() => {
      if (!films.active) return;
      if (vid.currentTime !== lastT) { lastT = vid.currentTime; stallT = 0; } else if ((stallT += 0.5) >= STALL_S) finish('stall');
    }, 500);
    const p = vid.play();
    if (p && p.catch) p.catch(() => { setTimeout(() => { if (films.active && vid.paused && cur === name) vid.play().catch(() => finish('blocked')); }, 300); });
    return new Promise((res) => { done = res; });
  },
  skip() { finish('skip'); },
  relabel() { if (skipBtn) skipBtn.querySelector('span').textContent = tx('film.skip'); },
};
