'use strict';
/* =====================================================================
   Studio Dialogues — briques communes à toutes les pages
   (index.html : dialogues et « Tu sais lire ça ? » ; archives.html : mode Archives)
   Store · Stress · AudioCache · AzureTTS · Usage · AudioEngine · Timeline ·
   charte (couleurs, polices, marges) · VideoRenderer · VideoExporter · Exports
   ===================================================================== */

/* ---------- Store : localStorage protégé (mode privé, etc.) ---------- */
const Store = {
  get(k, d = null) { try { const v = localStorage.getItem('sd.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sd.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('sd.' + k); } catch {} },
};


/* ---------- Accent tonique ---------- */
// « Ко́фе » = « Ко » + « о » + U+0301 (accent aigu combinant). On retire le signe et on garde
// la position de la voyelle accentuée, pour la colorer à l'affichage.
const Stress = {
  ACUTE: '́',
  LAT: { 'á': 'а', 'é': 'е', 'ó': 'о', 'ý': 'у', 'Á': 'А', 'É': 'Е', 'Ó': 'О', 'Ý': 'У' },
  CYR: /[Ѐ-ӿ]/,
  parse(src) {
    let s = (src || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    // voyelle latine accentuée tapée par erreur au milieu d'un mot cyrillique → voyelle cyrillique + accent
    s = s.replace(/[áéóýÁÉÓÝ]/g, (c, i) => this.CYR.test((s[i - 1] || '') + (s[i + 1] || '')) ? this.LAT[c] + this.ACUTE : c);
    // [В] = lettre muette : on retire les crochets et on garde la position.
    let text = '', inBr = false; const marks = new Set(), silent = new Set();
    for (const ch of s) {
      if (ch === '[') { inBr = true; continue; }
      if (ch === ']') { inBr = false; continue; }
      if (ch === this.ACUTE || ch === '´') { if (text) marks.add(text.length - 1); continue; }
      if (inBr) silent.add(text.length);
      text += ch;
    }
    return { text, marks, silent };
  },
  strip(s) { return this.parse(s).text; },
  VOWELS: /[аеёиоуыэюя]/gi,
  // Mot de plusieurs syllabes sans accent marqué (ё est toujours accentué) ?
  missingStress(rich) { return rich.marks.size === 0 && !/[ёЁ]/.test(rich.text) && (rich.text.match(this.VOWELS) || []).length >= 2; },
};


/* ---------- Erreurs en français ---------- */
class UserError extends Error { constructor(msg, opts = {}) { super(msg); this.retryable = !!opts.retryable; this.code = opts.code; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const brandName = s => (s || '').replace(/\bL['’]est\b/g, "L'Est");

/* ---------- Cache audio (IndexedDB) : évite de repayer le quota ---------- */
const AudioCache = {
  mem: new Map(), dbp: null,
  db() {
    if (this.dbp) return this.dbp;
    this.dbp = new Promise(res => {
      try {
        const r = indexedDB.open('studio-dialogues', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('tts');
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch { res(null); }
    });
    return this.dbp;
  },
  async get(k) {
    if (this.mem.has(k)) return this.mem.get(k);
    const db = await this.db(); if (!db) return null;
    return new Promise(res => {
      try {
        const q = db.transaction('tts').objectStore('tts').get(k);
        q.onsuccess = () => { if (q.result) this.mem.set(k, q.result); res(q.result || null); };
        q.onerror = () => res(null);
      } catch { res(null); }
    });
  },
  async put(k, buf) {
    this.mem.set(k, buf);
    const db = await this.db(); if (!db) return;
    try { db.transaction('tts', 'readwrite').objectStore('tts').put(buf, k); } catch {}
  },
  async clear() {
    this.mem.clear();
    const db = await this.db(); if (!db) return;
    try { db.transaction('tts', 'readwrite').objectStore('tts').clear(); } catch {}
  },
};

/* ---------- Synthèse vocale Azure ---------- */
const AzureTTS = {
  FORMAT: 'riff-24khz-16bit-mono-pcm',      // WAV : décodage exact, durées précises
  SDK_URL: 'https://cdn.jsdelivr.net/npm/microsoft-cognitiveservices-speech-sdk@1.40.0/distrib/browser/microsoft.cognitiveservices.speech.sdk.bundle-min.js',
  recent: [],                                 // horodatages pour respecter 20 requêtes / 60 s (F0)
  restBlocked: false,

  checkCreds({ key, region }) {
    if (!key) throw new UserError('Ajoute ta clé Azure (étape 1).');
    if (!/^[a-z0-9]+$/.test(region || '')) throw new UserError('Région invalide. Exemple : westeurope (en minuscules, sans espace). Tu la trouves dans Azure, rubrique « Clés et point de terminaison » → « Emplacement/Région ».');
  },
  host(region) { return `https://${region}.tts.speech.microsoft.com`; },
  xml(s) { return s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])); },
  // Le texte envoyé est TOUJOURS sans accent tonique (Stress.strip).
  ssml({ text, voice, lang, rate }) {
    const r = `${rate >= 0 ? '+' : ''}${rate}%`;
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${voice}"><prosody rate="${r}">${this.xml(Stress.strip(text))}</prosody></voice></speak>`;
  },
  cacheKey(p) { return [this.FORMAT, p.voice, p.rate, Stress.strip(p.text)].join('|'); },

  async throttle(onWait) {
    const now = Date.now();
    this.recent = this.recent.filter(t => now - t < 60000);
    if (this.recent.length >= 18) {
      const wait = 60000 - (now - this.recent[0]) + 300;
      onWait && onWait(Math.ceil(wait / 1000));
      await sleep(wait);
    }
    this.recent.push(Date.now());
  },

  httpError(status, body) {
    const b = (body || '').slice(0, 200);
    switch (status) {
      case 400: return new UserError(`Azure a refusé la requête (400) : texte ou nom de voix invalide.${b ? '\n' + b : ''}`);
      case 401: return new UserError('Clé refusée (401). Vérifie la clé et que la région correspond bien à TA ressource Speech.', { code: 401 });
      case 403: return new UserError('Accès refusé (403) : quota gratuit du mois probablement épuisé, ou ressource désactivée. Vérifie dans le portail Azure.', { code: 403 });
      case 404: return new UserError('Adresse introuvable (404) : la région saisie est sans doute incorrecte.');
      case 415: return new UserError('Format de requête refusé (415).');
      case 429: return new UserError('Trop de requêtes (429) : limite du niveau gratuit atteinte.', { retryable: true, code: 429 });
      default:
        if (status >= 500) return new UserError(`Azure est momentanément indisponible (${status}).`, { retryable: true });
        return new UserError(`Erreur Azure inattendue (${status}).`);
    }
  },
  networkError() {
    return new UserError(navigator.onLine === false
      ? 'Pas de connexion Internet.'
      : 'Impossible de joindre Azure. Vérifie la région (ex. westeurope) et ta connexion.', { code: 'network' });
  },

  async viaRest(creds, p) {
    let res;
    try {
      res = await fetch(`${this.host(creds.region)}/cognitiveservices/v1`, {
        method: 'POST', mode: 'cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { 'Ocp-Apim-Subscription-Key': creds.key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': this.FORMAT },
        body: this.ssml(p),
      });
    } catch { throw this.networkError(); }
    if (!res.ok) { let t = ''; try { t = await res.text(); } catch {} const e = this.httpError(res.status, t); e.retryAfter = +res.headers.get('Retry-After') || 0; throw e; }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 100) throw new UserError('Azure a renvoyé un audio vide.');
    return buf;
  },

  sdkPromise: null,
  loadSdk() {
    if (window.SpeechSDK) return Promise.resolve(window.SpeechSDK);
    if (!this.sdkPromise) this.sdkPromise = loadScript(this.SDK_URL).then(() => {
      if (!window.SpeechSDK) throw new Error(); return window.SpeechSDK;
    }).catch(() => { this.sdkPromise = null; throw new UserError('Impossible de charger le SDK Speech (connexion ?).'); });
    return this.sdkPromise;
  },
  async viaSdk(creds, p) {
    const sdk = await this.loadSdk();
    return new Promise((resolve, reject) => {
      const cfg = sdk.SpeechConfig.fromSubscription(creds.key, creds.region);
      cfg.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;
      const synth = new sdk.SpeechSynthesizer(cfg, null);
      synth.speakSsmlAsync(this.ssml(p), r => {
        synth.close();
        if (r.reason === sdk.ResultReason.SynthesizingAudioCompleted && r.audioData && r.audioData.byteLength > 100) return resolve(r.audioData);
        const d = (r.errorDetails || '');
        if (/401|auth|unauthori/i.test(d)) return reject(this.httpError(401));
        if (/403|quota/i.test(d)) return reject(this.httpError(403));
        if (/429|throttl|too many/i.test(d)) return reject(this.httpError(429));
        reject(new UserError('La synthèse a échoué : ' + (d || 'raison inconnue')));
      }, err => { synth.close(); reject(new UserError('La synthèse a échoué : ' + err)); });
    });
  },

  // Renvoie { buf: ArrayBuffer(WAV), cached: bool }
  async synthesize(creds, p, { engine = 'auto', onWait } = {}) {
    const k = this.cacheKey(p);
    const hit = await AudioCache.get(k);
    if (hit) return { buf: hit, cached: true };
    for (let attempt = 0; ; attempt++) {
      await this.throttle(onWait);
      try {
        let buf;
        const useSdk = engine === 'sdk' || (engine === 'auto' && this.restBlocked);
        if (useSdk) buf = await this.viaSdk(creds, p);
        else {
          try { buf = await this.viaRest(creds, p); }
          catch (e) {
            // Un « TypeError » réseau peut venir d'un blocage CORS : on tente le SDK (WebSocket).
            if (engine === 'auto' && e.code === 'network' && navigator.onLine !== false) {
              buf = await this.viaSdk(creds, p); this.restBlocked = true;
            } else throw e;
          }
        }
        await AudioCache.put(k, buf);
        Usage.add(Stress.strip(p.text).length);
        return { buf, cached: false };
      } catch (e) {
        if (e.retryable && attempt < 4) {
          const wait = e.retryAfter ? e.retryAfter * 1000 : 5000 * (attempt + 1);
          onWait && onWait(Math.ceil(wait / 1000));
          await sleep(wait); continue;
        }
        throw e;
      }
    }
  },

  async listVoices(creds) {
    let res;
    try {
      res = await fetch(`${this.host(creds.region)}/cognitiveservices/voices/list`, {
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { 'Ocp-Apim-Subscription-Key': creds.key },
      });
    } catch { throw this.networkError(); }
    if (!res.ok) throw this.httpError(res.status);
    return res.json();
  },
};

/* ---------- Compteur de caractères (estimation locale) ---------- */
const Usage = {
  key() { const d = new Date(); return `usage-${d.getFullYear()}-${d.getMonth() + 1}`; },
  get() { return Store.get(this.key(), 0); },
  add(n) { Store.set(this.key(), this.get() + n); if (typeof UI !== 'undefined' && UI.showUsage) UI.showUsage(); },
};

/* ---------- Chargement de scripts externes ---------- */
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = res; s.onerror = () => rej(new Error('load ' + src));
    document.head.appendChild(s);
  });
}

/* ---------- Audio : contexte, décodage, nettoyage ---------- */
const AudioEngine = {
  ctx: null,
  get() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new UserError('Ce navigateur ne gère pas l\'audio Web.');
      this.ctx = new AC();
    }
    return this.ctx;
  },
  unlock() { try { const c = this.get(); if (c.state !== 'running') c.resume(); } catch {} },
  decode(buf) {
    const c = this.get();
    return new Promise((res, rej) => {
      const p = c.decodeAudioData(buf.slice(0), res, () => rej(new UserError('Audio reçu illisible.')));
      if (p && p.catch) p.catch(() => {});
    });
  },
  // Retire les silences de début/fin (en gardant une marge) → pauses régulières.
  trim(ab) {
    const d = ab.getChannelData(0), sr = ab.sampleRate, th = 0.006, margin = Math.round(0.04 * sr);
    let s = 0, e = d.length - 1;
    while (s < d.length && Math.abs(d[s]) < th) s++;
    while (e > s && Math.abs(d[e]) < th) e--;
    s = Math.max(0, s - margin); e = Math.min(d.length, e + margin);
    return d.slice(s, e);
  },
};

