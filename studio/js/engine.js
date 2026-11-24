// Sonderline Social System: layout engine.
// One renderer for the web studio and the CLI. A spec (written by a person or drafted by
// Claude) only makes choices: which approved lines, which layout, which photo and crop.
// Every placement, size, colour and scrim decision is made here, in code, from rules/*.json.

import { sampleLuminance, worstContrast } from './color.js';

const CAP = 0.727;      // Inter Tight cap height / em
const DESC = 0.24;      // descender allowance / em

export function frames(spec) {
  if (!spec.frames) return [{ ...spec, frameIndex: 0, frameCount: 1 }];
  return spec.frames.map((f, i) => ({
    ...spec, ...f,
    content: { ...(spec.content || {}), ...(f.content || {}) },
    frames: undefined, frameIndex: i, frameCount: spec.frames.length,
  }));
}

export function render(canvas, brand, frame, formatId) {
  const f = brand.formats[formatId];
  if (!f) throw new Error(`Unknown format "${formatId}"`);
  canvas.width = f.w; canvas.height = f.h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // a designer can override the crop per format (portrait and landscape rarely want the same crop)
  const ov = frame.photo && frame.photoOverrides?.[formatId];
  if (ov) frame = { ...frame, photo: { ...frame.photo, ...ov } };
  const layout = LAYOUTS[frame.layout];
  if (!layout) throw new Error(`Unknown layout "${frame.layout}"`);
  // Elastic layout: if copy doesn't fit, re-lay the frame giving text more room
  // (smaller photo band, more lines, slightly smaller minimum size). Up to 3 steps.
  let R;
  for (let relax = 0; relax <= 3; relax++) {
    ctx.clearRect(0, 0, f.w, f.h);
    R = new Renderer(ctx, brand, f, frame, relax);
    layout(R);
    if (!crowded(R.geometry)) break;
  }
  if (R.relax) R.notes.push(`Copy needed more room: layout relaxed ${R.relax} step${R.relax > 1 ? 's' : ''}.`);
  return R.finish();
}

const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function crowded(G) {
  const boxes = G.filter(g => g.kind === 'text' || g.kind === 'arrow' || g.kind === 'logo');
  if (G.some(g => g.kind === 'text' && (g.overflow || g.lines.length > g.maxLines))) return true;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (hit(boxes[i], boxes[j])) return true;
  return false;
}

class Renderer {
  constructor(ctx, brand, f, frame, relax = 0) {
    Object.assign(this, { ctx, brand, f, frame, relax });
    this.W = f.w; this.H = f.h; this.u = f.u;
    this.m = Math.round(0.04 * f.u);
    this.c = Object.fromEntries(Object.entries(brand.tokens.colour).map(([k, v]) => [k, v.hex]));
    this.geometry = [];
    this.fg = [];           // foreground ops (text, logos), drawn after the background snapshot
    this.notes = [];        // decisions the engine made, shown to the reviewer
    this.landscape = f.w / f.h > 1.25;
    this.safeTop = f.safeTop || 0;
    this.safeBottom = f.safeBottom || 0;
    // footer top: stories keep the footer content above the platform's bottom UI zone
    this.yF = f.footerContent ? f.h - this.safeBottom - f.footerContent : Math.round(f.h * (1 - f.footer));
    // cap-top of the first text line in a field that touches the top edge
    this.top = Math.max(Math.round(1.1 * this.m), this.safeTop ? this.safeTop + Math.round(0.02 * f.u) : 0);
    ctx.textBaseline = 'alphabetic';
  }

  // ---------- backgrounds (drawn immediately) ----------
  field(colorKey, x, y, w, h) {
    const hex = this.c[colorKey] ?? colorKey;
    this.ctx.fillStyle = hex;
    this.ctx.fillRect(x, y, w, h);
    this.geometry.push({ kind: 'field', color: hex, name: colorKey, x, y, w, h });
  }

  photo(p, r) {
    const img = this.brand.photos[p.id];
    if (!img) throw new Error(`Unknown photo "${p.id}"`);
    const z = p.zoom || 1;
    const s = Math.max(r.w / img.width, r.h / img.height) * z;
    const dw = img.width * s, dh = img.height * s;
    const [fx, fy] = p.focus || [0.5, 0.5];
    const dx = Math.min(r.x, Math.max(r.x + r.w - dw, r.x + r.w / 2 - fx * dw));
    const dy = Math.min(r.y, Math.max(r.y + r.h - dh, r.y + r.h / 2 - fy * dh));
    const ctx = this.ctx;
    ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
    const g = { kind: 'photo', id: p.id, ...r, upscale: s, scrim: 0 };
    this.geometry.push(g);
    return g;
  }

