// Sonderline motion engine (v2): video posts on the same layouts and checks as the stills.
// Each frame is a pure function of time, as in the type showcases:
//   - footage clips (generated from the supplied stills) play inside the layouts' photo areas,
//     at their native 24 fps, so every output frame is a real footage frame
//   - Contour lines flow over the footage and breathe with each beat
//   - each line of type rises inside its own mask and then holds (guide p12: type steady)
//   - between scenes the outgoing type fades first, then the footage dissolves into the next
//     scene, landing on the downbeat; the footer and logo never move
//   - scene lengths are counted in beats of the music excerpt, which starts on a bar line
import { render } from './engine.js';
import { validateFrame, validateSpecCopy } from './validate.js';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const easeIO = x => 0.5 - 0.5 * Math.cos(Math.PI * clamp(x));
const easeOut = x => 1 - (1 - clamp(x)) ** 4;

export function timeline(vspec, tracks = {}) {
  const music = tracks[vspec.music] || null;
  const beat = music?.beat || 60 / (vspec.bpm || 120);
  let b = 0;
  const scenes = (vspec.scenes || []).map((s, index) => {
    const beats = s.beats || 8;
    const o = { ...s, index, beats, startBeat: b, start: b * beat, dur: beats * beat };
    b += beats;
    return o;
  });
  return { scenes, total: b * beat, beat, bpm: 60 / beat, music };
}

// Same words in the same place: stays on screen between continuous scenes (a weight change
// switches on the beat instead of re-animating).
const same = (a, b) => a.text === b.text && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && a.color === b.color;

// Draw one line of a text element straight from its geometry, so a rising line never carries
// pixels from the line above it.
function drawLine(ctx, g, i, dy) {
  const d = g.draw;
  ctx.font = `${g.weight} ${g.size}px "${d.family}"`;
  ctx.letterSpacing = `${(d.ls * g.size).toFixed(2)}px`;
  ctx.fillStyle = g.color;
  ctx.textAlign = d.align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(g.lines[i], d.x, g.baselines[i] + dy);
  ctx.textAlign = 'left';
}

export class MotionRenderer {
  // media.video(sceneIndex) returns the <video> element for that scene (or null for still scenes)
  constructor(brand, vspec, tracks = {}, media = {}) {
    this.brand = brand;
    this.spec = vspec;
    this.fmt = vspec.format || 'feed';
    this.fps = vspec.fps || 24;
    this.tl = timeline(vspec, tracks);
    this.media = media;
    this.scrims = {};
    this.held = {};
    this.A = document.createElement('canvas');
    this.LA = { bg: document.createElement('canvas'), fg: document.createElement('canvas') };
    this.LB = { bg: document.createElement('canvas'), fg: document.createElement('canvas') };
    const f = brand.formats[this.fmt];
    this.W = f.w; this.H = f.h;
  }

  // Footage time for a scene at tau seconds in. Continuous scenes carry on from the previous one.
  clipTime(sc, tau) {
    if (!sc.clip) return 0;
    let offset = 0;
    for (let k = sc.index; k > 0 && this.tl.scenes[k].continuous; k--) offset += this.tl.scenes[k - 1].dur;
    const t = (sc.clip.in || 0) + (offset + tau) * (sc.clip.speed || 1);
    return Math.min(t, (sc.clip.out ?? 8) - 0.05);
  }

  // Scene index whose <video> a scene should use (continuous scenes share their group's element).
  videoOwner(sc) {
    let k = sc.index;
    while (k > 0 && this.tl.scenes[k].continuous) k--;
    return k;
  }

  frameSpec(sc, tau, layers) {
    const v = this.spec, beat = this.tl.beat, b = tau / beat, T = sc.start + tau;
    const fr = {
      ...sc, frameIndex: sc.index, frameCount: this.tl.scenes.length, layers,
      content: { ...(v.content || {}), ...(sc.content || {}) },
      flowAnim: { progress: easeOut(b / 3), phase: T / this.tl.total, time: T, beat: T / beat },
    };
    if (sc.clip) {
      fr.photo = { video: `s${this.videoOwner(sc)}`, zoom: sc.clip.zoom || 1, focus: sc.clip.focus || [0.5, 0.5] };
      if (sc.overlay !== false) {
        fr.overlay = {
          time: T, beat: T / beat,
          contour: { color: sc.overlayColor || 'white', alpha: sc.overlayAlpha ?? 0.32, top: sc.overlayTop ?? 0.56, height: sc.overlayHeight ?? 0.36,
            reveal: easeOut(b / 2.5), punch: 1 },
        };
      }
    }
    if (this.scrims[sc.index] != null) fr.scrim = this.scrims[sc.index];
    return fr;
  }