/* ---------- Timeline : place l'audio et le texte dans le temps ---------- */
const FPS = 30;
const Timeline = {
  INTRO: 2.8, LEAD: 0.5, TAIL: 0.8, OUTRO: 3.4, ENTER: 0.3, PRE: 0.35,
  // segs : [{ line, samples:Float32Array|null, dur }]
  build(segs, { pause, sampleRate }) {
    let t = this.INTRO + this.LEAD;
    const items = segs.map((s, i) => {
      const it = { ...s.line, index: i, start: t, dur: s.dur, end: t + s.dur, samples: s.samples };
      t = it.end + (i < segs.length - 1 ? pause : 0);
      return it;
    });
    // Une réplique apparaît juste avant sa voix (animation finie au début de la voix)
    // et reste affichée au moins jusqu'à la fin de sa voix.
    items.forEach((it, i) => {
      const prevEnd = i ? items[i - 1].end : this.INTRO;
      it.dispStart = Math.max(prevEnd, this.INTRO, it.start - this.PRE);
    });
    items.forEach((it, i) => { it.dispEnd = i < items.length - 1 ? items[i + 1].dispStart : it.end + this.TAIL; });
    const dialogueEnd = (items.length ? items[items.length - 1].end : this.INTRO) + this.TAIL;
    // Durée totale arrondie à une image près : audio et vidéo auront exactement la même durée.
    const total = Math.round((dialogueEnd + this.OUTRO) * FPS) / FPS;
    return { items, introEnd: this.INTRO, dialogueEnd, outroStart: dialogueEnd, total, frames: Math.round(total * FPS), sampleRate };
  },
  mix(tl, { from = 0, to = tl.total } = {}) {
    const sr = tl.sampleRate, out = new Float32Array(Math.round((to - from) * sr));
    for (const it of tl.items) {
      if (!it.samples) continue;
      const off = Math.round((it.start - from) * sr);
      if (off >= out.length) continue;
      out.set(it.samples.subarray(0, Math.max(0, out.length - off)), off);
    }
    if (tl.ticks && tl.ticks.length) {
      const tk = this.tickSound(sr);
      for (const tt of tl.ticks) {
        const off = Math.round((tt - from) * sr);
        for (let j = 0; j < tk.length; j++) { const q = off + j; if (q >= 0 && q < out.length) out[q] += tk[j]; }
      }
    }
    return out;
  },
  // « Tic » discret de 35 ms (deux sinusoïdes amorties), généré sans fichier.
  tickSound(sr) {
    const n = Math.round(0.035 * sr), a = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / sr; a[i] = 0.16 * Math.sin(2 * Math.PI * 2000 * t) * Math.exp(-t * 130) + 0.07 * Math.sin(2 * Math.PI * 1000 * t) * Math.exp(-t * 90); }
    return a;
  },
  // Réplique attendue à l'instant t (pour le contrôle qualité)
  lineAt(tl, t) {
    if (t < tl.introEnd) return { label: 'Écran titre' };
    if (t >= tl.outroStart) return { label: 'Écran de fin' };
    let idx = -1; tl.items.forEach((it, i) => { if (t >= it.dispStart) idx = i; });
    return idx < 0 ? { label: 'Écran titre' } : { label: `Réplique ${idx + 1}/${tl.items.length}`, text: tl.items[idx].text };
  },
};

