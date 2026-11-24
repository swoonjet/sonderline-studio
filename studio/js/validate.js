// Sonderline Social System: brand validator.
// Every automatable rule from Brand Guide 8.0, checked against the rendered geometry and the
// real pixels. Three outcomes: pass, review (a named person must decide), fail (blocked).

import { sampleLuminance, worstContrast, hexToRgb } from './color.js';

const norm = s => s.replace(/\s+/g, ' ').trim();

export function approvedSet(copy) {
  const p = copy.product;
  return new Set([
    ...copy.lines.map(l => l.text), ...copy.labels, ...copy.voice,
    p.name, p.description, p.audience, p.status, p.cta, ...p.capabilities, ...p.signals,
  ].map(norm));
}

// Copy rule (guide p13): approved lines pass; forbidden patterns fail; anything else is new
// copy and goes to Product marketing for review.
export function checkCopy(text, copy, approved = approvedSet(copy)) {
  const t = norm(text);
  for (const f of copy.forbidden_patterns) {
    const flags = f.pattern.startsWith('(?i)') ? 'i' : '';
    if (new RegExp(f.pattern.replace('(?i)', ''), flags).test(t)) return { status: 'fail', reason: f.reason };
  }
  const hit = approved.has(t) || approved.has(t.replace(/\.$/, '')) || approved.has(`${t}.`);
  return hit ? { status: 'pass' } : { status: 'review', reason: 'new copy, not in the approved library' };
}

export function sentences(text) {
  return norm(text).split(/(?<=[.!?])\s+/).filter(Boolean);
}

// Sentences, re-joined where consecutive sentences form one approved line ("Every site. One view.").
export function copyUnits(text, approved) {
  const s = sentences(text), out = [];
  for (let i = 0; i < s.length;) {
    let j = s.length;
    while (j > i + 1 && !approved.has(s.slice(i, j).join(' '))) j--;
    out.push(s.slice(i, j).join(' '));
    i = j;
  }
  return out;
}

const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a, W, H) => a.x >= -0.5 && a.y >= -0.5 && a.x + a.w <= W + 0.5 && a.y + a.h <= H + 0.5;

