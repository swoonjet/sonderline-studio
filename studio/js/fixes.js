// One-click fixes for failed or flagged checks. Every fix only changes the spec (a choice);
// the engine and validator then re-run, so a fix can never bypass the rules.
import { frames, render, LAYOUT_FOR_FORMAT } from './engine.js';
import { validateFrame, checkCopy, approvedSet } from './validate.js';

const STOP = new Set('a an the of to for and or in on at by with your our is it its this that every one across'.split(' '));
const words = s => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)));
const similarity = (a, b) => {
  const A = words(a), B = words(b);
  const inter = [...A].filter(w => B.has(w)).length;
  return inter / (new Set([...A, ...B]).size || 1);
};

// Approved lines that suit a content slot.
export function candidates(brand, slot) {
  const L = brand.copy.lines, p = brand.copy.product;
  const by = (...roles) => L.filter(l => roles.includes(l.role)).map(l => l.text);
  const pick = {
    headline: by('headline'),
    signal: p.signals,
    lead: [...by('lead', 'body'), p.description, p.audience],
    status: by('status'),
    cta: [p.cta],
    label: brand.copy.labels, status_label: brand.copy.labels, footer_label: brand.copy.labels,
  }[slot] || [];
  return [...new Set(pick)];
}

// Which content slot a rendered text element came from.
function slotOf(o, g) {
  if (g.role === 'headline' && o.layout === 'signal') return 'signal';
  return ['headline', 'label', 'lead', 'cta', 'status', 'status_label', 'footer_label'].includes(g.role) ? g.role : null;
}