/* ---------- Rendu vidéo (canvas 1080×1920) — charte « L'Est en 60 secondes » ---------- */
const W = 1080, H = 1920;
const SAFE = { top: 200, side: 90, bottom: 300 };
const C = { bg: '#F3ECE1', text: '#1C1A18', accent: '#A01D22', muted: '#5F5A52', rule: 'rgba(28,26,24,0.25)' /* #1C1A1840 */ };
const F_DISPLAY = '"Playfair Display", Georgia, "Times New Roman", serif';
const F_SERIF = '"Source Serif 4", Georgia, "Times New Roman", serif';
const F_MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
const ease = x => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3));
const clamp01 = x => Math.max(0, Math.min(1, x));

class VideoRenderer {
  constructor(canvas) { this.c = canvas; this.g = canvas.getContext('2d', { alpha: false, willReadFrequently: true }); }

  setScene(scene) { this.s = scene; this.layoutAll(); }

  /* --- texte --- */
  wrap(text, font, maxW) {
    const g = this.g; g.font = font;
    const words = text.split(' ').filter(Boolean), lines = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (g.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  }
  // Comme wrap, mais garde la position de chaque ligne dans le texte (pour les accents).
  wrapRich(rich, font, maxW) {
    const g = this.g; g.font = font;
    const lines = []; let start = 0, cur = '', curStart = 0;
    for (const w of rich.text.split(' ')) {
      const t = cur ? cur + ' ' + w : w;
      if (g.measureText(t).width <= maxW || !cur) { if (!cur) curStart = start; cur = t; }
      else { lines.push({ s: cur, start: curStart }); cur = w; curStart = start; }
      start += w.length + 1;
    }
    if (cur) lines.push({ s: cur, start: curStart });
    return lines;
  }
  // Dessine une ligne avec les voyelles accentuées en rouge.
  drawRich(line, marks, x, y, color, align = 'left') {
    return this.drawColored(line.s, x, y, i => marks.has(line.start + i) ? C.accent : color, align);
  }
  // Dessine un texte dont chaque lettre peut avoir sa couleur (colorAt(i) → couleur).
  drawColored(s, x, y, colorAt, align = 'left') {
    const g = this.g;
    g.textAlign = 'left';
    const total = g.measureText(s).width;
    const x0 = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    let a = 0;
    while (a < s.length) {
      const c = colorAt(a); let b = a + 1;
      while (b < s.length && colorAt(b) === c) b++;
      g.fillStyle = c;
      g.fillText(s.slice(a, b), x0 + (a ? g.measureText(s.slice(0, a)).width : 0), y);
      a = b;
    }
    return total;
  }
  // IBM Plex Mono 500, majuscules, espacement 3 px. segs : [{t, color}] ou une chaîne.
  mono(segs, x, y, { size = 26, color = C.muted, align = 'left', spacing = 3, maxW = W - 2 * SAFE.side, upper = true } = {}) {
    const g = this.g;
    if (typeof segs === 'string') segs = [{ t: segs, color }];
    const chars = []; segs.forEach(sg => [...(upper ? sg.t.replace(/[\u0301\u00B4\[\]]/g, '').toUpperCase() : sg.t)].forEach(ch => chars.push({ ch, color: sg.color || color })));
    let ws, total;
    for (; size >= 16; size--) {
      g.font = `500 ${size}px ${F_MONO}`;
      ws = chars.map(c => g.measureText(c.ch).width);
      total = ws.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1);
      if (total <= maxW) break;
    }
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    g.textAlign = 'left';
    chars.forEach((c, i) => { g.fillStyle = c.color; g.fillText(c.ch, cx, y); cx += ws[i] + spacing; });
    return total;
  }
  rule(x1, x2, y, color = C.rule, h = 2) { this.g.fillStyle = color; this.g.fillRect(x1, y - h / 2, x2 - x1, h); }

