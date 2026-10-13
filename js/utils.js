// ── Utilities: DOM helpers, formatting, units, safe SVG ──
import { KG_PER_LB as _KG_PER_LB, WEIGHT_EPS_KG as _EPS } from './config.js';
import { state } from './state.js';

// DOM helper
export const gid = id => document.getElementById(id);
export const mk = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// Safe SVG allowlist
const SVG_OK_EL = new Set(['svg','defs','lineargradient','stop','line','text','path','circle','rect','g','polyline']);
const SVG_OK_ATTR = new Set(['class','viewbox','xmlns','id','x','y','x1','x2','y1','y2','cx','cy','r','d','fill','stroke','stroke-width','stroke-dasharray','stroke-linejoin','stroke-linecap','text-anchor','offset','stop-color','stop-opacity','width','height','points','style']);

export function appendTrustedSvg(parent, svgStr) {
  let doc; try { doc = new DOMParser().parseFromString(svgStr, 'image/svg+xml'); } catch (e) { return null; }
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) return null;
  const clean = el => {
    Array.from(el.children).forEach(ch => {
      if (!SVG_OK_EL.has(ch.localName.toLowerCase())) { ch.remove(); return; }
      clean(ch);
    });
    Array.from(el.attributes).forEach(a => {
      const n = a.name.toLowerCase();
      if (!SVG_OK_ATTR.has(n) || (n === 'style' && !/^[\w\s:;#.,%()-]*$/.test(a.value)) || /javascript:|url\((?!#)/i.test(a.value))
        el.removeAttribute(a.name);
    });
  };
  clean(root);
  const node = document.importNode(root, true);
  parent.appendChild(node);
  return node;
}

// Colours loaded from saved data are validated.
export const safeColor = c =>
  (typeof c === 'string' && /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%\/-]+\)|[a-z]{3,20})$/i.test(c.trim())) ? c.trim() : '#888';

// Date formatting
export const fmtDate = d => {
  if (!d || typeof d !== 'string') return '';
  const [, m, dy] = d.split('-');
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1];
  return mo ? mo + ' ' + (+dy) : d;
};

export function pad2(n) { return String(n).padStart(2, '0'); }

export function localISO(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
}

export function fmtClock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return pad2(Math.floor(t / 3600)) + ':' + pad2(Math.floor(t % 3600 / 60)) + ':' + pad2(t % 60);
}
export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  if (h > 0) return h + 'h ' + pad2(m) + 'm';
  if (m > 0) return m + 'm';
  return sec + 's';
}

// ── Unit helpers ─────────────────────────────────────
const KG_PER_LB = _KG_PER_LB;
const WEIGHT_EPS_KG = _EPS;
export const unitOf = u => (typeof u === 'string' && /^lbs?$/i.test(u.trim())) ? 'lb' : 'kg';
export function toKg(weight, unit = 'kg') {
  const w = Number(weight);
  if (!isFinite(w)) return 0;
  return unitOf(unit) === 'lb' ? w * KG_PER_LB : w;
}
export function fromKg(weight, unit = 'kg') {
  const w = Number(weight);
  if (!isFinite(w)) return 0;
  return unitOf(unit) === 'lb' ? w / KG_PER_LB : w;
}
export function convertWeight(w, from, to) {
  return unitOf(from) === unitOf(to) ? Number(w) : fromKg(toKg(w, from), to);
}
export function compareWeights(aW, aU, bW, bU) {
  const d = toKg(aW, aU) - toKg(bW, bU);
  return Math.abs(d) <= WEIGHT_EPS_KG ? 0 : (d > 0 ? 1 : -1);
}
export function compareSets(a, b) {
  const c = compareWeights(a.weight, a.unit, b.weight, b.unit);
  if (c !== 0) return c;
  const ra = Number(a.reps) || 0, rb = Number(b.reps) || 0;
  return ra === rb ? 0 : (ra > rb ? 1 : -1);
}
export const fmtW = n => String(+Number(n).toFixed(2));
export const rowFromSet = s => ({
  w: String(s.weight), r: String(s.reps), u: unitOf(s.unit),
  o: { w: Number(s.weight), u: unitOf(s.unit), shown: String(s.weight) }
});
export const getPR = sessions => {
  let pr = null;
  sessions.forEach(s => (s.sets || []).forEach(set => {
    if (!pr || compareSets(set, pr) > 0) pr = { ...set, unit: unitOf(set.unit), date: s.date };
  }));
  return pr;
};
export const bestSet = sess =>
  (sess.sets && sess.sets.length) ? sess.sets.reduce((b, s) => compareSets(s, b) > 0 ? s : b, sess.sets[0]) : { weight: 0, reps: 0, unit: 'kg' };

// ── Category helpers (read against state) ────────────
export const catById  = id => state.CATS.find(c => c.id === id);
export const catColor = id => catById(id)?.color || '#888';
export const catLabel = id => catById(id)?.label || id;
export const primCat  = name => {
  for (const c of state.CATS) if ((state.EX[c.id] || []).includes(name)) return c.id;
  return state.CATS[0]?.id || 'other';
};
export const allNames = () => [...new Set(state.CATS.flatMap(c => state.EX[c.id] || []))].sort();

export function allMuscles() { return [...(window.__LIFTS_MUSCLES__)]; }

// ── Toast ────────────────────────────────────────────
export function toast(msg) {
  const t = gid('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}

// ── Global error safety net ─────────────────────────
export function installErrorHandler() {
  window.addEventListener('error', function (e) {
    try {
      console.error('Uncaught error:', e.message, 'at', e.filename + ':' + e.lineno);
      let banner = document.getElementById('global-err-banner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'global-err-banner';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#3a0000;color:#ff8080;font-size:.65rem;padding:10px 14px;font-family:monospace;line-height:1.5;max-height:40vh;overflow-y:auto';
        document.body.appendChild(banner);
      }
      const line = document.createElement('div');
      line.style.marginBottom = '4px';
      line.textContent = '⚠ ' + e.message + ' (line ' + e.lineno + ')';
      banner.appendChild(line);
    } catch (err) { /* never let error handler crash */ }
  });
}