export function validateFrame(result, canvas, brand) {
  const { geometry: G, bg, W, H, format: f } = result;
  const T = brand.tokens, u = f.u;
  const nameOf = Object.fromEntries(Object.entries(T.colour).map(([k, v]) => [v.hex.toUpperCase(), k]));
  const texts = G.filter(g => g.kind === 'text');
  const approved = approvedSet(brand.copy);
  const checks = [];
  const add = (id, title, page, status, detail, boxes = [], gate) => checks.push({ id, title, page, status, detail, boxes, gate });

  // 1. On-image copy
  {
    const bad = [], rev = [];
    for (const t of texts.filter(t => !t.system)) {
      const r = checkCopy(t.text, brand.copy, approved);
      if (r.status === 'fail') bad.push({ t, r }); else if (r.status === 'review') rev.push({ t, r });
    }
    if (bad.length) add('copy', 'On-image copy is approved', 13, 'fail', bad.map(b => `"${b.t.text}": ${b.r.reason}`).join(' · '), bad.map(b => b.t));
    else if (rev.length) add('copy', 'On-image copy is approved', 13, 'review', rev.map(b => `"${b.t.text}": ${b.r.reason}`).join(' · '), rev.map(b => b.t), 'Product marketing');
    else add('copy', 'On-image copy is approved', 13, 'pass', `${texts.length} text elements, all from the approved library.`);
  }

  // 2. Contrast, measured on the pixels under each text box
  {
    const res = texts.map(t => ({ t, c: worstContrast(sampleLuminance(bg, t, 2), t.color) }));
    const low = res.filter(r => r.c < T.min_contrast);
    const min = Math.min(...res.map(r => r.c));
    if (low.length) add('contrast', 'Text contrast ≥ 4.5:1 (measured)', 6, 'fail', low.map(r => `"${r.t.text}" ${r.c.toFixed(2)}:1`).join(' · '), low.map(r => r.t));
    else add('contrast', 'Text contrast ≥ 4.5:1 (measured)', 6, 'pass', `Lowest ${min.toFixed(2)}:1 across ${res.length} elements.`);
  }

  // 3. Approved colour pairings (no white type on accents, no accent-on-accent)
  {
    const bad = texts.filter(t => {
      if (t.on === 'photo') return nameOf[t.color.toUpperCase()] !== 'white';
      const pair = `${nameOf[t.color.toUpperCase()]}-on-${t.on}`;
      return !(pair in T.text_pairings);
    });
    if (bad.length) add('pairing', 'Approved text/background pairings', 6, 'fail', bad.map(t => `"${t.text}" ${nameOf[t.color.toUpperCase()]} on ${t.on}`).join(' · '), bad);
    else add('pairing', 'Approved text/background pairings', 6, 'pass', 'Black on light and accent fields, white on black and over photography only.');
  }

  // 4. Palette: every flat field is a brand colour
  {
    const off = G.filter(g => g.kind === 'field' && !nameOf[g.color.toUpperCase()]);
    add('palette', 'Fields use the five brand colours', 3, off.length ? 'fail' : 'pass',
      off.length ? off.map(g => g.color).join(', ') : 'Black, white, lavender, cool grey, vermilion only.', off);
  }

  // 5. Vermilion share, counted on the final pixels
  {
    const img = canvas.getContext('2d').getImageData(0, 0, W, H);
    const [vr, vg, vb] = hexToRgb(T.colour.vermilion.hex);
    let n = 0;
    for (let i = 0; i < img.data.length; i += 16) {
      if (Math.abs(img.data[i] - vr) + Math.abs(img.data[i + 1] - vg) + Math.abs(img.data[i + 2] - vb) < 36) n++;
    }
    const share = n / (img.data.length / 16);
    add('vermilion', 'Vermilion is a signal (≤ 5% of the frame)', 4, share <= T.vermilion_max_share ? 'pass' : 'fail',
      `${(share * 100).toFixed(1)}% of pixels (target about 3%).`);
  }

  // 6. Typeface
  {
    const fam = T.type.family;
    const loaded = document.fonts.check(`400 20px "${fam}"`) && document.fonts.check(`700 20px "${fam}"`);
    const weights = new Set(texts.map(t => t.weight));
    const okW = [...weights].every(w => w === 400 || w === 700);
    add('type', 'Inter Tight 400/700 only', 5, loaded && okW ? 'pass' : 'fail',
      loaded ? `Weights used: ${[...weights].join(', ')}.` : 'Inter Tight did not load: output would use a fallback font.');
  }

  // 7. Fit: nothing truncated, nothing outside the frame, no collisions
  {
    const over = texts.filter(t => t.overflow || t.lines.length > t.maxLines || !inside(t, W, H));
    const boxes = [...texts, ...G.filter(g => g.kind === 'arrow' || g.kind === 'logo')];
    const hits = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      if (intersects(boxes[i], boxes[j])) hits.push([boxes[i], boxes[j]]);
    }
    if (over.length || hits.length) add('fit', 'Text fits, nothing collides', 7, 'fail',
      [...over.map(t => `"${t.text}" does not fit`), ...hits.map(([a, b]) => `${a.text ?? a.kind} overlaps ${b.text ?? b.kind}`)].join(' · '),
      [...over, ...hits.flat()]);
    else add('fit', 'Text fits, nothing collides', 7, 'pass', 'All copy fits its box at a legible size.');
  }

  // 8. Minimum type size: never smaller than the guide's own micro-labels
  {
    const min = 0.0155 * u;
    const small = texts.filter(t => t.size < min);
    add('size', 'Type no smaller than micro-label size', 5, small.length ? 'fail' : 'pass',
      small.length ? small.map(t => `"${t.text}" ${t.size}px < ${min.toFixed(0)}px`).join(' · ') : `Smallest ${Math.min(...texts.map(t => t.size))}px (min ${min.toFixed(0)}px).`, small);
  }

  // 9. Logo: supplied file, undistorted, clearspace kept, legible, in the footer
  {
    const logos = G.filter(g => g.kind === 'logo');
    const issues = [];
    for (const l of logos) {
      if (!Object.values(T.logo).includes(l.file)) issues.push('not a supplied logo file');
      if (Math.abs(l.aspect / l.expectedAspect - 1) > 0.005) issues.push('logo is stretched');
      if (!inside(l, W, H)) issues.push('clearspace runs off the frame');
      for (const t of texts) if (intersects(l, t)) issues.push(`"${t.text}" inside the logo clearspace`);
      if (l.visible.h < 0.035 * u) issues.push(`logo too small (${l.visible.h.toFixed(0)}px tall)`);
    }
    if (!logos.length) issues.push('no logo');
    add('logo', 'Logo: supplied art, h/2 clearspace, legible', 2, issues.length ? 'fail' : 'pass',
      issues.length ? issues.join(' · ') : `Supplied lockup, ${logos[0].visible.h.toFixed(0)}px visible height, clearspace clear.`, logos);
  }

  // 10. Composition: a clear black footer carrying the logo
  {
    const footer = G.find(g => g.kind === 'field' && g.name === 'black' && Math.abs(g.y + g.h - H) < 1);
    const logo = G.find(g => g.kind === 'logo');
    const ok = footer && logo && logo.visible.y >= footer.y;
    add('footer', 'One frame, clear footer', 7, ok ? 'pass' : 'fail', ok ? 'Black footer with logo.' : 'Missing footer or logo outside it.');
  }

  // 11. Platform safe zones (stories)
  if (f.safeTop) {
    const lo = f.safeTop, hi = H - f.safeBottom;
    const out = [...texts, ...G.filter(g => g.kind === 'logo').map(l => ({ ...l.visible, text: 'logo' }))]
      .filter(b => b.y < lo || b.y + b.h > hi);
    add('safezone', 'Clear of platform UI (story safe zone)', null, out.length ? 'fail' : 'pass',
      out.length ? out.map(b => `"${b.text}"`).join(' · ') : `All text and logo between ${lo}px and ${hi}px.`, out);
  }

  // 12. Photography: supplied, provenance known, not over-enlarged
  {
    const ph = G.filter(g => g.kind === 'photo');
    if (ph.length) {
      const big = ph.filter(p => p.upscale > 1.6);
      add('photo', 'Photography: supplied, sharp enough', 8, big.length ? 'review' : 'pass',
        `${ph.map(p => `${p.id} at ${(p.upscale * 100).toFixed(0)}%`).join(', ')}. Fictional, AI-generated images supplied with the kit: disclose and never use as customer evidence.` +
        (big.length ? ' Enlarged past 160%: check for softness.' : ''), big, big.length ? 'Designer' : undefined);
    }
  }

  // 13. Assumed assets must be confirmed
  {
    const flows = G.filter(g => g.kind === 'graphic' && g.status === 'assumed');
    if (flows.length) add('assumed', 'Assumed brand assets confirmed', null, 'review',
      'Uses the stand-in flow graphic (the kit listed flow graphics but none were supplied).', flows, 'Brand lead');
  }

  return summarise(checks);
}