  layoutAll() {
    const maxW = W - 2 * SAFE.side, m = this.s.meta;
    this.layouts = this.s.timeline.items.map(it => {
      let ru, size = 88;
      for (; size >= 56; size -= 4) { ru = this.wrapRich(it.rich, `800 ${size}px ${F_DISPLAY}`, maxW); if (ru.length <= 4) break; }
      const frSize = Math.max(38, Math.round(size * 0.52));
      const fr = it.translation ? this.wrap(it.translation, `500 ${frSize}px ${F_SERIF}`, maxW) : [];
      const ruLH = Math.round(size * 1.16), frLH = Math.round(frSize * 1.32), NAME = 34, GAP1 = 40, GAP2 = 26;
      const h = NAME + GAP1 + ru.length * ruLH + (fr.length ? GAP2 + fr.length * frLH : 0);
      return { it, ru, fr, size, frSize, ruLH, frLH, NAME, GAP1, GAP2, h };
    });
    // titre d'ouverture
    this.titleSize = 150;
    for (; this.titleSize >= 90; this.titleSize -= 10) {
      this.titleLines = this.wrapRich(m.titleRich, `800 ${this.titleSize}px ${F_DISPLAY}`, maxW);
      if (this.titleLines.length <= 2) break;
    }
    // titre d'en-tête : réduit si trop long
    this.headSize = 64;
    for (; this.headSize > 36; this.headSize -= 4) { this.g.font = `800 ${this.headSize}px ${F_DISPLAY}`; if (this.g.measureText(m.titleRich.text).width <= maxW) break; }
  }