  // Black gradient scrim over the top of a photo. 'auto' solves for the lightest scrim
  // that keeps white text in `textBox` at >= target contrast (guide p06: 4.5:1 minimum).
  scrim(photoGeom, mode, textBox, redraw) {
    const target = this.brand.tokens.min_contrast + 0.5;   // headroom over 4.5:1
    const draw = a => {
      redraw();
      if (a <= 0) return;
      const ctx = this.ctx, r = photoGeom;
      const hold = Math.min(r.y + r.h, textBox.y + textBox.h + 0.06 * this.H);
      const end = Math.min(r.y + r.h, hold + 0.3 * this.H);
      // darkest behind the headline, easing off to the right and downwards
      const off = new OffscreenCanvas(r.w, end - r.y), o = off.getContext('2d');
      const v = o.createLinearGradient(0, 0, 0, end - r.y);
      v.addColorStop(0, `rgba(0,0,0,${a})`);
      v.addColorStop(Math.max(0, (hold - r.y) / (end - r.y)), `rgba(0,0,0,${a})`);
      v.addColorStop(1, 'rgba(0,0,0,0)');
      o.fillStyle = v; o.fillRect(0, 0, r.w, end - r.y);
      const hz = o.createLinearGradient(0, 0, r.w, 0);
      const edge = Math.min(0.98, (textBox.x + textBox.w * 1.08 - r.x) / r.w);
      hz.addColorStop(0, 'rgba(0,0,0,1)'); hz.addColorStop(edge, 'rgba(0,0,0,1)'); hz.addColorStop(1, 'rgba(0,0,0,0.3)');
      o.globalCompositeOperation = 'destination-in';
      o.fillStyle = hz; o.fillRect(0, 0, r.w, end - r.y);
      ctx.drawImage(off, r.x, r.y);
    };
    const measure = () => worstContrast(
      sampleLuminance(this.ctx.getImageData(0, 0, this.W, this.H), textBox, 4), this.c.white);
    let a = 0;
    if (mode === 'off') a = 0;
    else if (typeof mode === 'number') a = mode;
    else {
      for (a = 0; a <= 0.9; a = +(a + 0.05).toFixed(2)) { draw(a); if (measure() >= target) break; }
      a = Math.min(a, 0.9);
      this.notes.push(`Scrim auto-set to ${Math.round(a * 100)}% so the headline clears ${target}:1 on this crop.`);
    }
    draw(a);
    photoGeom.scrim = a;
  }

  rule(x, y, w, h) { this.field('vermilion', x, y, w, h); }

  // Flow graphics (ASSUMED; see tokens.flow). Built from the S symbol's stroke: a horizontal band
  // that steps through a smooth S-curve, with the symbol's slanted "/" terminals. Never the symbol
  // itself. Deterministic per seed so re-renders match.
  flow(r, colourway, seed = 1, styleIn) {
    const T = this.brand.tokens.flow;
    const cw = T.colourways[colourway] || T.colourways.lavender;
    const style = styleIn || this.frame.flowStyle || T.style || 'lanes';
    const ctx = this.ctx, sig = T.signal_bar, ink = cw.bars;
    let sd = seed >>> 0;
    const rnd = () => { sd = (sd + 0x6D2B79F5) >>> 0; let t = sd; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const slantK = 1 / Math.tan(T.slant_deg * Math.PI / 180);
    const ease = (x, xs, w) => { const k = Math.min(1, Math.max(0, (x - (xs - w / 2)) / w)); return k * k * (3 - 2 * k); };
    const profile = (base, steps) => x => base + steps.reduce((a, st) => a + st.dy * ease(x, st.x, st.w), 0);
    // one stroke: top edge follows yAt(x); thickness t; slanted ends like the symbol
    const band = (x0, x1, t, yAt, color) => {
      const sl = t * slantK, n = Math.max(12, Math.ceil((x1 - x0) / 3));
      ctx.fillStyle = color; ctx.beginPath();
      for (let i = 0; i <= n; i++) { const x = x0 + sl + (x1 - x0 - sl) * i / n; i ? ctx.lineTo(x, yAt(x)) : ctx.moveTo(x, yAt(x)); }
      for (let i = n; i >= 0; i--) { const x = x0 + (x1 - sl - x0) * i / n; ctx.lineTo(x, yAt(x) + t); }
      ctx.closePath(); ctx.fill();
    };
    ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();

    if (style === 'bars') {                       // v0 stand-in, kept for comparison
      const rows = Math.max(3, Math.round(r.h / (0.05 * this.u))), t = r.h / (rows * 1.9), sl = t * slantK;
      const signalRow = Math.floor(rnd() * rows);
      for (let i = 0; i < rows; i++) {
        const y = r.y + i * t * 1.9; let x = r.x + rnd() * r.w * 0.25;
        const n = 1 + Math.floor(rnd() * 3);
        for (let j = 0; j < n && x < r.x + r.w - 4 * t; j++) {
          const w = Math.min(r.x + r.w - x, (0.12 + rnd() * 0.35) * r.w), isSig = i === signalRow && j === 0;
          band(x, x + (isSig ? Math.min(w, 0.14 * r.w) : w), t, () => y, isSig ? sig : ink);
          x += w + (0.04 + rnd() * 0.08) * r.w;
        }
      }
    } else if (style === 'lanes') {
      const n = Math.max(4, Math.min(7, Math.round(r.h / (0.06 * this.u))));
      const t = r.h / (n * 2.0 + 0.6), gap = t, dy = -0.6 * t;
      const sigRow = 1 + Math.floor(rnd() * (n - 2));
      for (let i = 0; i < n; i++) {
        const base = r.y + 0.6 * t + i * (t + gap);
        const x0 = r.x + rnd() * 0.22 * r.w;
        const isSig = i === sigRow;
        const x1 = isSig ? x0 + (0.3 + rnd() * 0.15) * r.w : r.x + (0.72 + rnd() * 0.28) * r.w;
        const xs = x0 + (0.25 + rnd() * 0.5) * (x1 - x0);
        band(x0, x1, t, profile(base, [{ x: xs, w: 1.6 * t, dy }]), isSig ? sig : ink);
      }
    } else if (style === 'converge') {
      const n = 6, t = r.h / (n * 2.3), g = 0.28 * t;
      const bundle = n * t + (n - 1) * g, cy = r.y + r.h / 2;
      const sigRow = Math.floor(n / 2);
      for (let i = 0; i < n; i++) {
        const ys = r.y + i * (r.h - t) / (n - 1);
        const ye = cy - bundle / 2 + i * (t + g);
        const xs = r.x + r.w * (0.34 + 0.05 * Math.abs(i - (n - 1) / 2) + rnd() * 0.04);
        const w = Math.max(1.6 * t, Math.abs(ye - ys) * 0.9);
        const x0 = r.x + rnd() * 0.12 * r.w;
        band(x0, r.x + r.w + t, t, profile(ys, [{ x: xs, w, dy: ye - ys }]), i === sigRow ? sig : ink);
      }
    } else if (style === 'supergraphic') {
      const t = r.h * 0.4, dy = -0.5 * t;
      const base = r.y + r.h - t - 0.04 * r.h;
      const xs = r.x + r.w * (0.42 + rnd() * 0.1);
      band(r.x + r.w * 0.04, r.x + r.w + 2 * t, t, profile(base, [{ x: xs, w: 1.3 * t, dy }]), ink);
    } else if (style === 'contour') {
      const n = Math.max(10, Math.round(r.h / (0.022 * this.u)));
      const t = r.h / (n * 2.1), pitch = r.h / n, dy = -2.2 * pitch;
      const xs = r.x + r.w * (0.45 + rnd() * 0.1), w = 0.22 * r.w;
      const sigRow = Math.floor(n * 0.6);
      for (let i = 0; i < n + 3; i++) {
        const base = r.y + (i + 0.3) * pitch - dy * 0;
        band(r.x - 2 * t, r.x + r.w + 2 * t, t, profile(base, [{ x: xs + i * 0.004 * r.w, w, dy }]), i === sigRow ? sig : ink);
      }
    }
    ctx.restore();
    this.geometry.push({ kind: 'graphic', name: 'flow', style, colourway, status: 'assumed', ...r });
  }

  // ---------- text ----------
  fit(text, o) {
    const ctx = this.ctx;
    for (let size = Math.round(o.size); ; size = Math.floor(size * 0.96)) {
      this.font(size, o.weight || 400, o.ls || 0);
      let lines = this.wrap(text, o.maxW, o.breaks);
      if (o.breaks && lines.length > o.maxLines) lines = this.wrap(text, o.maxW, false);
      const width = Math.max(...lines.map(l => ctx.measureText(l).width));
      const height = size * CAP + (lines.length - 1) * size * (o.lh ?? 1.12) + DESC * size;
      const ok = lines.length <= o.maxLines && width <= o.maxW + 0.5 && height <= (o.maxH ?? 1e9);
      if (ok || size <= o.min) {
        if (ok && !o.breaks && lines.length > 1) lines = this.balance(text, lines.length, width);
        return { size, lines, width: Math.max(...lines.map(l => ctx.measureText(l).width)), overflow: !ok };
      }
    }
  }

  // Narrowest measure that keeps the same line count: even rag, no orphans ("Q1 / 2027.").
  balance(text, n, maxW) {
    let lo = maxW / n, hi = maxW;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (this.wrap(text, mid, false).length <= n) hi = mid; else lo = mid;
    }
    return this.wrap(text, hi, false);
  }

