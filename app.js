/* Dibujo de Fourier — Alejandro López
   Imagen → bordes (Canny) o contorno → un solo trazo → FFT → epiciclos animados. */
(() => {
"use strict";

const M = 32768;                                  // puntos del trazo (potencia de 2 para la FFT)
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const stageEl = document.getElementById('stage');
const $ = id => document.getElementById(id);
const C = {
  bg: '#080a09', plate: '#121715', ink: '#ece7da', grey: '#8d978f', dim: '#5f6a63',
  accent: '#ff7a4a', border: '#2a322e',
  circle: 'rgba(236,231,218,0.13)', vec: 'rgba(236,231,218,0.55)', guide: 'rgba(236,231,218,0.4)'
};
const FONT_UI = '"Hanken Grotesk", system-ui, sans-serif';
const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';
const FONT_SERIF = '"Fraunces", Georgia, serif';

let W = 1080, H = 1920, u = 1;                    // tamaño del lienzo y unidad de escala (min(W,H)/1080)
let srcImg = null;                                // canvas con la imagen aplanada
let data = null;                                  // resultado del procesado
let ghost = null;                                 // imagen tintada de fondo
let timeline = { t: 0, playing: false, last: 0, total: 1 };
let recorder = null, recorded = null;
const FINAL = 12.5;
const levelDur = () => +$('speed').value;

const setStatus = (m, err) => { const s = $('status'); s.textContent = m; s.classList.toggle('err', !!err); };
const clamp01 = v => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/* =====================================================================
   Imagen de ejemplo
   ===================================================================== */
function makeSample() {
  const c = document.createElement('canvas'); c.width = 900; c.height = 640;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 640);
  g.strokeStyle = '#111'; g.fillStyle = '#111'; g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.arc(640, 330, 105, Math.PI, 0); g.stroke();
  for (let i = 0; i < 9; i++) { const a = Math.PI + (i + 0.5) * Math.PI / 9; g.beginPath(); g.moveTo(640 + Math.cos(a) * 135, 330 + Math.sin(a) * 135); g.lineTo(640 + Math.cos(a) * 175, 330 + Math.sin(a) * 175); g.stroke(); }
  g.beginPath(); g.moveTo(50, 330); g.lineTo(170, 170); g.lineTo(250, 260); g.lineTo(340, 120); g.lineTo(470, 330); g.stroke();
  g.beginPath(); g.moveTo(305, 175); g.lineTo(340, 195); g.lineTo(372, 172); g.stroke();
  g.beginPath(); g.moveTo(40, 330); g.lineTo(860, 330); g.stroke();
  for (let r = 0; r < 3; r++) { g.beginPath(); for (let x = 70 + r * 40; x <= 830 - r * 40; x += 4) { const y = 400 + r * 70 + Math.sin(x / 32 + r) * 10; x === 70 + r * 40 ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke(); }
  g.beginPath(); g.moveTo(180, 470); g.lineTo(400, 470); g.lineTo(360, 520); g.lineTo(220, 520); g.closePath(); g.stroke();
  g.beginPath(); g.moveTo(290, 470); g.lineTo(290, 330); g.stroke();
  g.beginPath(); g.moveTo(290, 345); g.lineTo(380, 455); g.lineTo(290, 455); g.stroke();
  g.beginPath(); g.moveTo(280, 360); g.lineTo(215, 455); g.lineTo(280, 455); g.stroke();
  for (const [bx, by, s] of [[150, 90, 1], [215, 60, .8], [520, 110, .9]]) { g.beginPath(); g.moveTo(bx - 28 * s, by); g.quadraticCurveTo(bx - 12 * s, by - 16 * s, bx, by + 4 * s); g.quadraticCurveTo(bx + 12 * s, by - 16 * s, bx + 28 * s, by); g.stroke(); }
  return c;
}

/* =====================================================================
   Carga de archivos (JPG, PNG, WEBP, GIF, AVIF, BMP y SVG)
   ===================================================================== */
const MAX_SIDE = 1600;

// Un SVG sin width/height reporta tamaño 0 o 300×150: se le fija uno desde el viewBox.
function prepareSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('SVG no válido');
  const num = v => { const n = parseFloat(v); return isFinite(n) && n > 0 && !/%/.test(v || '') ? n : 0; };
  let w = num(svg.getAttribute('width')), h = num(svg.getAttribute('height'));
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if ((!w || !h) && vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = vb[2]; h = vb[3]; }
  if (!w || !h) { w = 1000; h = 1000; }
  if (vb.length !== 4 || vb.some(isNaN)) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const k = MAX_SIDE / Math.max(w, h);
  svg.setAttribute('width', Math.round(w * k)); svg.setAttribute('height', Math.round(h * k));
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(svg);
}

// Dibuja la imagen en un canvas de tamaño razonable y aplana la transparencia
// sobre blanco (o sobre oscuro si el contenido opaco es claro).
function rasterize(img) {
  let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('imagen vacía');
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  w = Math.max(2, Math.round(w * k)); h = Math.max(2, Math.round(h * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  let transparent = 0, lumSum = 0, opaque = 0;
  for (let i = 0; i < d.length; i += 16) {          // muestreo cada 4 píxeles
    if (d[i + 3] < 250) transparent++;
    if (d[i + 3] > 128) { lumSum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; opaque++; }
  }
  const frac = transparent / (d.length / 16);
  const bg = (frac > 0.05 && opaque && lumSum / opaque > 175) ? '#1b1f1d' : '#ffffff';
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const o = out.getContext('2d');
  o.fillStyle = bg; o.fillRect(0, 0, w, h); o.drawImage(c, 0, 0);
  return out;
}

function loadFile(file) {
  if (!file) return;
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  if (!isSvg && !file.type.startsWith('image/')) { setStatus('Ese archivo no es una imagen. Usa JPG, PNG, WEBP o SVG.', true); return; }
  setStatus('Abriendo imagen…');
  const finish = (img, url) => {
    try {
      srcImg = rasterize(img);
    } catch (e) { setStatus('No pude leer esa imagen: ' + e.message, true); return; }
    $('thumb').src = url; $('thumb').classList.add('on');
    $('fname').textContent = file.name;
    $('title').value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 40);
    if (isSvg) $('mode').value = 'contour';
    process();
  };
  const fail = () => setStatus(/heic|heif/i.test(file.type + file.name) ? 'HEIC no se puede abrir en el navegador. Conviértela a JPG primero.' : 'No pude abrir esa imagen.', true);
  if (isSvg) {
    file.text().then(txt => {
      const blob = new Blob([prepareSvg(txt)], { type: 'image/svg+xml' }), url = URL.createObjectURL(blob), img = new Image();
      img.onload = () => finish(img, url); img.onerror = fail; img.src = url;
    }).catch(() => setStatus('Ese SVG no es válido.', true));
  } else {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => finish(img, url); img.onerror = fail; img.src = url;
  }
}

/* =====================================================================
   Procesado: bordes → trazos → un solo camino → FFT
   ===================================================================== */
function toGray(img, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return out;
}
function blur(src, w, h, sigma) {
  const r = Math.ceil(sigma * 2.5), k = [], tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  let sum = 0; for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let i = -r; i <= r; i++) { const xx = Math.min(w - 1, Math.max(0, x + i)); a += src[y * w + xx] * k[i + r]; } tmp[y * w + x] = a; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let i = -r; i <= r; i++) { const yy = Math.min(h - 1, Math.max(0, y + i)); a += tmp[yy * w + x] * k[i + r]; } out[y * w + x] = a; }
  return out;
}
function canny(g, w, h, frac) {
  const n = w * h, mag = new Float32Array(n), dir = new Uint8Array(n), nms = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
    const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
    mag[i] = Math.hypot(gx, gy);
    let a = Math.atan2(gy, gx) * 180 / Math.PI; if (a < 0) a += 180;
    dir[i] = (a < 22.5 || a >= 157.5) ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : 3;
  }
  const vals = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, m = mag[i]; if (m < 1) continue;
    let a, b; switch (dir[i]) { case 0: a = mag[i - 1]; b = mag[i + 1]; break; case 1: a = mag[i - w - 1]; b = mag[i + w + 1]; break; case 2: a = mag[i - w]; b = mag[i + w]; break; default: a = mag[i - w + 1]; b = mag[i + w - 1]; }
    if (m >= a && m >= b) { nms[i] = m; vals.push(m); }
  }
  if (!vals.length) return new Uint8Array(n);
  const sorted = Float32Array.from(vals).sort();
  let high = sorted[Math.max(0, Math.floor(sorted.length * (1 - frac)))];
  high = Math.max(high, 30); const low = high * 0.45;
  const E = new Uint8Array(n), stack = [];
  for (let i = 0; i < n; i++) if (nms[i] >= high) { E[i] = 1; stack.push(i); }
  const off = [1, -1, w, -w, w + 1, w - 1, -w + 1, -w - 1];
  while (stack.length) { const i = stack.pop(); for (const o of off) { const j = i + o; if (j > 0 && j < n && !E[j] && nms[j] >= low) { E[j] = 1; stack.push(j); } } }
  return E;
}
function contour(g, w, h) {
  const n = w * h, hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, Math.max(0, g[i] | 0))]++;
  let sumAll = 0; for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break; sumB += t * hist[t]; const mB = sumB / wB, mF = (sumAll - sumB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; thr = t; } }
  const fg = new Uint8Array(n); let cnt = 0;
  for (let i = 0; i < n; i++) if (g[i] < thr) { fg[i] = 1; cnt++; }
  if (cnt > n * 0.6) for (let i = 0; i < n; i++) fg[i] ^= 1;
  const E = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!fg[i]) continue;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !fg[i - 1] || !fg[i + 1] || !fg[i - w] || !fg[i + w]) E[i] = 1;
  }
  return E;
}
function trace(E0, w, h, minLen) {
  const W2 = w + 2, H2 = h + 2, E = new Uint8Array(W2 * H2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) E[(y + 1) * W2 + x + 1] = E0[y * w + x];
  const vis = new Uint8Array(W2 * H2), off = [1, W2, -1, -W2, W2 + 1, W2 - 1, -W2 - 1, -W2 + 1];
  const deg = i => { let c = 0; for (const o of off) if (E[i + o]) c++; return c; };
  const walk = cur => { const pts = []; for (;;) { let nx = -1; for (const o of off) { const j = cur + o; if (E[j] && !vis[j]) { nx = j; break; } } if (nx < 0) break; vis[nx] = 1; pts.push(nx); cur = nx; } return pts; };
  const chains = [];
  const push = arr => { if (arr.length >= minLen) { const f = new Float32Array(arr.length * 2); arr.forEach((p, k) => { f[k * 2] = (p % W2) - 1; f[k * 2 + 1] = ((p / W2) | 0) - 1; }); chains.push(f); } };
  for (let i = 0; i < E.length; i++) if (E[i] && !vis[i] && deg(i) === 1) { vis[i] = 1; push([i, ...walk(i)]); }
  for (let i = 0; i < E.length; i++) if (E[i] && !vis[i]) { vis[i] = 1; const a = walk(i), b = walk(i); push(b.reverse().concat([i], a)); }
  chains.sort((a, b) => b.length - a.length);
  return chains.slice(0, 5000);
}
function orderChains(chains) {
  const n = chains.length, used = new Uint8Array(n), out = [];
  used[0] = 1; out.push(chains[0]);
  let px = chains[0][chains[0].length - 2], py = chains[0][chains[0].length - 1];
  const sx = new Float32Array(n), sy = new Float32Array(n), ex = new Float32Array(n), ey = new Float32Array(n);
  chains.forEach((c, i) => { sx[i] = c[0]; sy[i] = c[1]; ex[i] = c[c.length - 2]; ey[i] = c[c.length - 1]; });
  for (let step = 1; step < n; step++) {
    let best = -1, bd = Infinity, rev = false;
    for (let i = 0; i < n; i++) { if (used[i]) continue;
      const d1 = (sx[i] - px) ** 2 + (sy[i] - py) ** 2; if (d1 < bd) { bd = d1; best = i; rev = false; }
      const d2 = (ex[i] - px) ** 2 + (ey[i] - py) ** 2; if (d2 < bd) { bd = d2; best = i; rev = true; } }
    used[best] = 1; let c = chains[best];
    if (rev) { const r = new Float32Array(c.length); for (let k = 0; k < c.length / 2; k++) { r[k * 2] = c[c.length - 2 - k * 2]; r[k * 2 + 1] = c[c.length - 1 - k * 2]; } c = r; }
    out.push(c); px = c[c.length - 2]; py = c[c.length - 1];
  }
  return out;
}
function resample(chains) {
  const X = [], Y = [];
  chains.forEach(c => { for (let k = 0; k < c.length; k += 2) { X.push(c[k]); Y.push(c[k + 1]); } });
  const P = X.length, seg = new Float64Array(P), jump = new Uint8Array(P);
  let L = 0;
  for (let i = 0; i < P; i++) { const j = (i + 1) % P, d = Math.hypot(X[j] - X[i], Y[j] - Y[i]); const isJ = d > 2.6; jump[i] = isJ ? 1 : 0; seg[i] = isJ ? Math.max(1, d * 0.1) : d; L += seg[i]; }
  const xs = new Float64Array(M), ys = new Float64Array(M), js = new Uint8Array(M);
  let si = 0, acc = 0;
  for (let m = 0; m < M; m++) {
    const s = m * L / M;
    while (si < P - 1 && acc + seg[si] < s) { acc += seg[si]; si++; }
    const f = seg[si] > 0 ? Math.min(1, (s - acc) / seg[si]) : 0, j = (si + 1) % P;
    xs[m] = X[si] + (X[j] - X[si]) * f; ys[m] = Y[si] + (Y[j] - Y[si]) * f; js[m] = jump[si];
  }
  return { xs, ys, js, points: P };
}