  draw(t) {
    const g = this.g, tl = this.s.timeline;
    g.globalAlpha = 1; g.fillStyle = C.bg; g.fillRect(0, 0, W, H);   // fond uni, sans flou ni photo
    g.textBaseline = 'alphabetic';
    const introA = 1 - clamp01((t - (tl.introEnd - 0.4)) / 0.4);
    const outroA = clamp01((t - tl.outroStart) / 0.5);
    const dlgA = (1 - introA) * (1 - outroA);
    if (introA > 0.001) this.drawIntro(t, introA);
    if (dlgA > 0.001) this.drawDialogue(t, dlgA);
    if (outroA > 0.001) this.drawOutro(t - tl.outroStart, outroA);
    g.globalAlpha = 1;
  }

  stagger(t, d, A) { const k = ease((t - d) / 0.6); return { a: k * A, dy: (1 - k) * 30 }; }

  drawIntro(t, A) {
    const g = this.g, m = this.s.meta, L = SAFE.side, R = W - SAFE.side;
    let k = this.stagger(t, 0, A); g.globalAlpha = k.a;
    if (m.handle) this.mono(m.handle, W / 2, SAFE.top + 40, { align: 'center', color: C.muted });
    this.rule(L, R, SAFE.top + 72);
    k = this.stagger(t, 0.1, A); g.globalAlpha = k.a;
    this.mono(`${m.langLabel} ${m.level}`, W / 2, 760 + k.dy, { size: 30, align: 'center', color: C.accent });
    k = this.stagger(t, 0.25, A); g.globalAlpha = k.a;
    let y = 790 + k.dy;
    g.font = `800 ${this.titleSize}px ${F_DISPLAY}`;
    this.titleLines.forEach(l => { y += this.titleSize * 1.02; this.drawRich(l, m.titleRich.marks, W / 2, y, C.text, 'center'); });
    k = this.stagger(t, 0.45, A); g.globalAlpha = k.a;
    y += 56; this.rule(W / 2 - 40, W / 2 + 40, y, C.accent, 4);
    y += 84;
    if (m.titleFr) { g.font = `500 60px ${F_SERIF}`; g.fillStyle = C.muted; g.textAlign = 'center'; g.fillText(m.titleFr, W / 2, y + k.dy); }
    k = this.stagger(t, 0.6, A); g.globalAlpha = k.a;
    if (m.place) this.mono(m.place, W / 2, y + 74 + k.dy, { align: 'center', color: C.muted });
    this.rule(L, R, H - SAFE.bottom - 60);
    this.mono(`Dialogue · ${this.s.timeline.items.length} répliques`, W / 2, H - SAFE.bottom - 4, { align: 'center', color: C.muted });
    g.globalAlpha = 1;
  }

  drawHeader(A) {
    const g = this.g, m = this.s.meta, L = SAFE.side, R = W - SAFE.side;
    g.globalAlpha = A;
    this.mono(`${m.langLabel} ${m.level}`, L, SAFE.top + 26, { color: C.accent });
    if (m.place) this.mono(m.place, R, SAFE.top + 26, { align: 'right', color: C.muted });
    g.font = `800 ${this.headSize}px ${F_DISPLAY}`;
    const tw = this.drawRich({ s: m.titleRich.text, start: 0 }, m.titleRich.marks, L, SAFE.top + 112, C.text);
    if (m.titleFr) {
      g.font = `500 36px ${F_SERIF}`;
      if (tw + 40 + g.measureText(m.titleFr).width <= R - L) { g.fillStyle = C.muted; g.textAlign = 'right'; g.fillText(m.titleFr, R, SAFE.top + 112); }
    }
    this.rule(L, R, SAFE.top + 150);
  }

  drawFooter(t, A, idx) {
    const g = this.g, m = this.s.meta, tl = this.s.timeline, L = SAFE.side, R = W - SAFE.side, n = tl.items.length;
    g.globalAlpha = A;
    const y = H - SAFE.bottom - 60;
    const prog = clamp01((t - tl.introEnd) / (tl.dialogueEnd - tl.introEnd));
    this.rule(L, R, y);
    this.rule(L, L + (R - L) * prog, y, C.accent, 4);
    const segs = [];
    if (m.handle) segs.push({ t: m.handle + ' · ', color: C.muted });
    segs.push({ t: m.titleRich.text + ' · ', color: C.muted }, { t: `${Math.max(1, idx + 1)}/${n}`, color: C.accent });
    this.mono(segs, L, H - SAFE.bottom - 4, { color: C.muted });
  }

  // Bloc d'une réplique, ancré à gauche (x = marge), centré verticalement sur cy.
  drawBlock(Lb, cy, alpha, scale, active, t) {
    if (alpha <= 0.003) return;
    const g = this.g, it = Lb.it, maxW = W - 2 * SAFE.side;
    const name = (it.speaker === 'M' ? this.s.meta.nameM : this.s.meta.nameF) || (it.speaker === 'M' ? 'Homme' : 'Femme');
    g.save(); g.globalAlpha = alpha; g.translate(SAFE.side, cy - (Lb.h * scale) / 2); g.scale(scale, scale);
    // locuteur + filet qui se remplit en rouge pendant la voix
    const nw = this.mono(name, 0, 26, { color: C.accent, maxW: maxW * 0.7 });
    const x1 = nw + 24, ry = 17;
    this.rule(x1, maxW, ry);
    if (active) {
      const p = clamp01((t - it.start) / Math.max(0.01, it.dur));
      if (p > 0) this.rule(x1, x1 + (maxW - x1) * p, ry, C.accent, 3);
    }
    // texte russe (Playfair Display 800) avec accents toniques en rouge
    let y = Lb.NAME + Lb.GAP1;
    g.font = `800 ${Lb.size}px ${F_DISPLAY}`;
    Lb.ru.forEach(l => { y += Lb.ruLH; this.drawRich(l, it.rich.marks, 0, y - Lb.ruLH * 0.2, C.text); });
    // traduction (Source Serif 4, 500)
    if (Lb.fr.length) {
      y += Lb.GAP2; g.font = `500 ${Lb.frSize}px ${F_SERIF}`; g.fillStyle = C.muted; g.textAlign = 'left';
      Lb.fr.forEach(l => { y += Lb.frLH; g.fillText(l, 0, y - Lb.frLH * 0.24); });
    }
    g.restore();
  }

