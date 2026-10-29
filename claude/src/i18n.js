// Round 25: plain key-based i18n. One static ES module per language in ./lang (no fetches, works offline).
// t(key, {params}) looks the key up in the current language, falls back to English (console.warn once per key).
// Static DOM: data-i18n="key" (innerHTML; dictionaries are our own trusted strings), data-i18n-title, data-i18n-aria.
import en from './lang/en.js?v=r33';
import ru from './lang/ru.js?v=r33';
import de from './lang/de.js?v=r33';
import es from './lang/es.js?v=r33';
import pl from './lang/pl.js?v=r33';
import fr from './lang/fr.js?v=r33';
import ptBR from './lang/pt-BR.js?v=r33';
import zhHans from './lang/zh-Hans.js?v=r33';
import ja from './lang/ja.js?v=r33';
import ko from './lang/ko.js?v=r33';
import hi from './lang/hi.js?v=r33';
import id from './lang/id.js?v=r33';

export const LANGS = [
  { code: 'en', name: 'English' }, { code: 'ru', name: 'Русский' }, { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' }, { code: 'pl', name: 'Polski' }, { code: 'fr', name: 'Français' },
  { code: 'pt-BR', name: 'Português (Brasil)' }, { code: 'zh-Hans', name: '中文' }, { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' }, { code: 'hi', name: 'हिन्दी' }, { code: 'id', name: 'Bahasa Indonesia' },
];
const DICT = { en, ru, de, es, pl, fr, 'pt-BR': ptBR, 'zh-Hans': zhHans, ja, ko, hi, id };
const LS_LANG = 'lethe.lang';

// 'zh-CN' / 'zh-TW' / 'zh' -> zh-Hans, 'pt' / 'pt-PT' -> pt-BR, 'in' (old Java code) -> id, 'de-AT' -> de; unknown -> null
export function normLang(code) {
  if (!code) return null;
  const c = String(code).trim().toLowerCase().replace('_', '-');
  const exact = LANGS.find((l) => l.code.toLowerCase() === c);
  if (exact) return exact.code;
  const base = c.split('-')[0];
  if (base === 'zh') return 'zh-Hans';
  if (base === 'pt') return 'pt-BR';
  if (base === 'in') return 'id';
  return LANGS.find((l) => l.code === base)?.code || null;
}
const lsGet = () => { try { return localStorage.getItem(LS_LANG); } catch (e) { return null; } };
function detect() {
  const url = normLang(new URLSearchParams(location.search).get('lang'));
  if (url) return url;
  const saved = normLang(lsGet());
  if (saved) return saved;
  for (const l of navigator.languages || [navigator.language]) { const n = normLang(l); if (n) return n; }
  return 'en';
}

let lang = detect();
const warned = new Set();
const subs = [];

export function t(key, params) {
  let s = DICT[lang][key];
  if (s == null) {
    if (!warned.has(lang + '|' + key)) { warned.add(lang + '|' + key); console.warn('[i18n] missing', lang, key); }
    s = en[key] ?? key;
  }
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? params[k] : m));
  return s;
}
export const getLang = () => lang;
export const onLang = (fn) => { subs.push(fn); };

export function applyDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.innerHTML = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  document.documentElement.lang = lang;
  document.title = t('doc.title');
}

export function setLang(code, persist = true) {
  const n = normLang(code);
  if (!n) return lang;
  lang = n;
  if (persist) { try { localStorage.setItem(LS_LANG, n); } catch (e) { /* private mode */ } }
  applyDom();
  for (const fn of subs) fn(lang);
  return lang;
}

// keys present in English but absent in `code` (default: current language)
export function missing(code = lang) {
  const d = DICT[normLang(code)] || {};
  return Object.keys(en).filter((k) => d[k] == null);
}
export function missingAll() {
  return Object.fromEntries(LANGS.map((l) => [l.code, missing(l.code)]));
}

export const i18n = {
  get lang() { return lang; }, setLang, missing, missingAll, t, langs: LANGS.map((l) => l.code),
  keys: () => Object.keys(en).length,
};