  wrap(text, maxW, sentenceBreaks) {
    const segs = sentenceBreaks ? text.split(/(?<=[.,])\s+/) : [text];
    const lines = [];
    for (const seg of segs) {
      let line = '';
      for (const word of seg.split(/\s+/)) {
        const t = line ? `${line} ${word}` : word;
        if (!line || this.ctx.measureText(t).width <= maxW) line = t;
        else { lines.push(line); line = word; }
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  font(size, weight, ls = 0) {
    this.ctx.font = `${weight} ${size}px "${this.brand.tokens.type.family}"`;
    this.ctx.letterSpacing = `${(ls * size).toFixed(2)}px`;
  }

  // Lays out a text block whose first line's cap-top sits at y. Returns its box.
  // Text is queued and drawn after the background snapshot used by the validator.
  text(t) {
    const lh = t.lh ?? 1.12;
    const fit = t.lines ? { size: t.size, lines: t.lines, overflow: !!t.overflow } : this.fit(t.text, {
      size: t.size, min: t.min ?? t.size, maxW: t.maxW ?? 1e9, maxLines: t.maxLines ?? 1,
      weight: t.weight, ls: t.ls, breaks: t.breaks, lh: t.lh, maxH: t.maxH,
    });
    this.font(fit.size, t.weight || 400, t.ls || 0);
    const width = Math.max(...fit.lines.map(l => this.ctx.measureText(l).width));
    const capTop = t.y, cap = fit.size * CAP;
    const lastBase = capTop + cap + (fit.lines.length - 1) * fit.size * lh;
    const x0 = t.align === 'right' ? t.x - width : t.x;
    const box = { x: x0, y: capTop - 0.08 * fit.size, w: width, h: lastBase + DESC * fit.size - (capTop - 0.08 * fit.size) };
    const color = this.c[t.color] ?? t.color;
    this.fg.push(() => {
      this.font(fit.size, t.weight || 400, t.ls || 0);
      this.ctx.fillStyle = color;
      this.ctx.textAlign = t.align || 'left';
      fit.lines.forEach((l, i) => this.ctx.fillText(l, t.x, capTop + cap + i * fit.size * lh));
      this.ctx.textAlign = 'left';
    });
    this.geometry.push({
      kind: 'text', role: t.role, text: t.text, system: !!t.system, lines: fit.lines,
      size: fit.size, weight: t.weight || 400, color, on: t.on, overflow: fit.overflow,
      maxLines: t.maxLines ?? 1, ...box, baseline: capTop + cap,
    });
    return { ...box, size: fit.size, bottom: lastBase + DESC * fit.size, baseline: capTop + cap, lastBase, lines: fit.lines };
  }

  arrow(x2, yMid, len, color = 'black') {
    const ctx = this.ctx, lw = Math.max(1.5, 0.0022 * this.u), hd = 0.011 * this.u;
    this.fg.push(() => {
      ctx.strokeStyle = this.c[color] ?? color; ctx.lineWidth = lw; ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(x2 - len, yMid); ctx.lineTo(x2, yMid);
      ctx.moveTo(x2 - hd, yMid - hd * 0.62); ctx.lineTo(x2, yMid); ctx.lineTo(x2 - hd, yMid + hd * 0.62);
      ctx.stroke();
    });
    this.geometry.push({ kind: 'arrow', x: x2 - len, y: yMid - hd, w: len, h: 2 * hd });
  }

  logo(key, x, y, h) {
    const aspect = this.brand.tokens.logo.aspect[key.startsWith('lockup') ? 'lockup' : 'symbol'];
    const w = h * aspect, img = this.brand.logos[key];
    this.fg.push(() => this.ctx.drawImage(img, x, y, w, h));
    const inset = h / 4;   // supplied files carry h/2 clearspace: visible art = middle half
    this.geometry.push({
      kind: 'logo', key, file: this.brand.tokens.logo[key], x, y, w, h, aspect: w / h, expectedAspect: aspect,
      visible: { x: x + inset, y: y + inset, w: w - 2 * inset, h: h - 2 * inset },
    });
  }

  // Black footer: micro-label left, white lockup right (guide p07/p09).
  footer(y0 = this.yF) {
    const { W, H, u, m, f } = this;
    this.field('black', 0, y0, W, H - y0);
    const ch = f.footerContent || (H - y0);
    const Lh = Math.min(0.104 * u, ch * 0.92);
    const visRight = W - m;
    this.logo('lockup_white', visRight - (Lh * this.brand.tokens.logo.aspect.lockup - Lh / 4), y0 + ch / 2 - Lh / 2, Lh);
    const sys = this.frame.footerIndex;
    const lab = sys || this.frame.content.footer_label;
    if (lab) {
      const size = Math.round(0.0167 * u);
      this.text({ role: 'footer_label', text: lab, system: !!sys, x: m, y: y0 + ch / 2 - size * CAP / 2, size, color: 'white', on: 'black' });
    }
  }

  finish() {
    this.bg = this.ctx.getImageData(0, 0, this.W, this.H);
    for (const op of this.fg) op();
    return { geometry: this.geometry, bg: this.bg, W: this.W, H: this.H, format: this.f, notes: this.notes, frame: this.frame };
  }
}

// ---------- shared pieces ----------
const measure = (R, text, size, weight = 400) => { R.font(size, weight); return R.ctx.measureText(text).width; };
const blockH = (fit, lh) => fit.size * CAP + (fit.lines.length - 1) * fit.size * lh + DESC * fit.size;

// Info row (guide p09): white panel (left 2/3) with label, lead and CTA; vermilion rule; accent
// panel (right 1/3) with status. Lead and CTA stack when there's room, else share a row.
function infoRow(R, yI, hI) {
  const { W, u, m } = R;
  const c = R.frame.content;
  const split = Math.round(W * 2 / 3), rw = Math.max(4, Math.round(0.0146 * u));
  const accent = R.frame.accent || 'lavender';
  R.field('white', 0, yI, split, hI);
  R.rule(split, yI, rw, hI);
  R.field(accent, split + rw, yI, W - split - rw, hI);

  const pad = Math.round(0.9 * m), lab = Math.round(0.0167 * u), gap = Math.round(0.035 * u);
  const ctaSize = Math.round(0.027 * u), arrowLen = Math.round(0.045 * u);
  if (c.label) R.text({ role: 'label', text: c.label, x: m, y: yI + pad, size: lab, color: 'black', on: 'white' });
  const leadTop = yI + pad + lab * CAP + gap;
  const floor = yI + hI - 0.55 * pad;                  // lowest ink allowed in the row
  const ctaTop = yI + hI - pad - ctaSize * CAP;
  const lw = split - 2 * m;
  const k = R.relax;
  const leadOpts = { size: 0.046 * u, min: (0.026 - 0.002 * k) * u, maxLines: 3 + k, ls: -0.005, lh: 1.1 };

  if (c.lead) {
    let mode = 'stacked';
    let lf = R.fit(c.lead, { ...leadOpts, maxW: lw, maxH: (c.cta ? ctaTop - 0.025 * u : floor) - leadTop });
    if (lf.overflow && c.cta) {
      const leadW = lw - measure(R, c.cta, ctaSize) - arrowLen - 0.06 * u;
      const cf = R.fit(c.lead, { ...leadOpts, maxW: leadW, maxH: floor - leadTop });
      if (!cf.overflow) { mode = 'row'; lf = cf; }
    }
    const lead = R.text({ role: 'lead', text: c.lead, x: m, y: leadTop, size: lf.size, lines: lf.lines, overflow: lf.overflow, ls: -0.005, lh: 1.1, color: 'black', on: 'white', maxLines: 3 + k });
    if (c.cta && mode === 'stacked') {
      R.text({ role: 'cta', text: c.cta, x: m, y: ctaTop, size: ctaSize, color: 'black', on: 'white' });
      R.arrow(split - m, ctaTop + ctaSize * CAP * 0.5, arrowLen);
    } else if (c.cta) {
      const ctaY = lead.baseline - ctaSize * CAP;
      R.text({ role: 'cta', text: c.cta, x: split - m - arrowLen - 0.025 * u, y: ctaY, size: ctaSize, color: 'black', on: 'white', align: 'right' });
      R.arrow(split - m, ctaY + ctaSize * CAP * 0.5, arrowLen);
    }
  } else if (c.cta) {
    R.text({ role: 'cta', text: c.cta, x: m, y: ctaTop, size: ctaSize, color: 'black', on: 'white' });
    R.arrow(split - m, ctaTop + ctaSize * CAP * 0.5, arrowLen);
  }

  const rx = split + rw + Math.round(0.6 * m);
  if (c.status_label) R.text({ role: 'status_label', text: c.status_label, x: rx, y: yI + pad, size: lab, color: 'black', on: accent });
  if (c.status) R.text({
    role: 'status', text: c.status, x: rx, y: leadTop, size: 0.029 * u, min: 0.017 * u,
    maxW: W - rx - 0.8 * m, maxLines: 4, maxH: floor - leadTop, lh: 1.25, color: 'black', on: accent,
  });
}

// Capability line: a row when it fits, otherwise a stacked list. Returns its height.
function capabilities(R, x, yBottom, maxW, on, dryRun = false) {
  const { u } = R;
  const caps = R.brand.copy.product.capabilities;
  const size = Math.round(0.024 * u), gapX = 0.035 * u, step = Math.round(size * 1.4);
  const widths = caps.map(t => measure(R, t, size));
  const row = widths.reduce((a, b) => a + b, 0) + gapX * (caps.length - 1) <= maxW;
  const h = row ? size * CAP : size * CAP + (caps.length - 1) * step;
  if (dryRun) return h;
  let cx = x;
  caps.forEach((t, i) => {
    const y = row ? yBottom - size * CAP : yBottom - h + i * step;
    R.text({ role: 'capability', text: t, x: row ? cx : x, y, size, color: 'black', on });
    cx += widths[i] + gapX;
  });
  return h;
}

// ---------- layout families ----------
const LAYOUTS = {
  // Guide p09: one message over photography, info row, clear footer.
  'photo-hero'(R) {
    const { W, H, u, m, frame } = R;
    const k = R.relax, hLines = R.f.headlineLines + (k >= 2 ? 1 : 0);
    const yI = Math.round(H * (R.f.photo - 0.07 * k)), yF = R.yF;
    const photoRect = { x: 0, y: 0, w: W, h: yI };
    const hasPhoto = !!frame.photo;
    const est = Math.max(Math.round(1.1 * m), R.safeTop ? R.safeTop + 0.02 * u : 0);
    // measure the headline first so the scrim can be solved against its real box
    const h = R.fit(frame.content.headline, {
      size: (frame.headlineScale ?? R.f.headlineScale ?? 0.125) * u, min: (0.05 - 0.005 * k) * u, maxW: R.f.headlineW * W,
      maxLines: hLines, ls: -0.015, lh: 0.98, breaks: true, maxH: yI - est - 0.9 * m,
    });
    const top = Math.max(Math.round(1.1 * m), R.safeTop ? R.safeTop + 0.12 * h.size : 0);
    const box = { x: m, y: top - 0.08 * h.size, w: h.width, h: h.size * CAP + (h.lines.length - 1) * h.size * 0.98 + (DESC + 0.08) * h.size };
    if (hasPhoto) {
      const g = R.photo(frame.photo, photoRect);
      R.geometry.pop();
      const redraw = () => { R.ctx.fillStyle = '#000'; R.ctx.fillRect(0, 0, W, yI); R.photo(frame.photo, photoRect); R.geometry.pop(); };
      R.geometry.push(g);
      R.scrim(g, frame.scrim ?? 'auto', box, redraw);
    } else {
      R.field('black', 0, 0, W, yI);
      const fy = box.y + box.h + 0.08 * u, fh = yI - fy - 0.08 * u;
      if (frame.flow && fh > 0.1 * u) R.flow({ x: m, y: fy, w: W - 2 * m, h: fh }, 'black', frame.flowSeed || 3);
    }
    R.text({
      role: 'headline', text: frame.content.headline, x: m, y: top, size: h.size, lines: h.lines, overflow: h.overflow,
      ls: -0.015, lh: 0.98, color: 'white', on: hasPhoto ? 'photo' : 'black', maxLines: hLines,
    });
    infoRow(R, yI, yF - yI);
    R.footer(yF);
  },

  // Guide p11: type-led field with a vermilion tick. Carousel covers and closers.
  'type-led'(R) {
    const { W, u, m, frame } = R;
    const yF = R.yF, c = frame.content;
    const fieldKey = frame.field || 'lavender';
    R.field(fieldKey, 0, 0, W, yF);
    const rw = Math.max(4, Math.round(0.0146 * u));
    R.rule(0, 0, Math.round(0.17 * W), rw);
    const lab = Math.round(0.0167 * u);
    const top = Math.max(Math.round(1.1 * m) + rw, R.top);
    if (c.label) R.text({ role: 'label', text: c.label, x: m, y: top, size: lab, color: 'black', on: fieldKey });
    const ctaSize = Math.round(0.027 * u), arrowLen = Math.round(0.045 * u);
    const ctaTop = yF - m - ctaSize * CAP;
    let leadTop = c.cta ? ctaTop - 0.02 * u : yF - m;
    if (c.lead) {
      const lf = R.fit(c.lead, { size: 0.046 * u, min: (0.026 - 0.002 * R.relax) * u, maxW: W * Math.min(0.92, (R.landscape ? 0.55 : 0.75) + 0.1 * R.relax), maxLines: 4 + R.relax, ls: -0.005, lh: 1.1, maxH: (0.3 + 0.07 * R.relax) * yF });
      leadTop = (c.cta ? ctaTop - 0.07 * u : yF - m) - blockH(lf, 1.1) + DESC * lf.size;
      R.text({ role: 'lead', text: c.lead, x: m, y: leadTop, size: lf.size, lines: lf.lines, overflow: lf.overflow, lh: 1.1, ls: -0.005, color: 'black', on: fieldKey, maxLines: 4 + R.relax });
    }
    if (c.cta) {
      R.text({ role: 'cta', text: c.cta, x: m, y: ctaTop, size: ctaSize, color: 'black', on: fieldKey });
      R.arrow(W - m, ctaTop + ctaSize * CAP * 0.5, arrowLen);
    }
    const hTop = top + lab * CAP + 0.05 * u;
    const hl = R.text({
      role: 'headline', text: c.headline, x: m, y: hTop, size: 0.2 * u, min: (0.06 - 0.008 * R.relax) * u,
      maxW: W * (R.landscape ? 0.75 + 0.08 * R.relax : 1) - 2 * m, maxLines: 3 + (R.relax >= 2 ? 1 : 0), maxH: leadTop - 0.06 * u - hTop,
      ls: -0.025, lh: 0.95, breaks: true, color: 'black', on: fieldKey,
    });
    const fy = hl.bottom + 0.06 * u, fh = leadTop - 0.08 * u - fy;
    if (frame.flow && fh > 0.08 * u) R.flow({ x: m, y: fy, w: W - 2 * m, h: fh }, fieldKey === 'black' ? 'black' : fieldKey, frame.flowSeed || 7);
    R.footer(yF);
  },

  // Carousel frame: one signal per frame, full list below with the current item in bold plus a
  // vermilion marker (not colour alone). Tall formats: photo on top. Square/wide: photo beside.
  'signal'(R) {
    const { W, H, u, m, frame } = R;
    const yF = R.yF, c = frame.content;
    const side = H / W < 1.1;
    const fieldKey = frame.field || 'white';
    let textW = W, topY;
    if (side) {
      const pw = Math.round(W * (0.4 - 0.06 * R.relax));
      if (frame.photo) R.photo(frame.photo, { x: W - pw, y: 0, w: pw, h: yF });
      R.field(fieldKey, 0, 0, W - pw, yF);
      textW = W - pw; topY = R.top;
    } else {
      const yP = Math.round(H * ((frame.photoBand ?? 0.4) - 0.06 * R.relax));
      if (frame.photo) R.photo(frame.photo, { x: 0, y: 0, w: W, h: yP });
      R.field(fieldKey, 0, yP, W, yF - yP);
      topY = Math.max(yP + m, R.safeTop);
    }
    const lab = Math.round(0.0167 * u);
    if (c.label) R.text({ role: 'label', text: c.label, x: m, y: topY, size: lab, color: 'black', on: fieldKey });
    if (frame.index) R.text({ role: 'index', text: frame.index, system: true, x: textW - m, y: topY, size: lab, color: 'black', on: fieldKey, align: 'right' });
    const items = R.brand.copy.product.signals;
    const size = Math.round((side ? 0.026 : 0.029) * u), step = Math.round(size * 1.5), mk = Math.round(0.016 * u);
    const y0 = yF - m - size * CAP - (items.length - 1) * step;
    const sTop = topY + lab * CAP + 0.045 * u;
    R.text({
      role: 'headline', text: c.signal, x: m, y: sTop, size: 0.14 * u, min: (0.05 - 0.005 * R.relax) * u,
      maxW: side ? textW - 2 * m : textW * 0.62, maxLines: 2, maxH: y0 - 0.025 * u - sTop, ls: -0.02, lh: 0.98, color: 'black', on: fieldKey,
    });
    items.forEach((it, i) => {
      const cur = it === c.signal;
      if (cur) R.rule(m, y0 + i * step + (size * CAP - mk) / 2, mk, mk);
      R.text({ role: 'list', text: it, x: m + mk + 0.02 * u, y: y0 + i * step, size, weight: cur ? 700 : 400, color: 'black', on: fieldKey });
    });
    R.footer(yF);
  },

  // Guide p11: presentation information layout. Lavender lead panel, 2x2 signal tiles,
  // capabilities, logo in a reserved footer. Wide: panel on the left. Tall: panel on top.
  'signal-grid'(R) {
    const { W, u, m, frame } = R;
    const yF = R.yF, c = frame.content;
    const rw = Math.max(4, Math.round(0.0146 * u)), lab = Math.round(0.0167 * u);
    const ctaSize = Math.round(0.027 * u), arrowLen = Math.round(0.045 * u);
    R.field('white', 0, 0, W, yF);
    let gx, gy, gw, capX;
    if (R.landscape) {
      const lw = Math.round(W * (0.34 + 0.04 * R.relax));
      R.field('lavender', 0, 0, lw, yF);
      R.rule(0, 0, Math.round(lw * 0.25), rw);
      const ctaTop = yF - m - ctaSize * CAP;
      let leadTop = ctaTop;
      if (c.lead) {
        const lf = R.fit(c.lead, { size: 0.034 * u, min: 0.02 * u, maxW: lw - 2 * m, maxLines: 4 + R.relax, ls: -0.005, maxH: (0.3 + 0.06 * R.relax) * yF });
        leadTop = ctaTop - 0.06 * u - blockH(lf, 1.12) + DESC * lf.size;
        R.text({ role: 'lead', text: c.lead, x: m, y: leadTop, size: lf.size, lines: lf.lines, overflow: lf.overflow, color: 'black', on: 'lavender', maxLines: 4 + R.relax });
      }
      if (c.cta) { R.text({ role: 'cta', text: c.cta, x: m, y: ctaTop, size: ctaSize, color: 'black', on: 'lavender' }); R.arrow(lw - m, ctaTop + ctaSize * CAP / 2, arrowLen); }
      const hTop = Math.round(1.6 * m);
      R.text({ role: 'headline', text: c.headline, x: m, y: hTop, size: 0.11 * u, min: (0.04 - 0.004 * R.relax) * u, maxW: lw - 2 * m, maxLines: 3 + R.relax, maxH: leadTop - 0.05 * u - hTop, ls: -0.025, lh: 0.95, color: 'black', on: 'lavender' });
      if (c.label) R.text({ role: 'label', text: c.label, x: lw + m, y: Math.round(1.1 * m), size: lab, color: 'black', on: 'white' });
      gx = lw; gy = Math.round(2.4 * m) + lab; gw = W - lw; capX = lw + m;
    } else {
      const pH = Math.round(R.top + (yF - R.top) * (0.36 + 0.06 * R.relax));
      R.field('lavender', 0, 0, W, pH);
      R.rule(0, 0, Math.round(W * 0.17), rw);
      if (c.label) R.text({ role: 'label', text: c.label, x: m, y: R.top + rw, size: lab, color: 'black', on: 'lavender' });
      const ctaTop = pH - m - ctaSize * CAP;
      if (c.cta) { R.text({ role: 'cta', text: c.cta, x: m, y: ctaTop, size: ctaSize, color: 'black', on: 'lavender' }); R.arrow(W - m, ctaTop + ctaSize * CAP / 2, arrowLen); }
      const hTop = R.top + rw + lab * CAP + 0.045 * u, hMax = ctaTop - 0.05 * u - hTop;
      R.text({ role: 'headline', text: c.headline, x: m, y: hTop, size: 0.11 * u, min: (0.04 - 0.004 * R.relax) * u, maxW: W * 0.5 - m, maxLines: 3 + R.relax, maxH: hMax, ls: -0.025, lh: 0.95, color: 'black', on: 'lavender' });
      if (c.lead) R.text({ role: 'lead', text: c.lead, x: W * 0.54, y: hTop + 0.01 * u, size: 0.034 * u, min: 0.02 * u, maxW: W * 0.46 - m, maxLines: 4 + R.relax, maxH: hMax, color: 'black', on: 'lavender' });
      gx = 0; gy = pH; gw = W; capX = m;
    }
    const capH = capabilities(R, capX, yF - m, W - capX - m, 'white', true);
    const capLabelY = yF - m - capH - 0.03 * u - lab * CAP;
    const gh = Math.round(capLabelY - 0.045 * u - gy);
    const tiles = R.brand.copy.product.signals, fills = ['white', 'lavender', 'coolgrey', 'white'];
    tiles.forEach((t, i) => {
      const x = gx + (i % 2) * gw / 2, y = gy + Math.floor(i / 2) * gh / 2;
      R.field(fills[i], x, y, gw / 2, gh / 2);
      R.text({ role: 'tile', text: t, x: x + m, y: y + 0.8 * m, size: 0.07 * u, min: 0.03 * u, maxW: gw / 2 - 2 * m, maxLines: 2, maxH: gh / 2 - 1.6 * m, ls: -0.02, lh: 0.98, color: 'black', on: fills[i] });
    });
    R.text({ role: 'label', text: 'CAPABILITIES', x: capX, y: capLabelY, size: lab, color: 'black', on: 'white' });
    capabilities(R, capX, yF - m, W - capX - m, 'white');
    R.footer(yF);
  },

  // Motion storyboard (guide p12), scene 01 / Context: photo, statement on lavender.
  'scene-context'(R) {
    const { W, H, u, m, frame } = R;
    const yF = R.yF;
    if (R.landscape) {
      const pw = Math.round(W * (0.5 - 0.06 * R.relax));
      if (frame.photo) R.photo(frame.photo, { x: W - pw, y: 0, w: pw, h: yF });
      R.field('lavender', 0, 0, W - pw, yF);
      R.text({ role: 'headline', text: frame.content.headline, x: m, y: R.top, size: 0.12 * u, min: (0.05 - 0.005 * R.relax) * u, maxW: W - pw - 2 * m, maxLines: 3 + R.relax, maxH: yF - m - R.top, ls: -0.015, lh: 1.0, breaks: true, color: 'black', on: 'lavender' });
    } else {
      const yP = Math.round(H * (0.6 - 0.07 * R.relax));
      if (frame.photo) R.photo(frame.photo, { x: 0, y: 0, w: W, h: yP });
      R.field('lavender', 0, yP, W, yF - yP);
      R.text({ role: 'headline', text: frame.content.headline, x: m, y: yP + m, size: 0.105 * u, min: (0.05 - 0.005 * R.relax) * u, maxW: W - 2 * m, maxLines: 3 + R.relax, maxH: yF - 2 * m - yP, ls: -0.015, lh: 1.0, breaks: true, color: 'black', on: 'lavender' });
    }
    R.footer(yF);
  },

  // Scene 02 / Product story: headline on white, photo band, operational view on lavender.
  'scene-story'(R) {
    const { W, H, u, m, frame } = R;
    const yF = R.yF, c = frame.content;
    const lab = Math.round(0.0167 * u), rw = Math.max(4, Math.round(0.0146 * u));
    let colW = W, yP0, yP1;
    if (R.landscape) {
      const pw = Math.round(W * (0.42 - 0.05 * R.relax));
      colW = W - pw;
      yP0 = yP1 = Math.round(yF * 0.5);
      if (frame.photo) R.photo(frame.photo, { x: colW, y: 0, w: pw, h: yF });
    } else {
      yP0 = Math.round(R.top + (0.3 + 0.04 * R.relax) * H - Math.round(1.1 * m));
      yP1 = Math.round(yP0 + (0.5 - 0.1 * R.relax) * (yF - yP0));
      if (frame.photo) R.photo(frame.photo, { x: 0, y: yP0, w: W, h: yP1 - yP0 });
    }
    R.field('white', 0, 0, colW, yP0);
    if (c.label) R.text({ role: 'label', text: c.label, x: m, y: R.top, size: lab, color: 'black', on: 'white' });
    const hTop = R.top + lab * CAP + 0.05 * u;
    R.text({ role: 'headline', text: c.headline, x: m, y: hTop, size: 0.08 * u, min: (0.04 - 0.004 * R.relax) * u, maxW: colW * (0.78 + 0.05 * R.relax), maxLines: 3 + R.relax, maxH: yP0 - 0.04 * u - hTop, ls: -0.015, lh: 1.02, color: 'black', on: 'white' });
    R.rule(0, yP1, rw, yF - yP1);
    R.field('lavender', rw, yP1, colW - rw, yF - yP1);
    if (c.status_label) R.text({ role: 'label', text: c.status_label, x: m, y: yP1 + m, size: lab, color: 'black', on: 'lavender' });
    const lTop = yP1 + m + lab * CAP + 0.04 * u;
    if (c.lead) R.text({ role: 'lead', text: c.lead, x: m, y: lTop, size: 0.042 * u, min: 0.022 * u, maxW: colW - 2 * m, maxLines: 4 + R.relax, maxH: yF - m - lTop, lh: 1.2, color: 'black', on: 'lavender' });
    R.footer(yF);
  },

  // Scene 03 / Invitation: big statement, CTA, pilot status, all on lavender.
  'scene-invite'(R) {
    const { W, u, m, frame } = R;
    const yF = R.yF, c = frame.content;
    R.field('lavender', 0, 0, W, yF);
    const lab = Math.round(0.0167 * u);
    if (c.label) R.text({ role: 'label', text: c.label, x: m, y: R.top, size: lab, color: 'black', on: 'lavender' });
    let statusTop = yF - m;
    if (c.status) {
      const sf = R.fit(c.status, { size: 0.03 * u, min: 0.018 * u, maxW: W * (R.landscape ? 0.45 : 0.6) + 0.1 * W * R.relax, maxLines: 2 + R.relax, lh: 1.25 });
      statusTop = yF - m - blockH(sf, 1.25) + DESC * sf.size;
      R.text({ role: 'status', text: c.status, x: m, y: statusTop, size: sf.size, lines: sf.lines, overflow: sf.overflow, lh: 1.25, color: 'black', on: 'lavender', maxLines: 2 + R.relax });
    }
    const ctaSize = Math.round((R.landscape ? 0.032 : 0.04) * u), arrowLen = Math.round(0.06 * u);
    const hTop = R.top + lab * CAP + 0.06 * u;
    const ctaBlock = c.cta ? 0.07 * u + ctaSize * (CAP + DESC) : 0;
    const hl = R.text({
      role: 'headline', text: c.headline, x: m, y: hTop, size: 0.22 * u, min: (0.05 - 0.005 * R.relax) * u, maxW: W - 2 * m, maxLines: 3 + R.relax,
      maxH: statusTop - 0.08 * u - ctaBlock - hTop, ls: -0.03, lh: 0.95, breaks: true, color: 'black', on: 'lavender',
    });
    if (c.cta) {
      const ctaTop = hl.bottom + 0.07 * u;
      R.text({ role: 'cta', text: c.cta, x: m, y: ctaTop, size: ctaSize, color: 'black', on: 'lavender' });
      R.arrow(W - m, ctaTop + ctaSize * CAP / 2, arrowLen);
    }
    R.footer(yF);
  },
};

export const LAYOUT_NAMES = Object.keys(LAYOUTS);

// Layouts a team would normally pick for each format (used by the Studio's suggestions).
export const LAYOUT_FOR_FORMAT = {
  feed: ['photo-hero', 'type-led', 'signal', 'signal-grid', 'scene-context', 'scene-story', 'scene-invite'],
  square: ['photo-hero', 'type-led', 'signal', 'scene-invite'],
  link: ['photo-hero', 'type-led', 'signal'],
  story: ['photo-hero', 'type-led', 'signal', 'scene-context', 'scene-story', 'scene-invite'],
  slide: ['photo-hero', 'signal-grid', 'type-led', 'signal'],
};

// Review helper: one flow graphic on its colourway field, no type (used for option sheets).
export function renderFlowSwatch(canvas, brand, style, colourway, seed = 7, w = 900, h = 900) {
  canvas.width = w; canvas.height = h;
  const f = { w, h, u: w, footer: 0 };
  const R = new Renderer(canvas.getContext('2d'), brand, f, { content: {} });
  R.field(brand.tokens.flow.colourways[colourway].field, 0, 0, w, h);
  R.flow({ x: 0.08 * w, y: 0.2 * h, w: 0.84 * w, h: 0.6 * h }, colourway, seed, style);
  return canvas.toDataURL('image/png');
}