  drawDialogue(t, A) {
    const g = this.g, items = this.s.timeline.items;
    this.drawHeader(A);
    let idx = -1;
    for (let i = 0; i < items.length; i++) if (t >= items[i].dispStart) idx = i;
    this.drawFooter(t, A, idx);
    if (idx < 0) return;
    const TOP = SAFE.top + 170, BOTTOM = H - SAFE.bottom - 90, MAIN = 1000, GAP = 56, GS = 0.72, GA = 0.32;
    const k = ease((t - items[idx].dispStart) / Timeline.ENTER);
    const Lc = this.layouts[idx];
    // le bloc courant ne doit jamais toucher le pied de page
    const main = Math.min(MAIN, BOTTOM - Lc.h / 2);
    g.save(); g.beginPath(); g.rect(0, TOP, W, BOTTOM - TOP); g.clip();
    const fadeTop = (cy, h, a) => { const top = cy - h / 2; return top < TOP + 40 ? a * clamp01(1 - (TOP + 40 - top) / 160) : a; };
    const Lp = this.layouts[idx - 1], Lpp = this.layouts[idx - 2];
    if (Lp && this.s.showPrev) {
      const ghostCy = main - Lc.h / 2 - GAP - (Lp.h * GS) / 2;
      const cy = main + (ghostCy - main) * k, sc = 1 + (GS - 1) * k, a = 1 + (GA - 1) * k;
      this.drawBlock(Lp, cy, fadeTop(cy, Lp.h * sc, a * A), sc, false, t);
      if (Lpp) {
        const from = main - Lp.h / 2 - GAP - (Lpp.h * GS) / 2, to = ghostCy - (Lp.h * GS) / 2 - GAP - (Lpp.h * GS) / 2;
        const cy2 = from + (to - from) * k;
        this.drawBlock(Lpp, cy2, fadeTop(cy2, Lpp.h * GS, GA * (1 - k) * A), GS, false, t);
      }
    } else if (Lp) {
      this.drawBlock(Lp, main - 50 * k, (1 - k) * A, 1, false, t);
    }
    this.drawBlock(Lc, main + (1 - k) * 60, k * A, 1, true, t);
    g.restore();
  }

  drawOutro(t, A) {
    const g = this.g, m = this.s.meta, L = SAFE.side, R = W - SAFE.side;
    let k = this.stagger(t, 0.05, A); g.globalAlpha = k.a;
    g.font = `800 150px ${F_DISPLAY}`;
    this.drawRich({ s: m.thanks.text, start: 0 }, m.thanks.marks, W / 2, 860 + k.dy, C.text, 'center');
    k = this.stagger(t, 0.25, A); g.globalAlpha = k.a;
    g.font = `500 54px ${F_SERIF}`; g.fillStyle = C.muted; g.textAlign = 'center';
    g.fillText('Merci d\'avoir regardé !', W / 2, 960 + k.dy);
    k = this.stagger(t, 0.45, A); g.globalAlpha = k.a;
    if (m.endText) {
      const lines = this.wrap(m.endText, `500 44px ${F_SERIF}`, R - L);
      g.fillStyle = C.text; g.textAlign = 'center';
      lines.forEach((l, i) => g.fillText(l, W / 2, 1080 + i * 58 + k.dy));
    }
    k = this.stagger(t, 0.65, A); g.globalAlpha = k.a;
    if (m.handle) {
      this.rule(W / 2 - 40, W / 2 + 40, 1240, C.accent, 4);
      this.mono(m.handle, W / 2, 1310 + k.dy, { size: 32, align: 'center', color: C.accent });
    }
    g.globalAlpha = 1;
  }
}


const mixHex = (a, b, k) => {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)), A = p(a), B = p(b);
  return k <= 0 ? a : k >= 1 ? b : `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(',')})`;
};