/* ---------- FFT ---------- */
const TW = (() => { const c = new Float64Array(M / 2), s = new Float64Array(M / 2); for (let i = 0; i < M / 2; i++) { c[i] = Math.cos(2 * Math.PI * i / M); s[i] = Math.sin(2 * Math.PI * i / M); } return { c, s }; })();
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < half; k++) {
      const wr = TW.c[k * step], wi = inv ? TW.s[k * step] : -TW.s[k * step];
      const a = i + k, b = a + half, vr = re[b] * wr - im[b] * wi, vi = re[b] * wi + im[b] * wr;
      re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function fourier(xs, ys, maxN) {
  const re = Float64Array.from(xs), im = Float64Array.from(ys);
  fft(re, im, false);
  const K = M / 2 - 1, Ek = new Float64Array(K + 1);
  const Rx = new Float64Array(maxN + 1), Px = new Float64Array(maxN + 1), Ry = new Float64Array(maxN + 1), Py = new Float64Array(maxN + 1);
  let total = 0;
  for (let k = 1; k <= K; k++) {
    const q = M - k;
    Ek[k] = (re[k] ** 2 + im[k] ** 2 + re[q] ** 2 + im[q] ** 2) / 2; total += Ek[k];
    if (k <= maxN) {
      const xr = (re[k] + re[q]) / 2, xi = (im[k] - im[q]) / 2, yr = (im[k] + im[q]) / 2, yi = -(re[k] - re[q]) / 2;
      Rx[k] = 2 * Math.hypot(xr, xi) / M; Px[k] = Math.atan2(xi, xr);
      Ry[k] = 2 * Math.hypot(yr, yi) / M; Py[k] = Math.atan2(yi, yr);
    }
  }
  const levels = [];
  for (let N = 2; N <= maxN; N *= 2) {
    const r = Float64Array.from(re), i = Float64Array.from(im);
    for (let k = N + 1; k < M - N; k++) { r[k] = 0; i[k] = 0; }
    fft(r, i, true);
    let tail = 0; for (let k = N + 1; k <= K; k++) tail += Ek[k];
    levels.push({ N, x: Float32Array.from(r), y: Float32Array.from(i), err: 100 * Math.sqrt(tail / total) });
  }
  const idx = arr => { const a = []; for (let k = 1; k <= maxN; k++) a.push(k); return Int32Array.from(a.sort((p, q) => arr[q] - arr[p])); };
  return { levels, Rx, Px, Ry, Py, ix: idx(Rx), iy: idx(Ry), dcx: re[0] / M, dcy: im[0] / M };
}

// Imagen tintada que queda como "fantasma" bajo el trazo.
function makeGhost(img) {
  const s = Math.min(1, 1100 / Math.max(img.width, img.height));
  const w = Math.max(2, Math.round(img.width * s)), h = Math.max(2, Math.round(img.height * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
  const id = g.getImageData(0, 0, w, h), d = id.data;
  const lo = [0x12, 0x17, 0x15], hi = [0x4c, 0x5a, 0x52];
  for (let i = 0; i < d.length; i += 4) {
    const L = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255, k = Math.pow(1 - L, 0.9) * 0.9;
    d[i] = lo[0] + (hi[0] - lo[0]) * k; d[i + 1] = lo[1] + (hi[1] - lo[1]) * k; d[i + 2] = lo[2] + (hi[2] - lo[2]) * k; d[i + 3] = 255;
  }
  g.putImageData(id, 0, 0); return c;
}

let processToken = 0;
function process() {
  if (!srcImg) return;
  const token = ++processToken;
  setStatus('Procesando imagen…');
  timeline.playing = false;
  setTimeout(() => {
    if (token !== processToken) return;
    try {
      const detail = +$('detail').value, mode = $('mode').value, maxN = +$('maxN').value;
      const side = 320 + detail * 40, sc = side / Math.max(srcImg.width, srcImg.height);
      const w = Math.max(16, Math.round(srcImg.width * sc)), h = Math.max(16, Math.round(srcImg.height * sc));
      let g = toGray(srcImg, w, h);
      g = blur(g, w, h, mode === 'edges' ? 1.4 : 0.8);
      const E = mode === 'edges' ? canny(g, w, h, 0.08 + detail * 0.022) : contour(g, w, h);
      const chains = trace(E, w, h, mode === 'edges' ? Math.max(4, 12 - detail) : 6);
      if (!chains.length) { setStatus('No encontré bordes en esta imagen. Prueba el otro modo o sube el detalle.', true); return; }
      const ordered = orderChains(chains);
      const rs = resample(ordered);
      const fr = fourier(rs.xs, rs.ys, maxN);
      // zona más densa, para el zoom final
      const G = 6, cnt = new Float32Array(G * G);
      for (let m = 0; m < M; m += 4) if (!rs.js[m]) { const cx = Math.min(G - 1, (rs.xs[m] / w * G) | 0), cy = Math.min(G - 1, (rs.ys[m] / h * G) | 0); cnt[cy * G + cx]++; }
      let bi = 0; for (let i = 1; i < cnt.length; i++) if (cnt[i] > cnt[bi]) bi = i;
      const focus = { x: ((bi % G) + 0.5) / G * w, y: (((bi / G) | 0) + 0.5) / G * h };
      const last = fr.levels[fr.levels.length - 1], full = new Path2D();
      let pen = false;
      for (let m = 0; m <= M; m++) { const k = m % M; if (rs.js[(m - 1 + M) % M] && m > 0) pen = false; if (!pen) { full.moveTo(last.x[k], last.y[k]); pen = true; } else full.lineTo(last.x[k], last.y[k]); }
      data = { w, h, js: rs.js, xs: rs.xs, ys: rs.ys, ...fr, focus, full, chains: chains.length, points: rs.points };
      ghost = makeGhost(srcImg);
      timeline.total = levelDur() * data.levels.length + FINAL;
      layoutCache.key = ''; trail.level = -1;
      setStatus(`${chains.length} trazos · ${rs.points.toLocaleString('es')} puntos · ${fr.levels.length} niveles`);
      timeline.t = 0; play();
    } catch (e) { console.error(e); setStatus('Error al procesar: ' + e.message, true); }
  }, 30);
}

/* =====================================================================
   Tamaño del lienzo (se adapta a la pantalla o a un formato fijo)
   ===================================================================== */
const FORMATS = { '916': [1080, 1920], '169': [1920, 1080], '11': [1440, 1440] };
function applySize() {
  let w, h;
  const f = $('format').value;
  if (FORMATS[f]) [w, h] = FORMATS[f];
  else {
    const r = stageEl.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.round(r.width * dpr); h = Math.round(r.height * dpr);
    const cap = 3840 / Math.max(w, h, 3840) ; w = Math.round(w * cap); h = Math.round(h * cap);
  }
  w = Math.max(240, w & ~1); h = Math.max(240, h & ~1);        // dimensiones pares para H.264
  if (w === cv.width && h === cv.height && trailCv.width === w) return;
  cv.width = w; cv.height = h; trailCv.width = w; trailCv.height = h;
  W = w; H = h; u = Math.min(W, H) / 1080;
  layoutCache.key = ''; trail.level = -1;
}
new ResizeObserver(() => { if (!recorder) applySize(); }).observe(stageEl);

/* =====================================================================
   Composición adaptable: los rieles de círculos crecen con la pantalla
   ===================================================================== */
const layoutCache = { key: '' };
function getLayout() {
  const key = `${W}x${H}x${data.w}x${data.h}`;
  if (layoutCache.key === key) return layoutCache;
  const pad = 32 * u, gap = 22 * u, land = W / H > 1.15, wide = W / u >= 1700;
  const tb = (wide ? 120 : 215) * u, lb = (land ? 140 : 250) * u;
  const Ax = pad, Ay = tb, Aw = W - 2 * pad, Ah = H - tb - lb;
  const iw = data.w, ih = data.h;
  const s = Math.max(.01, Math.min((Aw - 2 * gap) / (iw * 1.4), (Ah - 2 * gap) / (ih * 1.5)));
  const pw = iw * s, ph = ih * s;
  const railL = Math.max(0.4 * pw, Math.min((Aw - pw - 2 * gap) * 0.5, 1.2 * pw)), railT = 0.5 * ph;
  const gw = railL + gap + pw, gh = railT + gap + ph;
  const gx = Ax + (Aw - gw) / 2, gy = Ay + (Ah - gh) / 2;
  const A = { x: gx + railL + gap, y: gy + railT + gap, w: pw, h: ph, s };
  const s2 = Math.min(Aw / iw, Ah / ih) * 0.98;
  const B = { x: W / 2 - iw * s2 / 2, y: Ay + Ah / 2 - ih * s2 / 2, w: iw * s2, h: ih * s2, s: s2 };
  Object.assign(layoutCache, { key, pad, gap, land, wide, tb, lb, Ax, Ay, Aw, Ah, A, B, gx, gy, gw, railL, railT });
  return layoutCache;
}

/* =====================================================================
   Dibujo
   ===================================================================== */
const font = (size, weight, fam) => `${weight} ${Math.max(9, size * u)}px ${fam}`;

function drawFormula(x, y, v, c1, c2, col, alpha) {
  ctx.save(); ctx.translate(x, y); ctx.scale(u, u); ctx.globalAlpha = alpha; ctx.fillStyle = col; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const big = `400 30px ${FONT_MONO}`, sm = `400 19px ${FONT_MONO}`, sig = `300 54px ${FONT_UI}`;
  let cx = 0; const t = (s, f, dy = 0) => { ctx.font = f; ctx.fillText(s, cx, dy); cx += ctx.measureText(s).width; };
  t(v, big); t('N', sm, 8); t('(t) = ', big);
  ctx.font = sig; const sw = ctx.measureText('Σ').width; ctx.fillText('Σ', cx, 12);
  ctx.font = sm; ctx.textAlign = 'center'; ctx.fillText('N', cx + sw / 2, -34); ctx.fillText('k=1', cx + sw / 2, 36); ctx.textAlign = 'left';
  cx += sw + 8; t('(' + c1, big); t('k', sm, 8); t(' cos kt + ' + c2, big); t('k', sm, 8); t(' sin kt)', big);
  ctx.restore();
}
function drawFormulas(alpha) {
  const L = getLayout();
  if (L.wide) { drawFormula(L.pad, 74 * u, 'x', 'a', 'b', C.grey, alpha); drawFormula(L.pad + 720 * u, 74 * u, 'y', 'c', 'd', C.ink, alpha); }
  else { drawFormula(L.pad, 92 * u, 'x', 'a', 'b', C.grey, alpha); drawFormula(L.pad, 176 * u, 'y', 'c', 'd', C.ink, alpha); }
}
function drawBrand(alpha) {
  const L = getLayout();
  ctx.save(); ctx.globalAlpha = alpha; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  const brand = $('brand').value.trim(), handle = $('handle').value.trim(), x = W - L.pad, y = (L.wide ? 64 : 82) * u;
  if (brand) {
    ctx.font = font(40, 600, FONT_SERIF); ctx.fillStyle = C.ink; ctx.fillText(brand, x, y);
    const bw = ctx.measureText(brand).width;
    ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(x - bw - 18 * u, y - 13 * u, 7 * u, 0, Math.PI * 2); ctx.fill();
  }
  if (handle) { ctx.font = font(21, 400, FONT_MONO); ctx.fillStyle = C.grey; ctx.fillText(handle, x, y + 38 * u); }
  ctx.restore();
}
function drawSignature(alpha) {
  const sign = $('sign').value.trim(); if (!sign) return;
  const L = getLayout();
  ctx.save(); ctx.globalAlpha = alpha * 0.9; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = `italic 400 ${Math.max(11, 26 * u)}px ${FONT_SERIF}`; ctx.fillStyle = C.ink;
  const y = H - (L.land ? 20 : 36) * u;
  ctx.fillText(sign, W / 2, y);
  const tw = ctx.measureText(sign).width; ctx.strokeStyle = C.accent; ctx.lineWidth = Math.max(1, 1.5 * u);
  ctx.beginPath(); ctx.moveTo(W / 2 - tw / 2, y + 8 * u); ctx.lineTo(W / 2 - tw / 2 + 36 * u, y + 8 * u); ctx.stroke();
  ctx.restore();
}
function drawBg() { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H); }
function drawPlate(b, ghostA) {
  ctx.fillStyle = C.plate; ctx.fillRect(b.x, b.y, b.w, b.h);
  if (ghostA > 0) { ctx.save(); ctx.globalAlpha = ghostA; ctx.drawImage(ghost, b.x, b.y, b.w, b.h); ctx.restore(); }
  ctx.strokeStyle = C.border; ctx.lineWidth = Math.max(1, 2 * u); ctx.strokeRect(b.x, b.y, b.w, b.h);
}
function sampleAt(arr, f) { const i = Math.floor(f) % M, j = (i + 1) % M, uu = f - Math.floor(f); return arr[i] + (arr[j] - arr[i]) * uu; }

/* Estela incremental del nivel actual */
const trailCv = document.createElement('canvas'); trailCv.width = W; trailCv.height = H;
const tctx = trailCv.getContext('2d');
const trail = { level: -1, idx: 0 };
function updateTrail(li, f, b) {
  const L = data.levels[li];
  if (trail.level !== li || f < trail.idx) { tctx.clearRect(0, 0, trailCv.width, trailCv.height); trail.level = li; trail.idx = 0; }
  const end = Math.floor(f); if (end <= trail.idx) return;
  const jA = clamp01((Math.log2(L.N) - 7) / 2);       // los saltos de lápiz se desvanecen desde N=128
  const pn = new Path2D(), pj = new Path2D();
  for (let m = trail.idx; m < end && m < M; m++) {
    const n = m + 1 < M ? m + 1 : 0;
    const x0 = b.x + L.x[m] * b.s, y0 = b.y + L.y[m] * b.s, x1 = b.x + L.x[n] * b.s, y1 = b.y + L.y[n] * b.s;
    const p = data.js[m] ? pj : pn; p.moveTo(x0, y0); p.lineTo(x1, y1);
  }
  tctx.lineCap = 'round'; tctx.lineJoin = 'round'; tctx.strokeStyle = C.ink; tctx.lineWidth = Math.max(1.4, 2.4 * u);
  tctx.globalAlpha = 1; tctx.stroke(pn);
  if (jA < 1) { tctx.globalAlpha = (1 - jA) * 0.8; tctx.stroke(pj); }
  tctx.globalAlpha = 1; trail.idx = end;
}

function drawChain(axis, N, t, b, exact) {
  const L = getLayout();
  const R = axis === 'x' ? data.Rx : data.Ry, P = axis === 'x' ? data.Px : data.Py, ord = axis === 'x' ? data.ix : data.iy;
  let ox, oy, clip;
  if (axis === 'x') {
    const top = L.gy, bot = b.y - L.gap;
    ox = b.x + data.dcx * b.s; oy = (top + bot) / 2; clip = [0, top, W, bot - top];
  } else {
    const left = L.gx, right = b.x - L.gap;
    ox = (left + right) / 2; oy = b.y + data.dcy * b.s; clip = [left, b.y - L.gap / 2, right - left, L.Ay + L.Ah - (b.y - L.gap / 2)];
  }
  const scale = Math.max(1, b.w / (700 * u)), maxVec = Math.min(900, Math.round(420 * scale)), maxCirc = Math.min(420, Math.round(90 * scale));
  ctx.save();
  ctx.beginPath(); ctx.rect(clip[0], clip[1], clip[2], clip[3]); ctx.clip();
  let x = ox, y = oy, drawn = 0; const lines = new Path2D(), circ = new Path2D();
  for (let q = 0; q < ord.length && drawn < maxVec; q++) {
    const k = ord[q]; if (k > N) continue;
    const r = R[k] * b.s, th = k * t + P[k];
    const dx = axis === 'x' ? r * Math.cos(th) : r * Math.sin(th), dy = axis === 'x' ? r * Math.sin(th) : r * Math.cos(th);
    if (drawn < maxCirc && r > 0.8 * u) { circ.moveTo(x + r, y); circ.arc(x, y, r, 0, Math.PI * 2); }
    lines.moveTo(x, y); x += dx; y += dy; lines.lineTo(x, y); drawn++;
  }
  lines.moveTo(x, y); if (axis === 'x') x = exact; else y = exact; lines.lineTo(x, y);
  ctx.lineWidth = Math.max(1, 1.3 * u); ctx.strokeStyle = C.circle; ctx.stroke(circ);
  ctx.lineWidth = Math.max(1, 1.4 * u); ctx.strokeStyle = C.vec; ctx.stroke(lines);
  ctx.restore();
  return { x, y };
}

function drawLabels(N, err, alpha) {
  const L = getLayout();
  ctx.save(); ctx.globalAlpha = alpha; ctx.textBaseline = 'alphabetic';
  const nSize = L.land ? 84 : 104, base = H - (L.land ? 62 : 150) * u;
  ctx.font = font(nSize, 400, FONT_SERIF);
  const a = 'N = ', nb = String(N), wa = ctx.measureText(a).width, wn = ctx.measureText(nb).width, x0 = W / 2 - (wa + wn) / 2;
  ctx.textAlign = 'left'; ctx.fillStyle = C.ink; ctx.fillText(a, x0, base); ctx.fillStyle = C.accent; ctx.fillText(nb, x0 + wa, base);
  ctx.font = font(L.land ? 20 : 25, 400, FONT_MONO); ctx.fillStyle = C.grey;
  const e = `error de aproximación = ${err.toFixed(2)}%`;
  if (L.land) { ctx.textAlign = 'right'; ctx.fillText(e, W - L.pad, base); } else { ctx.textAlign = 'center'; ctx.fillText(e, W / 2, base + 52 * u); }
  ctx.textAlign = 'left'; ctx.font = font(L.land ? 34 : 38, 500, FONT_UI); ctx.fillStyle = C.ink; ctx.fillText($('title').value, L.pad, base);
  ctx.restore();
}

/* =====================================================================
   Fotograma
   ===================================================================== */
function render(t) {
  drawBg();
  if (!data) {
    ctx.fillStyle = C.grey; ctx.font = font(34, 500, FONT_UI); ctx.textAlign = 'center'; ctx.fillText('Cargando…', W / 2, H / 2); ctx.textAlign = 'left'; return;
  }
  const L = getLayout(), per = levelDur(), drawT = per * data.levels.length;
  if ($('showEdges').checked && !timeline.playing && t === 0) { renderEdges(); return; }
  if (t < drawT) {
    const li = Math.max(0, Math.min(data.levels.length - 1, Math.floor(t / per))), Lv = data.levels[li];
    const p = clamp01((t - li * per) / (per * 0.86)), f = p * M, th = 2 * Math.PI * p, b = L.A;
    drawFormulas(1); drawBrand(1);
    drawPlate(b, 1);
    updateTrail(li, f, b);
    ctx.drawImage(trailCv, 0, 0);
    const px = b.x + sampleAt(Lv.x, f % M) * b.s, py = b.y + sampleAt(Lv.y, f % M) * b.s;
    const tx = drawChain('x', Lv.N, th, b, px), ty = drawChain('y', Lv.N, th, b, py);
    ctx.save(); ctx.setLineDash([7 * u, 7 * u]); ctx.lineWidth = Math.max(1, 1.5 * u); ctx.strokeStyle = C.guide;
    ctx.beginPath(); ctx.moveTo(tx.x, tx.y); ctx.lineTo(px, py); ctx.moveTo(ty.x, ty.y); ctx.lineTo(px, py); ctx.stroke(); ctx.restore();
    ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(px, py, Math.max(3, 5.5 * u), 0, Math.PI * 2); ctx.fill();
    drawLabels(Lv.N, Lv.err, 1);
  } else renderFinal(t - drawT);
  drawSignature(1);
}

function renderFinal(ft) {
  const L = getLayout(), last = data.levels[data.levels.length - 1];
  const a = ease(clamp01(ft / 1.1)), A = L.A, B = L.B;
  const b = { x: lerp(A.x, B.x, a), y: lerp(A.y, B.y, a), w: lerp(A.w, B.w, a), h: lerp(A.h, B.h, a) }; b.s = b.w / data.w;
  const Z = 2.6;
  let z = 1;
  if (ft > 1.6 && ft < 3.2) z = lerp(1, Z, ease((ft - 1.6) / 1.6)); else if (ft >= 3.2 && ft < 4.8) z = Z + (ft - 3.2) * 0.08; else if (ft >= 4.8 && ft < 6.3) z = lerp(Z + 0.128, 1, ease((ft - 4.8) / 1.5));
  const colA = ft < 6.4 ? 0 : ft < 7.5 ? ease((ft - 6.4) / 1.1) : ft < 9.6 ? 1 : ft < 10.6 ? 1 - ease((ft - 9.6) / 1.0) : 0;
  const ui = 1 - a;
  if (ui > 0) drawFormulas(ui);
  drawBrand(1);
  // cámara
  const fx = b.x + data.focus.x * b.s, fy = b.y + data.focus.y * b.s, ccx = b.x + b.w / 2, ccy = b.y + b.h / 2;
  const zt = clamp01((z - 1) / (Z - 1 || 1)), camX = lerp(ccx, fx, zt), camY = lerp(ccy, fy, zt);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, L.Ay, W, L.Ah); ctx.clip();
  ctx.translate(ccx, ccy); ctx.scale(z, z); ctx.translate(-camX, -camY);
  drawPlate(b, lerp(1, 0.45, a));
  if (colA > 0) { ctx.save(); ctx.globalAlpha = colA; ctx.drawImage(srcImg, b.x, b.y, b.w, b.h); ctx.restore(); }
  ctx.save(); ctx.translate(b.x, b.y); ctx.scale(b.s, b.s);
  ctx.lineWidth = 2.4 * Math.max(u, .7) / (b.s * Math.sqrt(z)); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = C.ink; ctx.globalAlpha = 1 - colA * 0.6; ctx.stroke(data.full); ctx.restore();
  ctx.restore();
  // etiquetas
  if (ui > 0) drawLabels(last.N, last.err, ui);
  ctx.save(); ctx.globalAlpha = a; ctx.textBaseline = 'alphabetic';
  const base = H - (L.land ? 62 : 150) * u;
  ctx.textAlign = 'center'; ctx.font = font(L.land ? 52 : 62, 400, FONT_SERIF); ctx.fillStyle = C.ink; ctx.fillText($('title').value, W / 2, base);
  ctx.font = font(L.land ? 20 : 23, 400, FONT_MONO); ctx.fillStyle = C.grey;
  const e = `N = ${last.N}  ·  error de aproximación = ${last.err.toFixed(2)}%`;
  if (L.land) { ctx.textAlign = 'right'; ctx.fillText(e, W - L.pad, base); } else ctx.fillText(e, W / 2, base + 52 * u);
  const endA = clamp01((ft - 10.2) / 0.8), end = $('endText').value;
  if (endA > 0 && end) { ctx.globalAlpha = endA; ctx.textAlign = 'center'; ctx.font = font(L.wide ? 54 : 62, 400, FONT_SERIF); ctx.fillStyle = C.accent; ctx.fillText(end, W / 2, L.tb * (L.wide ? .62 : .5)); }
  ctx.restore();
}

function renderEdges() {
  const L = getLayout(), b = L.A;
  drawBrand(1); drawPlate(b, 1);
  ctx.save(); ctx.translate(b.x, b.y); ctx.scale(b.s, b.s); ctx.lineWidth = 1.6 / b.s * Math.max(u, .8); ctx.strokeStyle = C.ink;
  const p = new Path2D(); let pen = false;
  for (let m = 0; m < M; m += 2) { if (data.js[m]) { pen = false; continue; } if (!pen) { p.moveTo(data.xs[m], data.ys[m]); pen = true; } else p.lineTo(data.xs[m], data.ys[m]); }
  ctx.stroke(p); ctx.restore();
  ctx.font = font(30, 500, FONT_UI); ctx.fillStyle = C.grey; ctx.textAlign = 'center';
  ctx.fillText(`Trazo extraído · ${data.chains} trazos`, W / 2, b.y + b.h + 64 * u); ctx.textAlign = 'left';
  drawSignature(1);
}

/* =====================================================================
   Reproducción
   ===================================================================== */
function updateTransport() {
  $('scrub').value = Math.round(timeline.t / timeline.total * 1000);
  $('time').textContent = `${timeline.t.toFixed(1)} / ${timeline.total.toFixed(1)} s`;
  $('pauseUse').setAttribute('href', timeline.playing ? '#i-pause' : '#i-play');
  $('pause').setAttribute('aria-label', timeline.playing ? 'Pausa' : 'Reproducir');
}
function loop(now) {
  if (timeline.playing) {
    const dt = Math.max(0, Math.min(0.1, (now - timeline.last) / 1000)); timeline.last = now;
    timeline.t += dt;
    if (timeline.t >= timeline.total) { timeline.t = timeline.total; timeline.playing = false; if (recorder) recorder.stop(); }
  }
  render(timeline.t); updateTransport();
  requestAnimationFrame(loop);
}
function play(from) { if (!data) return; if (from !== undefined) timeline.t = from; if (timeline.t >= timeline.total) timeline.t = 0; timeline.playing = true; timeline.last = performance.now(); }

$('play').onclick = () => { trail.level = -1; play(0); };
$('pause').onclick = () => { if (recorder) return; if (timeline.playing) timeline.playing = false; else play(); };
$('scrub').oninput = e => { if (recorder || !data) return; timeline.playing = false; timeline.t = e.target.value / 1000 * timeline.total; };

/* =====================================================================
   Exportar: video y PNG
   ===================================================================== */
function pickMime() {
  const opts = [['video/mp4;codecs=avc1.640028', 'mp4'], ['video/mp4;codecs=avc1', 'mp4'], ['video/mp4', 'mp4'], ['video/webm;codecs=vp9', 'webm'], ['video/webm;codecs=vp8', 'webm'], ['video/webm', 'webm']];
  for (const [m, e] of opts) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return { m, e };
  return null;
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const slug = () => ($('title').value || 'fourier').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'fourier';

$('record').onclick = () => {
  if (!data || recorder) return;
  const mt = pickMime(); if (!mt || !cv.captureStream) { setStatus('Este navegador no permite grabar el lienzo. Prueba con Chrome o Edge.', true); return; }
  const stream = cv.captureStream(30), chunks = [];
  try { recorder = new MediaRecorder(stream, { mimeType: mt.m, videoBitsPerSecond: 14e6 }); } catch (e) { setStatus('No se pudo iniciar la grabación: ' + e.message, true); return; }
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    recorded = { blob: new Blob(chunks, { type: mt.m.split(';')[0] }), ext: mt.e };
    recorder = null; $('record').disabled = false; $('record').querySelector('span').textContent = 'Grabar video'; $('record').classList.remove('recording');
    $('save').hidden = false; applySize();
    setStatus(`Video listo · ${(recorded.blob.size / 1e6).toFixed(1)} MB · ${mt.e.toUpperCase()} ${cv.width}×${cv.height}`);
  };
  recorded = null; $('save').hidden = true;
  $('record').disabled = true; $('record').querySelector('span').textContent = 'Grabando…'; $('record').classList.add('recording');
  setStatus('Grabando en tiempo real. Deja esta pestaña visible hasta que termine.');
  trail.level = -1; play(0); recorder.start(250);
};
$('save').onclick = () => { if (recorded) { download(recorded.blob, `fourier-${slug()}.${recorded.ext}`); setStatus('Video descargado.'); } };
$('snap').onclick = () => { if (!data) return; cv.toBlob(b => { if (b) { download(b, `fourier-${slug()}.png`); setStatus('PNG guardado.'); } }, 'image/png'); };

/* =====================================================================
   Entradas
   ===================================================================== */
$('file').onchange = e => { loadFile(e.target.files[0]); e.target.value = ''; };
const drop = $('drop');
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
const isOverImage = e => [...(e.dataTransfer?.types || [])].includes('Files');
['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { if (isOverImage(e)) { e.preventDefault(); drop.classList.add('over'); } }));
['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { if (ev === 'drop' || e.relatedTarget === null) drop.classList.remove('over'); }));
document.addEventListener('drop', e => { if (isOverImage(e)) { e.preventDefault(); loadFile(e.dataTransfer.files[0]); } });
document.addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/')); if (f) loadFile(f); });

let reT; const reprocess = () => { clearTimeout(reT); reT = setTimeout(process, 250); };
$('detail').oninput = e => { $('detailLbl').textContent = `${e.target.value} / 10`; reprocess(); };
$('mode').onchange = reprocess; $('maxN').onchange = reprocess;
$('format').onchange = () => { if (!recorder) applySize(); };
$('speed').oninput = e => {
  $('speedLbl').textContent = `${(+e.target.value).toFixed(1)} s`;
  if (data) { const frac = timeline.t / timeline.total; timeline.total = levelDur() * data.levels.length + FINAL; timeline.t = frac * timeline.total; trail.level = -1; }
};
$('showEdges').onchange = e => { if (e.target.checked) { timeline.playing = false; timeline.t = 0; } else if (data) play(0); };
['title', 'brand', 'handle', 'sign', 'endText'].forEach(id => $(id).addEventListener('input', () => { /* se redibuja en el siguiente fotograma */ }));

/* =====================================================================
   Arranque
   ===================================================================== */
applySize();
srcImg = makeSample();
$('thumb').src = srcImg.toDataURL('image/png'); $('thumb').classList.add('on');
$('fname').textContent = 'Imagen de ejemplo';
requestAnimationFrame(loop);
const fontsReady = document.fonts ? Promise.all([
  document.fonts.load(`400 40px "Fraunces"`), document.fonts.load(`italic 400 26px "Fraunces"`),
  document.fonts.load(`500 30px "Hanken Grotesk"`), document.fonts.load(`400 30px "JetBrains Mono"`)
]).catch(() => {}) : Promise.resolve();
Promise.race([fontsReady, new Promise(r => setTimeout(r, 1500))]).then(() => { applySize(); process(); });
})();
