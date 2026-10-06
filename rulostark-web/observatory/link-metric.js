// Métrica de perturbación por enlace teléfono→nodo, compartida por sala3d.html y observatory.html.
// Cada 250 ms y por enlace, con el RSSI de cada trama nueva (sin repetir lecturas viejas):
//  - zVar:  variabilidad del RSSI en 2 s (alguien moviéndose cruza el enlace)
//  - zJump: salto del RSSI medio de los últimos 0.75 s frente a los 2–6 s previos (paso rápido)
//  - zDrop: caída del RSSI medio en 2 s (un cuerpo quieto bloquea el enlace)
//  - zM:    energía de movimiento del firmware (ruidosa: pesa 0.75)
// contra la referencia de "escenario vacío" (tecla C en sala3d) y la línea base móvil de los
// últimos 2 min, que no aprende mientras el enlace está activo. Se usa el mayor z, escalado por
// la sensibilidad (teclas + / -, compartida entre páginas).

export const POS_KEY = 'ruview-sala3d-pos-v3';
export const REF_KEY = 'ruview-sala3d-ref-v1';
export const SENS_KEY = 'ruview-sala3d-sens-v1';
export const SENS_DEFAULT = 1.0, SENS_MIN = 0.5, SENS_MAX = 2;
export const DEFAULT_POS = {
  T: { x: -0.2, y: 0.8, z: -0.6 },
  1: { x: -4.6, y: 0.05, z: -0.4 },
  2: { x: 5.0, y: 0.05, z: -2.8 },
  3: { x: -0.2, y: 0.45, z: -6.6 },
};

// Tarima (recuadro del escenario) en coordenadas de la sala: x izquierda→derecha, z escenario(-)→puerta(+)
export const STAGE = { x0: -4.0, x1: 4.0, z0: -7.5, z1: -3.6 };
const FRESNEL = 0.3;   // margen (m): el enlace es sensible en una franja alrededor de la línea

// Fracción del recorrido teléfono→nodo que cae sobre la tarima y punto medio de ese tramo
export function stageGeometry(pos) {
  const out = {};
  for (const id of [1, 2, 3]) {
    const a = pos.T, b = pos[id]; let n = 0; let mx = 0, mz = 0; const N = 60;
    for (let k = 0; k <= N; k++) {
      const x = a.x + (b.x - a.x) * k / N, z = a.z + (b.z - a.z) * k / N;
      if (x >= STAGE.x0 - FRESNEL && x <= STAGE.x1 + FRESNEL && z >= STAGE.z0 - FRESNEL && z <= STAGE.z1 + FRESNEL) { n++; mx += x; mz += z; }
    }
    out[id] = { w: n / (N + 1), mid: n ? { x: mx / n, z: mz / n } : null };
  }
  return out;
}

const store = globalThis.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} };
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const quantile = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * q)] : 0; };
const mad = (a, m) => median(a.map(x => Math.abs(x - m))) * 1.4826;
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
function std(a) { if (a.length < 3) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }
function zscore(v, hist) { if (hist.length < 20) return 0; const m = median(hist); return (v - m) / Math.max(mad(hist, m), 0.5); }
const clamp01 = v => Math.max(0, Math.min(1, v));

const KEEP_MS = 6000, WIN_MS = 2000, SHORT_MS = 750;
const HIST_LEN = 60;             // 2 min de ventanas de 2 s que no se solapan
const HIST_MIN = 10;             // 20 s de calentamiento antes de usar la línea base móvil
const RELEARN_MS = 20000;        // si un enlace sigue activo 20 s, la línea base vuelve a aprender

export class LinkMetric {
  constructor({ pos } = {}) {
    this.nodes = {};
    for (const id of [1, 2, 3]) this.nodes[id] = { rssi: [], me: [], hist: [], d: 0, on: false, fps: 0, rssiNow: null, stale: true, seq: null };
    this.lastOk = 0;
    this.lastFeatures = null;
    this.lastNodes = [];
    this.sens = +store.getItem(SENS_KEY) || SENS_DEFAULT;
    this.calib = null;          // { until, samples: {1:[[m,sd]],...} }
    this.onCalibrated = null;
    this.setPos(pos || JSON.parse(store.getItem(POS_KEY) || 'null') || structuredClone(DEFAULT_POS));
    this.stage = { available: false, score: 0, on: false, link: null, mid: null };
    this._timer = setInterval(() => this._tick(), 250);
  }
  get ref() { return JSON.parse(store.getItem(REF_KEY) || 'null'); }
  setPos(pos) { this.pos = pos; this.stageGeo = stageGeometry(pos); }