  // Footage for scene sc at tau must be on screen before rendering.
  async seek(sc, tau) {
    if (!sc.clip) return;
    this.brand.footage ||= {};
    const el = this.media.frames ? null : this.media.video?.(this.videoOwner(sc));
    if (!el && !this.media.frames) return;
    if (el) this.brand.footage[`s${this.videoOwner(sc)}`] = el;
    const t = this.clipTime(sc, tau);
    // offline masters: draw the exact frame from an extracted image sequence (headless browsers
    // don't update a <video>'s drawable frame on seek, which froze the footage)
    if (this.media.frames) {
      this.brand.footage[`s${this.videoOwner(sc)}`] = await this.media.frames(sc.clip.name, t);
      return;
    }
    if (this.media.live) { if (Math.abs(el.currentTime - t) > 0.12) el.currentTime = t; if (el.paused) el.play().catch(() => {}); return; }
    if (Math.abs(el.currentTime - t) < 1 / (this.fps * 4) && el.readyState >= 2) return;
    await new Promise(res => { el.addEventListener('seeked', res, { once: true }); el.currentTime = t; });
  }

  // Solve the scrim once per photo scene (strong enough for the start, middle and end of the clip),
  // and keep each scene's held geometry for continuity between scenes.
  async prepare() {
    const c = document.createElement('canvas');
    for (const sc of this.tl.scenes) {
      if (sc.clip && ['photo-hero', 'full-bleed'].includes(sc.layout) && (sc.scrim ?? 'auto') === 'auto') {
        let a = 0;
        for (const p of [0, 0.25, 0.5, 0.75, 1]) {
          await this.seek(sc, sc.dur * p);
          const res = render(c, this.brand, { ...this.frameSpec(sc, sc.dur * p), scrim: 'auto' }, this.fmt);
          a = Math.max(a, res.geometry.find(g => g.kind === 'photo')?.scrim || 0);
        }
        this.scrims[sc.index] = Math.min(0.9, a + 0.05);
      }
    }
    for (const sc of this.tl.scenes) {
      await this.seek(sc, sc.dur * 0.6);
      this.held[sc.index] = render(c, this.brand, this.frameSpec(sc, sc.dur * 0.6), this.fmt).geometry;
    }
    return this;
  }

  sceneAt(T) {
    const s = this.tl.scenes;
    return s.find(x => T >= x.start && T < x.start + x.dur) || s[s.length - 1];
  }

