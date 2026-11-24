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
  const ctx = canvas.getContext('2d');
  const R = new Renderer(ctx, brand, f, frame);
  const layout = LAYOUTS[frame.layout];
  if (!layout) throw new Error(`Unknown layout "${frame.layout}"`);
  layout(R);
  return R.finish();
}

class Renderer {
  constructor(ctx, brand, f, frame) {
    Object.assign(this, { ctx, brand, f, frame });
    this.W = f.w; this.H = f.h; this.u = f.u;
    this.m = Math.round(0.04 * f.u);
    this.c = Object.fromEntries(Object.entries(brand.tokens.colour).map(([k, v]) => [k, v.hex]));
    this.geometry = [];
    this.fg = [];           // foreground ops (text, logos), drawn after the background snapshot
    this.notes = [];        // decisions the engine made, shown to the reviewer
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

  // Stand-in flow graphic (ASSUMED; see tokens.flow). Rows of bars with the S symbol's slanted
  // ends, one vermilion "signal" bar. Deterministic per seed so re-renders match.
  flow(r, colourway, seed = 1) {
    const cw = this.brand.tokens.flow.colourways[colourway];
    const ctx = this.ctx;
    let s = seed >>> 0;
    const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const rows = Math.max(3, Math.round(r.h / (0.05 * this.u)));
    const t = r.h / (rows * 1.9);
    const slant = t / Math.tan(this.brand.tokens.flow.slant_deg * Math.PI / 180);
    const signalRow = Math.floor(rnd() * rows);
    const bar = (x, y, w, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x + slant, y); ctx.lineTo(x + w, y);
      ctx.lineTo(x + w - slant, y + t); ctx.lineTo(x, y + t);
      ctx.closePath(); ctx.fill();
    };
    for (let i = 0; i < rows; i++) {
      const y = r.y + i * t * 1.9;
      let x = r.x + rnd() * r.w * 0.25;
      const n = 1 + Math.floor(rnd() * 3);
      for (let j = 0; j < n && x < r.x + r.w - 4 * t; j++) {
        const w = Math.min(r.x + r.w - x, (0.12 + rnd() * 0.35) * r.w);
        const isSignal = i === signalRow && j === 0;
        bar(x, y, isSignal ? Math.min(w, 0.14 * r.w) : w, isSignal ? this.brand.tokens.flow.signal_bar : cw.bars);
        x += w + (0.04 + rnd() * 0.08) * r.w;
      }
    }
    this.geometry.push({ kind: 'graphic', name: 'flow', colourway, status: 'assumed', ...r });
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
    const fit = t.lines ? { size: t.size, lines: t.lines, overflow: false } : this.fit(t.text, {
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
  footer(y0) {
    const { W, H, u, m, f } = this;
    this.field('black', 0, y0, W, H - y0);
    const ch = f.footerContent || (H - y0);
    const Lh = Math.min(0.104 * u, ch * 0.92);
    const visRight = W - m;
    this.logo('lockup_white', visRight - (Lh * this.brand.tokens.logo.aspect.lockup - Lh / 4), y0 + ch / 2 - Lh / 2, Lh);
    const lab = this.frame.content.footer_label;
    if (lab) {
      const size = Math.round(0.0167 * u);
      this.text({ role: 'footer_label', text: lab, x: m, y: y0 + ch / 2 - size * CAP / 2, size, color: 'white', on: 'black' });
    }
  }

  finish() {
    this.bg = this.ctx.getImageData(0, 0, this.W, this.H);
    for (const op of this.fg) op();
    return { geometry: this.geometry, bg: this.bg, W: this.W, H: this.H, format: this.f, notes: this.notes, frame: this.frame };
  }
}

// ---------- shared pieces ----------
function bands(R) {
  const { H, f } = R;
  const yI = Math.round(H * f.photo), yF = Math.round(H * (f.photo + f.info));
  return { yI, yF };
}

// Info row: white panel (left 2/3) with label, lead and CTA; vermilion rule; accent panel
// (right 1/3) with status label + status. Measured from the guide's social example.
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
  const ctaTop = yI + hI - pad - ctaSize * CAP;
  const lw = split - 2 * m;

  // Stacked when there's room; otherwise lead and CTA share a row (wide formats).
  let lead = null;
  if (c.lead) {
    const room = ctaTop - 0.02 * u - leadTop;
    const stacked = R.fit(c.lead, { size: 0.046 * u, min: 0.03 * u, maxW: lw, maxLines: 2, ls: -0.005 });
    const stackedH = stacked.size * CAP + (stacked.lines.length - 1) * stacked.size * 1.1 + DESC * stacked.size;
    if (!c.cta || stackedH <= room) {
      lead = R.text({ role: 'lead', text: c.lead, x: m, y: leadTop, size: stacked.size, lines: stacked.lines, ls: -0.005, lh: 1.1, color: 'black', on: 'white', maxLines: 2 });
      if (c.cta) {
        R.text({ role: 'cta', text: c.cta, x: m, y: ctaTop, size: ctaSize, color: 'black', on: 'white' });
        R.arrow(split - m, ctaTop + ctaSize * CAP * 0.5, arrowLen);
      }
    } else {
      const ctaW = (() => { R.font(ctaSize, 400); return R.ctx.measureText(c.cta).width; })();
      const leadW = lw - ctaW - arrowLen - 0.06 * u;
      lead = R.text({ role: 'lead', text: c.lead, x: m, y: leadTop, size: 0.046 * u, min: 0.026 * u, maxW: leadW, maxLines: 2, maxH: yI + hI - pad - leadTop, ls: -0.005, lh: 1.1, color: 'black', on: 'white' });
      const ctaY = lead.baseline - ctaSize * CAP;
      R.text({ role: 'cta', text: c.cta, x: split - m - arrowLen - 0.025 * u, y: ctaY, size: ctaSize, color: 'black', on: 'white', align: 'right' });
      R.arrow(split - m, ctaY + ctaSize * CAP * 0.5, arrowLen);
    }
  }

  const rx = split + rw + Math.round(0.6 * m);
  if (c.status_label) R.text({ role: 'status_label', text: c.status_label, x: rx, y: yI + pad, size: lab, color: 'black', on: accent });
  if (c.status) R.text({
    role: 'status', text: c.status, x: rx, y: leadTop, size: 0.029 * u, min: 0.02 * u,
    maxW: W - rx - 0.8 * m, maxLines: 3, lh: 1.25, color: 'black', on: accent,
  });
}

// ---------- layout families ----------
const LAYOUTS = {
  // Guide p09: one message over photography, info row, clear footer.
  'photo-hero'(R) {
    const { W, H, u, m, frame } = R;
    const { yI, yF } = bands(R);
    const photoRect = { x: 0, y: 0, w: W, h: yI };
    const hasPhoto = !!frame.photo;
    // measure the headline first so the scrim can be solved against its real box
    const h = R.fit(frame.content.headline, {
      size: (frame.headlineScale ?? R.f.headlineScale ?? 0.125) * u, min: 0.06 * u, maxW: R.f.headlineW * W,
      maxLines: R.f.headlineLines, ls: -0.015, breaks: true,
    });
    const top = Math.max(Math.round(1.1 * m), R.f.safeTop ? R.f.safeTop + 0.12 * h.size : 0);
    const box = { x: m, y: top - 0.08 * h.size, w: h.width, h: h.size * CAP + (h.lines.length - 1) * h.size * 0.98 + (DESC + 0.08) * h.size };
    if (hasPhoto) {
      const g = R.photo(frame.photo, photoRect);
      R.geometry.pop();
      const redraw = () => { R.ctx.fillStyle = '#000'; R.ctx.fillRect(0, 0, W, yI); R.photo(frame.photo, photoRect); R.geometry.pop(); };
      R.geometry.push(g);
      R.scrim(g, frame.scrim ?? 'auto', box, redraw);
    } else {
      R.field('black', 0, 0, W, yI);
      if (frame.flow) R.flow({ x: m, y: box.y + box.h + 0.08 * u, w: W - 2 * m, h: Math.max(0, yI - (box.y + box.h) - 0.16 * u) }, 'black', frame.flowSeed || 3);
    }
    R.text({
      role: 'headline', text: frame.content.headline, x: m, y: top, size: h.size, lines: h.lines,
      ls: -0.015, lh: 0.98, color: 'white', on: hasPhoto ? 'photo' : 'black', maxLines: R.f.headlineLines,
    });
    R.geometry.at(-1).overflow = h.overflow;
    infoRow(R, yI, yF - yI);
    R.footer(yF);
  },

  // Guide p11: type-led lavender field with a vermilion tick. Used for carousel covers.
  'type-led'(R) {
    const { W, H, u, m, frame } = R;
    const { yF } = bands(R);
    const c = frame.content;
    const fieldKey = frame.field || 'lavender';
    R.field(fieldKey, 0, 0, W, yF);
    const rw = Math.max(4, Math.round(0.0146 * u));
    R.rule(0, 0, Math.round(0.17 * W), rw);
    const lab = Math.round(0.0167 * u);
    const top = Math.max(Math.round(1.1 * m) + rw, R.f.safeTop || 0);
    if (c.label) R.text({ role: 'label', text: c.label, x: m, y: top, size: lab, color: 'black', on: fieldKey });
    const hl = R.text({
      role: 'headline', text: c.headline, x: m, y: top + lab * CAP + 0.05 * u, size: 0.2 * u, min: 0.08 * u,
      maxW: W - 2 * m, maxLines: 3, ls: -0.025, lh: 0.95, breaks: true, color: 'black', on: fieldKey,
    });
    const ctaSize = Math.round(0.027 * u), arrowLen = Math.round(0.045 * u);
    const ctaTop = yF - m - ctaSize * CAP;
    let leadTop = ctaTop;
    if (c.lead) {
      const lf = R.fit(c.lead, { size: 0.046 * u, min: 0.03 * u, maxW: W * 0.7, maxLines: 3, ls: -0.005 });
      const lh = lf.size * CAP + (lf.lines.length - 1) * lf.size * 1.1;
      leadTop = ctaTop - 0.09 * u - lh;
      R.text({ role: 'lead', text: c.lead, x: m, y: leadTop, size: lf.size, lines: lf.lines, lh: 1.1, ls: -0.005, color: 'black', on: fieldKey, maxLines: 3 });
    }
    if (c.cta) {
      R.text({ role: 'cta', text: c.cta, x: m, y: ctaTop, size: ctaSize, color: 'black', on: fieldKey });
      R.arrow(W - m, ctaTop + ctaSize * CAP * 0.5, arrowLen);
    }
    const fy = hl.bottom + 0.07 * u, fh = leadTop - 0.08 * u - fy;
    if (frame.flow && fh > 0.08 * u) R.flow({ x: m, y: fy, w: W - 2 * m, h: fh }, fieldKey === 'black' ? 'black' : fieldKey, frame.flowSeed || 7);
    R.footer(yF);
  },

  // Carousel frame: photo window on top (pans across frames), one signal per frame,
  // the full list below with the current item in bold + a vermilion marker (not colour alone).
  'signal'(R) {
    const { W, H, u, m, frame } = R;
    const { yF } = bands(R);
    const c = frame.content;
    const yP = Math.round(H * (frame.photoBand ?? 0.4));
    if (frame.photo) R.photo(frame.photo, { x: 0, y: 0, w: W, h: yP });
    const fieldKey = frame.field || 'white';
    R.field(fieldKey, 0, yP, W, yF - yP);
    const lab = Math.round(0.0167 * u);
    if (c.label) R.text({ role: 'label', text: c.label, x: m, y: yP + m, size: lab, color: 'black', on: fieldKey });
    if (frame.index) R.text({ role: 'index', text: frame.index, system: true, x: W - m, y: yP + m, size: lab, color: 'black', on: fieldKey, align: 'right' });
    R.text({
      role: 'headline', text: c.signal, x: m, y: yP + m + lab * CAP + 0.06 * u, size: 0.14 * u, min: 0.08 * u,
      maxW: W * 0.62, maxLines: 2, ls: -0.02, lh: 0.98, color: 'black', on: fieldKey,
    });
    const items = R.brand.copy.product.signals;
    const size = Math.round(0.029 * u), step = Math.round(size * 1.5), mk = Math.round(0.016 * u);
    const y0 = yF - m - size * CAP - (items.length - 1) * step;
    items.forEach((it, i) => {
      const cur = it === c.signal;
      if (cur) R.rule(m, y0 + i * step + (size * CAP - mk) / 2, mk, mk);
      R.text({ role: 'list', text: it, x: m + mk + 0.02 * u, y: y0 + i * step, size, weight: cur ? 700 : 400, color: 'black', on: fieldKey });
    });
    R.footer(yF);
  },
};

export const LAYOUT_NAMES = Object.keys(LAYOUTS);