  setSensitivity(v) {
    this.sens = Math.round(Math.max(SENS_MIN, Math.min(SENS_MAX, v)) * 4) / 4;
    store.setItem(SENS_KEY, String(this.sens));
    return this.sens;
  }
  // Teclas + / - (y = sin shift) para ajustar en vivo; devuelve true si consumió la tecla
  handleKey(key) {
    if (key === '+' || key === '=') { this.setSensitivity(this.sens + 0.25); return true; }
    if (key === '-' || key === '_') { this.setSensitivity(this.sens - 0.25); return true; }
    return false;
  }

  onSensing(d, now = performance.now()) {
    for (const n of d.nodes || []) {
      const s = this.nodes[n.node_id]; if (!s || n.rssi_dbm == null) continue;
      s.rssiNow = n.rssi_dbm;
      // cada mensaje repite el último RSSI de todos los nodos: solo cuenta la trama nueva
      const seq = n.sync && n.sync.csi_fps_samples;   // contador de tramas del nodo
      if (seq != null && seq === s.seq) continue;
      s.seq = seq ?? null;
      s.rssi.push([now, n.rssi_dbm]);
      while (s.rssi.length && now - s.rssi[0][0] > KEEP_MS) s.rssi.shift();
    }
    for (const f of d.node_features || []) {
      const s = this.nodes[f.node_id]; if (!s) continue;
      s.fps = f.frame_rate_hz || 0; s.stale = !!f.stale;
    }
    this.lastFeatures = d.features || this.lastFeatures;
    this.lastNodes = d.nodes || this.lastNodes;
    this.lastOk = now;
  }
  onEdgeVitals(v) {
    const s = this.nodes[v.node_id]; if (!s) return;
    s.me.push(v.motion_energy || 0); if (s.me.length > 120) s.me.shift();
  }