/* ---------- Export vidéo : image par image, 30 i/s constants ---------- */
// Chaque image n°i est dessinée à l'instant exact i/30 s puis encodée avec ce timestamp.
// H.264 (encodeur matériel via WebCodecs) + AAC, conteneur MP4 avec l'index (moov) au début.
const VideoExporter = {
  AAC_URL: 'https://cdn.jsdelivr.net/npm/@mediabunny/aac-encoder@1.65.2/dist/bundles/mediabunny-aac-encoder.min.mjs',
  libP: null,
  lib() {
    if (!this.libP) this.libP = import('mediabunny').catch(e => { this.libP = null; console.error(e); throw new UserError('Impossible de charger l\'encodeur vidéo (connexion Internet ?).'); });
    return this.libP;
  },
  async support() {
    if (!window.VideoEncoder) return { ok: false, why: 'WebCodecs absent : mets à jour iPadOS (16.4 ou plus) et utilise Safari.' };
    const MB = await this.lib();
    const v = await MB.canEncodeVideo('avc', { width: W, height: H, bitrate: 6e6 });
    if (!v) return { ok: false, why: 'Encodage H.264 indisponible dans ce navigateur.' };
    const a = await MB.canEncodeAudio('aac', { numberOfChannels: 1, sampleRate: 48000, bitrate: 128000 });
    return { ok: true, nativeAac: a };
  },
  async ensureAac(MB, sampleRate) {
    if (await MB.canEncodeAudio('aac', { numberOfChannels: 1, sampleRate, bitrate: 128000 })) return 'natif';
    const ext = await import(this.AAC_URL);
    ext.registerAacEncoder();
    return 'WebAssembly';
  },

  async export({ canvas, renderer, timeline, mix, sampleRate, onProgress, signal }) {
    const MB = await this.lib();
    const sup = await this.support();
    if (!sup.ok) throw new UserError(sup.why);
    const aacMode = await this.ensureAac(MB, sampleRate);
    const N = timeline.frames, total = N / FPS;
    const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
    const video = new MB.VideoSampleSource({ codec: 'avc', bitrate: 6_000_000, keyFrameInterval: 2, latencyMode: 'quality' });
    const g = canvas.getContext('2d'), yuv = new Uint8Array(W * H * 3 / 2);
    const BT709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
    const audio = new MB.AudioBufferSource({ codec: 'aac', bitrate: 128_000 });
    output.addVideoTrack(video, { frameRate: FPS });
    output.addAudioTrack(audio);
    await output.start();
    // Audio : exactement N/30 s (complété par du silence si besoin), envoyé par tranches d'une seconde
    const samplesTotal = Math.round(total * sampleRate);
    const pcm = new Float32Array(samplesTotal); pcm.set(mix.subarray(0, samplesTotal));
    const chunk = sampleRate; let aPos = 0;
    const pushAudioUntil = async (sec) => {
      const until = Math.min(samplesTotal, Math.round(sec * sampleRate));
      while (aPos < until) {
        const len = Math.min(chunk, until - aPos);
        const ab = new AudioBuffer({ length: len, numberOfChannels: 1, sampleRate });
        ab.getChannelData(0).set(pcm.subarray(aPos, aPos + len));
        await audio.add(ab); aPos += len;
      }
    };
    let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch {}
    try {
      for (let i = 0; i < N; i++) {
        if (signal.aborted) { await output.cancel(); throw new UserError('Export annulé.'); }
        if (i % FPS === 0) await pushAudioUntil((i + FPS) / FPS + 0.5);
        if (renderer.prepareFrame) await renderer.prepareFrame(i / FPS);   // source asynchrone (mode Archives)
        renderer.draw(i / FPS);
        const sample = new MB.VideoSample(this.toI420(g, yuv), { format: 'I420', codedWidth: W, codedHeight: H, timestamp: i / FPS, duration: 1 / FPS, colorSpace: BT709 });
        await video.add(sample); sample.close();
        if (i % 10 === 0) { onProgress && onProgress(i / N, i, N); await new Promise(r => setTimeout(r, 0)); }
      }
      await pushAudioUntil(total);
      video.close(); audio.close();
      await output.finalize();
    } finally { try { wake && wake.release(); } catch {} }
    onProgress && onProgress(1, N, N);
    const buf = new Uint8Array(output.target.buffer);
    return { blob: new Blob([buf], { type: 'video/mp4' }), ext: 'mp4', aacMode, colr: this.readColr(buf) };
  },

  // Convertit l'image du canvas en YUV 4:2:0 « plage vidéo » BT.709 (= yuv420p), en entiers.
  toI420(g, out) {
    const d = g.getImageData(0, 0, W, H).data, uOff = W * H, vOff = uOff + (W * H >> 2), hw = W >> 1;
    for (let j = 0, o = 0, yo = 0; j < H; j++) {
      for (let i = 0; i < W; i++, o += 4, yo++) out[yo] = (47 * d[o] + 157 * d[o + 1] + 16 * d[o + 2] + 4224) >> 8;
    }
    for (let j = 0; j < H; j += 2) {
      for (let i = 0; i < W; i += 2) {
        const o = (j * W + i) * 4, o2 = o + W * 4, k = (j >> 1) * hw + (i >> 1);
        const r = d[o] + d[o + 4] + d[o2] + d[o2 + 4], gg = d[o + 1] + d[o + 5] + d[o2 + 1] + d[o2 + 5], b = d[o + 2] + d[o + 6] + d[o2 + 2] + d[o2 + 6];
        out[uOff + k] = (((-26 * r - 86 * gg + 112 * b) >> 2) + 32896) >> 8;
        out[vOff + k] = (((112 * r - 102 * gg - 10 * b) >> 2) + 32896) >> 8;
      }
    }
    return out;
  },
  // Lit l'étiquette couleur (boîte colr/nclx) du MP4 produit.
  readColr(buf) {
    for (let i = 0; i + 19 <= Math.min(buf.length, 8 << 20); i++) {
      if (buf[i] === 0x63 && buf[i + 1] === 0x6f && buf[i + 2] === 0x6c && buf[i + 3] === 0x72 && buf[i + 4] === 0x6e && buf[i + 5] === 0x63) {
        const u16 = k => (buf[k] << 8) | buf[k + 1];
        return { primaries: u16(i + 8), transfer: u16(i + 10), matrix: u16(i + 12), full: !!(buf[i + 14] & 0x80) };
      }
    }
    return null;
  },

  // Vérification automatique du fichier produit (équivalent de ffprobe, dans le navigateur).
  async verify(blob, timeline, info = {}) {
    const MB = await this.lib();
    const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack(), at = await input.getPrimaryAudioTrack();
    if (!vt || !at) return { ok: false, checks: [{ ok: false, label: 'Le fichier ne contient pas de piste vidéo et audio.' }], frames: [] };
    const vDur = await vt.computeDuration(), aDur = await at.computeDuration();
    // parcours des images (métadonnées seulement) : nombre et régularité des timestamps
    const sink = new MB.EncodedPacketSink(vt), ts = [];
    for (let p = await sink.getFirstPacket({ metadataOnly: true }); p; p = await sink.getNextPacket(p, { metadataOnly: true })) ts.push(p.timestamp);
    ts.sort((a, b) => a - b);
    let maxDev = 0; for (let i = 1; i < ts.length; i++) maxDev = Math.max(maxDev, Math.abs(ts[i] - ts[i - 1] - 1 / FPS));
    const vCodec = await vt.getCodecParameterString(), aCodec = await at.getCodecParameterString();
    const expected = Math.round(aDur * FPS);
    const checks = [
      { ok: vt.codec === 'avc' && /^avc1\.(64|4d|42)/i.test(vCodec || ''), label: `Vidéo H.264 (${vCodec}), sous-échantillonnage 4:2:0` },
      { ok: !info.colr || (!info.colr.full && info.colr.matrix === 1), label: !info.colr ? 'Couleurs : pas d\'étiquette (lue comme yuv420p, plage vidéo)'
          : `Couleurs ${info.colr.full ? 'plage complète (yuvj420p)' : 'yuv420p (plage vidéo)'}, matrice ${info.colr.matrix === 1 ? 'BT.709' : info.colr.matrix}` },
      { ok: at.codec === 'aac', label: `Audio AAC (${aCodec}), ${at.sampleRate} Hz` },
      { ok: vt.codedWidth === W && vt.codedHeight === H, label: `Taille ${vt.codedWidth}×${vt.codedHeight}` },
      { ok: Math.abs(vDur - aDur) <= 0.1, label: `Durée vidéo ${vDur.toFixed(2)} s = durée audio ${aDur.toFixed(2)} s (±0,1 s)` },
      { ok: Math.abs(ts.length - expected) <= 1, label: `${ts.length} images ≈ ${aDur.toFixed(2)} s × 30 = ${expected}` },
      { ok: maxDev < 0.002, label: `Fréquence constante 30 i/s (écart max ${(maxDev * 1000).toFixed(2)} ms)` },
    ];
    // 3 images de contrôle : à 5 s, au milieu, 2 s avant la fin
    const cs = new MB.CanvasSink(vt, { width: 270, height: 480, fit: 'fill' });
    const frames = [];
    const points = timeline.qcPoints || [['5 s', 5], ['milieu', vDur / 2], ['fin − 2 s', vDur - 2]];
    const describe = timeline.describe || (t => Timeline.lineAt(timeline, t));
    for (const [name, t] of points) {
      const w = await cs.getCanvas(Math.max(0, t));
      let url = '';
      if (w) {
        const c = document.createElement('canvas'); c.width = 270; c.height = 480; c.getContext('2d').drawImage(w.canvas, 0, 0);
        url = c.toDataURL('image/jpeg', 0.85);
      }
      frames.push({ name, t, url, expected: describe(t) });
    }
    return { ok: checks.every(c => c.ok), checks, frames };
  },
};