  // Draw time T into `out`. Async because footage has to be seeked first (offline rendering).
  async frameAt(T, out) {
    const tl = this.tl, beat = tl.beat;
    T = clamp(T, 0, Math.max(0, tl.total - 1e-4));
    const sc = this.sceneAt(T);
    const tau = T - sc.start, b = tau / beat;
    const next = tl.scenes[sc.index + 1];
    const prev = tl.scenes[sc.index - 1];

    await this.seek(sc, tau);
    const res = render(this.A, this.brand, this.frameSpec(sc, tau, this.LA), this.fmt);
    out.width = this.W; out.height = this.H;
    const ctx = out.getContext('2d');
    ctx.globalAlpha = 1;
    ctx.drawImage(this.LA.bg, 0, 0);

    // Dissolve: in the last half beat of a scene the next scene fades up, fully in on the downbeat.
    const D = 0.5;
    let dissolve = 0;
    if (next && !next.continuous && b > sc.beats - D) {
      dissolve = easeIO((b - (sc.beats - D)) / D);
      await this.seek(next, 0);
      render(this.A, this.brand, this.frameSpec(next, 0, this.LB), this.fmt);
      ctx.globalAlpha = dissolve;
      ctx.drawImage(this.LB.bg, 0, 0);
      ctx.globalAlpha = 1;
    }

    // Type: each line rises in its own mask, staggered; unchanged lines in continuous scenes stay put.
    const footer = res.geometry.find(g => g.kind === 'field' && g.name === 'black' && Math.abs(g.y + g.h - this.H) < 1);
    const yF = footer ? footer.y : this.H;
    const items = res.geometry.filter(g => g.kind === 'text' || g.kind === 'arrow' || g.kind === 'logo');
    const body = items.filter(g => g.y < yF).sort((a, b2) => a.y - b2.y || a.x - b2.x);
    const foot = items.filter(g => g.y >= yF);
    const prevHeld = sc.continuous && prev ? this.held[prev.index] : null;
    const nextHeld = next && next.continuous ? this.held[next.index] : null;
    // Timing on the beat grid: lines start on half beats, each rise takes 1.5 beats, and type
    // leaves over a full beat that ends half a beat before the downbeat.
    const textIn = sc.textIn ?? 0.5;
    const short = sc.beats <= 4;
    const RISE = short ? 1 : 1.5, STAGGER = short ? 0.25 : 0.5, KMAX = 3;   // later items start with the fourth
    const outStart = sc.beats - 1.5, outEnd = sc.beats - 0.5;
    let k = 0;
    for (const g of body) {
      const stays = prevHeld?.some(h => h.kind === g.kind && same(h, g));
      const leaves = next && !(nextHeld?.some(h => h.kind === g.kind && same(h, g)));
      const fadeOut = leaves && next && !next.continuous ? 1 - easeIO((b - outStart) / (outEnd - outStart))
        : leaves ? 1 - easeIO((b - (sc.beats - 1)) / 0.5) : 1;
      if (g.kind === 'text') {
        g.lines.forEach((line, i) => {
          const p = stays ? 1 : easeIO((b - textIn - Math.min(k, KMAX) * STAGGER) / RISE);
          if (!stays) k++;
          const alpha = p * fadeOut;
          if (alpha <= 0.002) return;
          const lb = g.lineBoxes[i], pad = lb.h * 0.3;
          ctx.save();
          // mask = the line's own box (cap height to descender), so a rising line never overlaps its neighbours
          ctx.beginPath(); ctx.rect(lb.x - pad, lb.y - lb.h * 0.12, lb.w + 2 * pad, lb.h * 1.12); ctx.clip();
          ctx.globalAlpha = alpha;
          drawLine(ctx, g, i, (1 - p) * lb.h * 0.8);
          ctx.restore();
        });
      } else {
        // arrows and logos: a short fade from their own region of the type layer
        const p = stays ? 1 : easeIO((b - textIn - Math.min(k, KMAX) * STAGGER) / RISE);
        const alpha = p * fadeOut;
        if (alpha <= 0.002) continue;
        ctx.save(); ctx.beginPath(); ctx.rect(g.x - 6, g.y - 6, g.w + 12, g.h + 12); ctx.clip();
        ctx.globalAlpha = alpha; ctx.drawImage(this.LA.fg, 0, 0); ctx.restore();
      }
    }
    const footAlpha = sc.index === 0 ? easeOut(b / 1.5) : 1;
    for (const g of foot) {
      ctx.save(); ctx.globalAlpha = footAlpha;
      if (g.kind === 'text') g.lines.forEach((_, i) => drawLine(ctx, g, i, 0));
      else { ctx.beginPath(); ctx.rect(g.x - 4, g.y - 4, g.w + 8, g.h + 8); ctx.clip(); ctx.drawImage(this.LA.fg, 0, 0); }
      ctx.restore();
    }
    return { scene: sc, res, dissolve };
  }

  // Each scene is checked like a still at three points: start, middle and end of its footage.
  async check() {
    const c = document.createElement('canvas');
    const order = ['pass', 'review', 'fail'];
    const scenes = [];
    for (const sc of this.tl.scenes) {
      const runs = [];
      for (const p of [0.15, 0.55, 0.95]) {
        await this.seek(sc, sc.dur * p);
        const fs = this.frameSpec(sc, sc.dur * p);
        const res = render(c, this.brand, { ...fs, flowAnim: { ...fs.flowAnim, progress: 1 } }, this.fmt);
        runs.push(validateFrame(res, c, this.brand));
      }
      const checks = runs[1].checks.map(ch => runs.map(r => r.checks.find(x => x.id === ch.id)).filter(Boolean)
        .sort((a, b) => order.indexOf(b.status) - order.indexOf(a.status))[0]);
      const status = checks.reduce((s, ch) => (order.indexOf(ch.status) > order.indexOf(s) ? ch.status : s), 'pass');
      scenes.push({ index: sc.index, layout: sc.layout, status, checks });
    }
    return { scenes, copy: validateSpecCopy({ ...this.spec, formats: [this.fmt] }, this.brand) };
  }

  async heldFrame(sc, canvas) {
    await this.seek(sc, sc.dur * 0.7);
    const fs = this.frameSpec(sc, sc.dur * 0.7);
    return render(canvas, this.brand, { ...fs, flowAnim: { ...fs.flowAnim, progress: 1 } }, this.fmt);
  }
}
