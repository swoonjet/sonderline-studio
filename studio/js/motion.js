// Sonderline motion engine: video social posts built on the same layouts and checks as the stills.
// A video spec is a list of scenes measured in beats, so cuts land on the music. Each frame is a
// normal engine render; motion is added on top:
//   - photography pans between two focus points (Ken Burns), type never moves (guide p12)
//   - each text block wipes on in reading order, then holds
//   - Contour lines draw on and their step travels
//   - scenes change through a Contour sheet that sweeps across; the footer and logo stay put
import { render, renderFlowSheet } from './engine.js';
import { validateFrame, validateSpecCopy } from './validate.js';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = t => 1 - (1 - t) ** 3;

export function timeline(vspec, tracks = {}) {
  const bpm = tracks[vspec.music]?.bpm || vspec.bpm || 120;
  const beat = 60 / bpm;
  let t = 0;
  const scenes = (vspec.scenes || []).map((s, index) => {
    const dur = (s.beats || 8) * beat;
    const o = { ...s, index, start: t, dur };
    t += dur;
    return o;
  });
  return { scenes, total: t, bpm, beat };
}

export class MotionRenderer {
  constructor(brand, vspec, tracks = {}) {
    this.brand = brand;
    this.spec = vspec;
    this.fmt = vspec.format || 'feed';
    this.tl = timeline(vspec, tracks);
    this.A = document.createElement('canvas');      // full frame, everything drawn
    this.scrims = {};
    const f = brand.formats[this.fmt];
    this.W = f.w; this.H = f.h;
  }

  // The frame spec for scene `sc` at progress p (0..1).
  sceneFrame(sc, p) {
    const v = this.spec;
    let photo = sc.photo ? { ...sc.photo } : null;
    if (photo && sc.pan) {
      const e = easeInOut(p);
      photo.focus = [sc.pan[0][0] + (sc.pan[1][0] - sc.pan[0][0]) * e, sc.pan[0][1] + (sc.pan[1][1] - sc.pan[0][1]) * e];
    }
    const fr = {
      ...sc, photo, frameIndex: sc.index, frameCount: this.tl.scenes.length,
      content: { ...(v.content || {}), ...(sc.content || {}) },
      flowAnim: { progress: easeOut(clamp((p * sc.dur) / (2.5 * this.tl.beat))), phase: p },
    };
    if (this.scrims[sc.index] != null) fr.scrim = this.scrims[sc.index];
    return fr;
  }

  // Solve one scrim per photo scene, strong enough for the whole pan (start, middle and end),
  // so the scrim doesn't pump while the photo moves.
  prepare() {
    const c = document.createElement('canvas');
    for (const sc of this.tl.scenes) {
      if (!sc.photo || sc.layout !== 'photo-hero' || (sc.scrim ?? 'auto') !== 'auto') continue;
      let a = 0;
      for (const p of [0, 0.5, 1]) {
        const res = render(c, this.brand, { ...this.sceneFrame(sc, p), scrim: 'auto' }, this.fmt);
        a = Math.max(a, res.geometry.find(g => g.kind === 'photo')?.scrim || 0);
      }
      this.scrims[sc.index] = Math.min(0.9, a + 0.05);
    }
    this.sheet = renderFlowSheet(document.createElement('canvas'), this.brand, this.W, this.H, 'lavender', 'contour', 5);
    return this;
  }

  sceneAt(T) {
    const s = this.tl.scenes;
    return s.find(x => T >= x.start && T < x.start + x.dur) || s[s.length - 1];
  }

  // Draw the frame at time T (seconds) into `out`.
  frameAt(T, out) {
    const tl = this.tl;
    T = clamp(T, 0, Math.max(0, tl.total - 1e-4));
    const sc = this.sceneAt(T);
    const tau = T - sc.start, p = sc.dur ? tau / sc.dur : 0;
    const res = render(this.A, this.brand, this.sceneFrame(sc, p), this.fmt);
    out.width = this.W; out.height = this.H;
    const ctx = out.getContext('2d');
    ctx.putImageData(res.bg, 0, 0);

    const footer = res.geometry.find(g => g.kind === 'field' && g.name === 'black' && Math.abs(g.y + g.h - this.H) < 1);
    const yF = footer ? footer.y : this.H;
    const els = res.geometry.filter(g => g.kind === 'text' || g.kind === 'arrow' || g.kind === 'logo');
    const body = els.filter(g => g.y < yF).sort((a, b) => a.y - b.y || a.x - b.x);
    const foot = els.filter(g => g.y >= yF);
    const reveal = (g, q) => {
      if (q <= 0) return;
      const pad = 0.2 * (g.size || 24);
      ctx.save();
      ctx.beginPath();
      ctx.rect(g.x - pad, g.y - pad, (g.w + 2 * pad) * Math.min(1, q), g.h + 2 * pad);
      ctx.clip();
      ctx.drawImage(this.A, 0, 0);
      ctx.restore();
    };
    body.forEach((g, i) => reveal(g, easeOut(clamp((tau - 0.12 - i * 0.09) / 0.5))));
    foot.forEach(g => reveal(g, sc.index === 0 ? easeOut(clamp((tau - 0.05) / 0.5)) : 1));

    // Contour wipe between scenes: sweeps in over the last moment of a scene, out over the first
    // moment of the next. Above the footer only, so the brand anchor never moves.
    const tr = Math.min(0.42, tl.beat * 0.85);
    const wipe = (x0, x1) => {
      if (x1 - x0 < 1) return;
      ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, yF); ctx.clip();
      ctx.drawImage(this.sheet, 0, 0);
      ctx.restore();
    };
    if (sc.index < tl.scenes.length - 1 && tau > sc.dur - tr) wipe(0, this.W * easeInOut((tau - (sc.dur - tr)) / tr));
    if (sc.index > 0 && tau < tr) wipe(this.W * easeInOut(tau / tr), this.W);
    return { scene: sc, res };
  }

  // Every scene is checked like a still at three points of its move: start, middle, end.
  check() {
    const c = document.createElement('canvas');
    const scenes = this.tl.scenes.map(sc => {
      const runs = [0.05, 0.5, 0.95].map(p => {
        const res = render(c, this.brand, this.sceneFrame(sc, p), this.fmt);
        return validateFrame(res, c, this.brand);
      });
      const order = ['pass', 'review', 'fail'];
      const checks = runs[1].checks.map(ch => {
        const worst = runs.map(r => r.checks.find(x => x.id === ch.id)).filter(Boolean)
          .sort((a, b) => order.indexOf(b.status) - order.indexOf(a.status))[0];
        return worst;
      });
      const status = checks.reduce((s, ch) => (order.indexOf(ch.status) > order.indexOf(s) ? ch.status : s), 'pass');
      return { index: sc.index, layout: sc.layout, status, checks };
    });
    const copy = validateSpecCopy({ ...this.spec, formats: [this.fmt] }, this.brand);
    return { scenes, copy };
  }

  heldFrame(sc, canvas) {
    return render(canvas, this.brand, this.sceneFrame(sc, 0.5), this.fmt);
  }
}