/* ---------- Exports : WAV, MP3, SRT, téléchargement ---------- */
const Exports = {
  LAME_URL: 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js',
  wav(samples, sr) {
    const b = new ArrayBuffer(44 + samples.length * 2), v = new DataView(b);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
    return new Blob([b], { type: 'audio/wav' });
  },
  async mp3(samples, sr) {
    if (!window.lamejs) await loadScript(this.LAME_URL);
    const enc = new lamejs.Mp3Encoder(1, sr, 128), out = [], N = 1152, pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 0x7fff;
    for (let i = 0; i < pcm.length; i += N) { const d = enc.encodeBuffer(pcm.subarray(i, i + N)); if (d.length) out.push(new Uint8Array(d)); }
    const f = enc.flush(); if (f.length) out.push(new Uint8Array(f));
    return new Blob(out, { type: 'audio/mpeg' });
  },
  srtTime(t) {
    const ms = Math.max(0, Math.round(t * 1000)), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    const z = (n, l = 2) => String(n).padStart(l, '0');
    return `${z(h)}:${z(m)}:${z(s)},${z(ms % 1000, 3)}`;
  },
  srt(tl, withFr) {
    return tl.items.map((it, i) => `${i + 1}\n${this.srtTime(it.start)} --> ${this.srtTime(Math.min(it.dispEnd, it.end + 0.6))}\n${it.srtText || it.text}${withFr && it.translation ? '\n' + it.translation : ''}\n`).join('\n');
  },
  download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  },
  slug(s) { return (s || 'dialogue').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '') || 'dialogue'; },
};