export function makeFixer({ brand, getSpec, targetFor, commit, setBusy }) {
  const approved = approvedSet(brand.copy);

  const setText = (o, slot, value) => () => {
    const t = targetFor(o.frameIndex);
    if (slot === 'footer_label') { getSpec().content ||= {}; getSpec().content.footer_label = value; }
    else { t.content ||= {}; t.content[slot] = value; }
    commit(true);
  };

  // Search crops for this format; keep the one that passes contrast with the least scrim.
  async function findCrop(o) {
    const spec = getSpec(), t = targetFor(o.frameIndex);
    const base = t.photo ?? spec.photo;
    if (!base) return 'No photo to re-crop.';
    setBusy(`Searching crops for ${o.fmt}…`);
    let best = null;
    const fr0 = frames(spec)[o.frameIndex];
    for (const zoom of [1, 1.3, 1.6, 2]) for (const fx of [0.05, 0.25, 0.5, 0.75, 0.95]) for (const fy of [0.1, 0.5, 0.9]) {
      const fr = { ...fr0, photo: { ...base, focus: [fx, fy], zoom }, photoOverrides: undefined, scrim: 'auto' };
      const c = document.createElement('canvas');
      const res = render(c, brand, fr, o.fmt);
      const rep = validateFrame(res, c, brand);
      const ph = res.geometry.find(g => g.kind === 'photo');
      if (rep.checks.find(x => x.id === 'contrast')?.status !== 'pass' || (ph && ph.upscale > 1.6)) continue;
      const score = (ph?.scrim ?? 0) + (zoom - 1) * 0.05;
      if (!best || score < best.score) best = { score, focus: [fx, fy], zoom, scrim: ph?.scrim ?? 0 };
      await new Promise(r => setTimeout(r));
    }
    setBusy('');
    if (!best) return 'No crop of this photo passes. Try the other photo or another layout.';
    t.photoOverrides ||= {};
    t.photoOverrides[o.fmt] = { focus: best.focus, zoom: best.zoom };
    if (t.scrim === 'off') t.scrim = 'auto';
    commit(true);
    return `Re-cropped ${o.fmt}: scrim ${Math.round(best.scrim * 100)}%. A designer should confirm the crop.`;
  }

  function layoutSwaps(o) {
    const t = targetFor(o.frameIndex);
    return (LAYOUT_FOR_FORMAT[o.fmt] || []).filter(l => l !== o.layout && !l.startsWith('scene')).slice(0, 3)
      .map(l => ({ label: `Try layout: ${l}`, run: () => { t.layout = l; commit(true); } }));
  }

  // Fixes for one check on one rendered output.
  function forCheck(check, o) {
    const fixes = [];
    const t = targetFor(o.frameIndex);
    const texts = (check.boxes || []).filter(b => b.kind === 'text');
    if (check.id === 'contrast') {
      const onPhoto = texts.some(b => b.on === 'photo');
      if (onPhoto) {
        fixes.push({ label: `Find a cleaner crop for ${o.fmt}`, run: () => findCrop(o) });
        if ((t.scrim ?? getSpec().scrim) === 'off') fixes.push({ label: 'Turn the auto scrim on', run: () => { t.scrim = 'auto'; commit(true); } });
        const other = Object.keys(brand.tokens.photography).find(id => id !== (t.photo ?? getSpec().photo)?.id);
        if (other) fixes.push({ label: `Use the ${other} photo`, run: () => { t.photo = { id: other, focus: [0.3, 0.5], zoom: 1 }; delete t.photoOverrides; commit(true); } });
      } else fixes.push(...layoutSwaps(o));
    }
    if (check.id === 'copy') {
      for (const b of texts) {
        const slot = slotOf(o, b);
        if (!slot) continue;
        const best = candidates(brand, slot).map(c => ({ c, s: similarity(b.text, c) })).sort((x, y) => y.s - x.s).slice(0, 3);
        for (const { c } of best) fixes.push({ label: `"${c}"`, hint: `Replace ${slot} with`, run: setText(o, slot, c) });
      }
    }
    if (check.id === 'fit' || check.id === 'size') {
      const over = texts.filter(b => b.overflow || check.detail.includes(`"${b.text}"`));
      for (const b of over.length ? over : texts) {
        const slot = slotOf(o, b);
        if (!slot) continue;
        const shorter = candidates(brand, slot).filter(c => c.length < b.text.length)
          .sort((x, y) => similarity(b.text, y) - similarity(b.text, x) || y.length - x.length).slice(0, 2);
        for (const c of shorter) fixes.push({ label: `"${c}"`, hint: `Shorter approved ${slot}`, run: setText(o, slot, c) });
      }
      fixes.push(...layoutSwaps(o));
    }
    if (['safezone', 'logo', 'footer'].includes(check.id)) fixes.push(...layoutSwaps(o));
    if (check.id === 'photo') {
      fixes.push({ label: 'Reduce the zoom', run: () => {
        t.photoOverrides ||= {};
        const cur = { ...(t.photo ?? getSpec().photo), ...(t.photoOverrides[o.fmt] || {}) };
        t.photoOverrides[o.fmt] = { ...t.photoOverrides[o.fmt], zoom: Math.max(1, (cur.zoom || 1) - 0.4) };
        commit(true);
      } });
    }
    if (check.id === 'vermilion' || check.id === 'assumed') {
      if (t.flow ?? getSpec().flow) fixes.push({ label: 'Remove the flow graphic', run: () => { t.flow = false; commit(true); } });
    }
    return fixes;
  }

  // Caption and alt text fixes (spec level).
  function forCopy(check) {
    const spec = getSpec();
    if (check.id === 'caption' && check.status !== 'pass') {
      return [{ label: 'Rebuild the caption from approved sentences', run: () => { spec.caption = composeCaption(); commit(true); } }];
    }
    if (check.id === 'alt' && check.status !== 'pass') {
      return [{ label: 'Write alt text from the artwork', run: () => { spec.alt = composeAlt(); commit(true); } }];
    }
    return [];
  }

  function composeCaption() {
    const spec = getSpec(), p = brand.copy.product;
    const heads = frames(spec).map(f => f.content?.headline).filter(h => h && checkCopy(h, brand.copy, approved).status === 'pass');
    return [heads[0], p.description, p.audience, p.status, p.cta].filter(Boolean).join(' ');
  }

  function composeAlt() {
    const spec = getSpec();
    const photos = {
      'motion-study': 'Black-and-white photograph of a person in a dark coat moving through a glass concourse, blurred with motion.',
      'material-study': 'Close-up of ribbed brushed metal with a dark curved shadow.',
    };
    const fr = frames(spec);
    const ph = fr.map(f => f.photo?.id).find(Boolean);
    const lines = [...new Set(fr.flatMap(f => ['headline', 'signal', 'lead', 'cta', 'status'].map(k => f.content?.[k]).filter(Boolean)))];
    const alt = [fr.length > 1 ? `${fr.length}-frame sequence.` : '', ph ? photos[ph] : '', lines.join(' '), 'Sonderline logo.'].filter(Boolean).join(' ');
    return alt.length > 400 ? `${alt.slice(0, 396).replace(/\s+\S*$/, '')}…` : alt;
  }

  return { forCheck, forCopy };
}