  startCalibration(ms = 20000) { this.calib = { until: performance.now() + ms, samples: {} }; }
  clearReference() { store.removeItem(REF_KEY); }
  _finishCalibration() {
    const nodes = {};
    for (const id of [1, 2, 3]) {
      const a = this.calib.samples[id] || []; if (a.length < 20) continue;
      const ms = a.map(x => x[0]), ss = a.map(x => x[1]), mM = median(ms), sM = median(ss);
      nodes[id] = { mean: mM, meanMad: mad(ms, mM), sdMed: sM, sdMad: mad(ss, sM) };
    }
    const ref = { at: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }), nodes };
    store.setItem(REF_KEY, JSON.stringify(ref));
    this.calib = null;
    if (this.onCalibrated) this.onCalibrated(ref);
  }

  _tick(now = performance.now()) {
    const REF = this.ref;
    for (const id of [1, 2, 3]) {
      const s = this.nodes[id];
      const win = s.rssi.filter(x => now - x[0] <= WIN_MS).map(x => x[1]);
      if (win.length < 5) { s.d *= 0.8; if (s.d < 0.15) s.on = false; continue; }
      const m = mean(win), sd = std(win);
      const short = s.rssi.filter(x => now - x[0] <= SHORT_MS).map(x => x[1]);
      const prev = s.rssi.filter(x => now - x[0] > WIN_MS).map(x => x[1]);
      const jump = short.length >= 3 && prev.length >= 10 ? Math.abs(mean(short) - mean(prev)) : 0;
      if (this.calib) (this.calib.samples[id] ||= []).push([m, sd]);

      // línea base móvil: congelada mientras el enlace está activo (salvo que lleve 1 min activo)
      const learning = !s.on || (s.onSince && now - s.onSince > RELEARN_MS);
      s.tickN = (s.tickN || 0) + 1;
      if (learning && s.tickN % 8 === 0) { s.hist.push([m, sd, jump]); if (s.hist.length > HIST_LEN) s.hist.shift(); }
      let base = null;
      if (s.hist.length >= HIST_MIN) {
        const old = s.hist.slice(0, -1), ms = old.map(x => x[0]), ss = old.map(x => x[1]), js = old.map(x => x[2]);
        const mM = median(ms), sQ = quantile(ss, 0.3), jM = median(js);
        base = { mean: mM, meanMad: mad(ms, mM), sdMed: sQ, sdMad: mad(ss, sQ), jMed: jM, jMad: mad(js, jM) };
      }
      const r = REF && REF.nodes && REF.nodes[id];
      // con referencia de escenario vacío: se usa la más sensible de las dos
      const sdMed = r && base ? Math.min(r.sdMed, base.sdMed) : (r || base || {}).sdMed;
      const sdMad = r && base ? Math.min(r.sdMad, base.sdMad) : (r || base || {}).sdMad;
      const ref = r || base;

      let zVar = 0, zDrop = 0, zJump = 0;
      if (ref) {
        zVar = (sd - sdMed) / Math.max(sdMad, 0.25);
        zDrop = (ref.mean - m) / Math.max(ref.meanMad, 0.7);
      }
      if (base) zJump = (jump - base.jMed) / Math.max(base.jMad, 0.5);
      const me = s.me.slice(-2);
      const zM = s.me.length > 20 ? zscore(Math.max(...me), s.me.slice(0, -2)) : 0;
      const z = Math.max(zVar, zDrop, zJump, 0.75 * zM) * this.sens;
      s.dbg = { m: +m.toFixed(1), sd: +sd.toFixed(2), jump: +jump.toFixed(2), zVar: +zVar.toFixed(2), zJump: +zJump.toFixed(2), zDrop: +zDrop.toFixed(2), zM: +zM.toFixed(2), z: +z.toFixed(2), ref: r ? 'vacío' : 'móvil', n: win.length };

      // sube rápido y baja despacio
      const target = clamp01((z - 1.5) / 2);
      s.d += (target - s.d) * (target > s.d ? 0.5 : 0.2);
      // histéresis: encender si d > 0.35 sostenido 250 ms; apagar si d < 0.15 durante 1.5 s
      if (s.d > 0.35) { s.hiSince ??= now; s.loSince = null; if (!s.on && now - s.hiSince >= 250) { s.on = true; s.onSince = now; } }
      else if (s.d < 0.15) { s.loSince ??= now; s.hiSince = null; if (now - s.loSince > 1500) { s.on = false; s.onSince = null; } }
      if (s.stale) { s.on = false; s.onSince = null; }
    }
    this._tickStage(now);
    if (this.calib && now > this.calib.until) this._finishCalibration();
  }

  // Actividad en la tarima = el enlace más perturbado entre los que la cruzan (un enlace corto
  // sobre la tarima pesa menos). Si ningún enlace la cruza, no hay medición de la tarima.
  _tickStage(now) {
    const G = this.stageGeo, st = this.stage;
    let any = false, score = 0, best = null, bestV = -1;
    for (const id of [1, 2, 3]) {
      const w = G[id].w, n = this.nodes[id]; if (w <= 0.02 || n.stale) continue;
      any = true;
      const v = n.d * Math.min(1, 0.5 + w * 2);
      if (v > score) score = v;
      if (w * (0.2 + n.d) > bestV) { bestV = w * (0.2 + n.d); best = id; }
    }
    st.available = any; st.score = any ? score : 0;
    st.link = best; st.mid = best ? G[best].mid : null;
    if (st.score > 0.3) { st.hiSince ??= now; st.loSince = null; if (now - st.hiSince >= 250) st.on = true; }
    else if (st.score < 0.15) { st.loSince ??= now; st.hiSince = null; if (now - st.loSince > 1500) st.on = false; }
    if (!st.available) st.on = false;
  }

  get live() { return performance.now() - this.lastOk < 3000; }
  activeLinks() { return [1, 2, 3].filter(id => this.nodes[id].on); }
}