export function validateSpecCopy(spec, brand) {
  const checks = [];
  const approved = approvedSet(brand.copy);
  if (spec.caption) {
    const res = copyUnits(spec.caption, approved).map(s => ({ s, r: checkCopy(s, brand.copy, approved) }));
    const bad = res.filter(x => x.r.status === 'fail'), rev = res.filter(x => x.r.status === 'review');
    checks.push({
      id: 'caption', title: 'Caption uses approved claims', page: 13,
      status: bad.length ? 'fail' : rev.length ? 'review' : 'pass',
      gate: rev.length && !bad.length ? 'Product marketing' : undefined,
      detail: bad.length ? bad.map(x => `"${x.s}": ${x.r.reason}`).join(' · ')
        : rev.length ? rev.map(x => `"${x.s}": new copy`).join(' · ') : `${res.length} sentences, all approved.`,
      sentences: res.map(x => ({ text: x.s, status: x.r.status, reason: x.r.reason })),
    });
  } else checks.push({ id: 'caption', title: 'Caption uses approved claims', page: 13, status: 'review', detail: 'No caption yet.', gate: 'Requester' });

  const alt = spec.alt ? norm(spec.alt) : '';
  const forbidden = alt && brand.copy.forbidden_patterns.find(f => new RegExp(f.pattern.replace('(?i)', ''), f.pattern.startsWith('(?i)') ? 'i' : '').test(alt));
  checks.push({
    id: 'alt', title: 'Alt text present and factual', page: 6,
    status: !alt ? 'fail' : forbidden ? 'fail' : alt.length > 420 ? 'review' : 'pass',
    detail: !alt ? 'Missing alt text.' : forbidden ? `Alt text contains a ${forbidden.reason}.` : `${alt.length} characters.`,
  });
  return summarise(checks);
}

function summarise(checks) {
  const status = checks.some(c => c.status === 'fail') ? 'fail' : checks.some(c => c.status === 'review') ? 'review' : 'pass';
  return { status, checks };
}
