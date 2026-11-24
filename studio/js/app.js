// Pulse Social Studio: the team-facing front end of the Sonderline Social System.
import { loadBrand } from './brand.js';
import { frames, render, REQUIRED } from './engine.js';
import { validateFrame, validateSpecCopy, checkCopy, approvedSet, sentences } from './validate.js';
import { draftWithClaude, draftOffline } from './drafting.js';
import { makeFixer, candidates } from './fixes.js';

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
const ICON = { pass: '✓', review: '!', fail: '✕' };
const FORMAT_KEYS = ['feed', 'square', 'link', 'story', 'slide'];

let brand, spec, approved, fixer;
let frameSel = 0, outputs = [], sel = 0, approvals = {}, approvedHash = null;

// ---------- spec lifecycle ----------
async function loadPreset(path) {
  setSpec(await fetch(path).then(r => r.json()));
  $('#draftStatus').textContent = spec.draftedBy ? `Drafted by ${spec.draftedBy.by}.` : '';
}

function newBrief() {
  for (const id of ['requester', 'channel', 'brief']) $(`#${id}`).value = '';
  $('#brief').focus();
  $('#draftStatus').textContent = 'Write a brief, then Draft spec.';
}

function setSpec(s) {
  spec = structuredClone(s);
  frameSel = 0;
  $('#requester').value = spec.request?.requester || '';
  $('#channel').value = spec.request?.channel || '';
  $('#brief').value = spec.request?.brief || '';
  buildForm();
  rerender();
}

async function draft() {
  const request = { requester: $('#requester').value, channel: $('#channel').value, brief: $('#brief').value.trim() };
  if (!request.brief) { $('#draftStatus').textContent = 'Write a brief first.'; return; }
  const key = $('#apikey').value.trim();
  $('#draft').disabled = true;
  $('#draftStatus').textContent = key ? 'Claude is drafting the spec…' : 'Drafting with the offline rules (no key)…';
  try {
    const s = key ? await draftWithClaude(brand, request, key) : draftOffline(brand, request);
    setSpec(s);
    const gaps = s.draftedBy.copy_gaps?.length ? ` Copy gaps for Product marketing: ${s.draftedBy.copy_gaps.join('; ')}` : '';
    $('#draftStatus').textContent = `Drafted by ${s.draftedBy.by}. ${s.draftedBy.rationale || ''}${gaps}`;
  } catch (e) {
    $('#draftStatus').textContent = `Drafting failed: ${e.message}`;
  } finally { $('#draft').disabled = false; }
}

// ---------- spec form ----------
function buildDatalists() {
  // suggestions per slot, so a headline field offers headlines and a status field offers status lines
  for (const slot of ['headline', 'lead', 'cta', 'status', 'label', 'signal']) {
    document.body.append(el('datalist', { id: `dl-${slot}` }, candidates(brand, slot).map(t => el('option', { value: t }))));
  }
}

const CONTENT_FIELDS = {
  'photo-hero': [['headline', 'Headline', 'dl-headline'], ['label', 'Label', 'dl-label'], ['lead', 'Lead', 'dl-lead'], ['cta', 'Call to action', 'dl-cta'], ['status_label', 'Status label', 'dl-label'], ['status', 'Status', 'dl-status']],
  'type-led': [['label', 'Label', 'dl-label'], ['headline', 'Headline', 'dl-headline'], ['lead', 'Lead', 'dl-lead'], ['cta', 'Call to action', 'dl-cta']],
  'signal': [['label', 'Label', 'dl-label'], ['signal', 'Signal', 'dl-signal']],
  'signal-grid': [['label', 'Label', 'dl-label'], ['headline', 'Headline', 'dl-headline'], ['lead', 'Lead', 'dl-lead'], ['cta', 'Call to action', 'dl-cta']],
  'scene-context': [['headline', 'Headline', 'dl-headline']],
  'contour-title': [['label', 'Label', 'dl-label'], ['headline', 'Headline', 'dl-headline'], ['lead', 'Lead', 'dl-lead']],
  'scene-story': [['label', 'Label', 'dl-label'], ['headline', 'Headline', 'dl-headline'], ['status_label', 'Panel label', 'dl-label'], ['lead', 'Panel text', 'dl-lead']],
  'scene-invite': [['label', 'Label', 'dl-label'], ['headline', 'Headline', 'dl-headline'], ['cta', 'Call to action', 'dl-cta'], ['status', 'Status', 'dl-status']],
};

function target() { return spec.frames ? spec.frames[frameSel] : spec; }

function buildForm() {
  const nav = $('#frameNav');
  nav.hidden = !spec.frames;
  nav.replaceChildren(...(spec.frames || []).map((f, i) => el('button', {
    'aria-pressed': String(i === frameSel), onclick: () => { frameSel = i; buildForm(); selectOutput(outputs.findIndex(o => o.frameIndex === i)); },
  }, `Frame ${i + 1}`)));

  const t = target();
  const layout = t.layout || spec.layout;
  const form = $('#specForm');
  form.replaceChildren();

  form.append(el('label', {}, 'Layout', el('select', {
    onchange: e => { t.layout = e.target.value; carryContent(t); changed(true); },
  }, Object.keys(CONTENT_FIELDS).map(k => el('option', { value: k, selected: k === layout }, k)))));

  t.content ||= {};
  for (const [key, labelText, list] of CONTENT_FIELDS[layout] || []) {
    const val = t.content[key] ?? spec.content?.[key] ?? '';
    const tag = el('span', { class: 'tag' });
    const setTag = v => {
      const r = v ? checkCopy(v, brand.copy, approved) : { status: 'pass' };
      tag.className = `tag ${r.status}`;
      tag.textContent = v ? { pass: 'approved', review: 'new copy: review', fail: `blocked: ${r.reason}` }[r.status] : '';
    };
    setTag(val);
    form.append(el('div', { class: 'field' }, el('label', {}, labelText, tag, el('input', {
      list, value: val, oninput: e => { t.content[key] = e.target.value; setTag(e.target.value); changed(); },
    }))));
  }
  const footVal = spec.content?.footer_label ?? '';
  form.append(el('label', {}, 'Footer label', el('input', { list: 'dl-label', value: footVal, oninput: e => { spec.content ||= {}; spec.content.footer_label = e.target.value; changed(); } })));

  if (!['type-led', 'signal-grid', 'scene-invite', 'contour-title'].includes(layout)) {
    const ph = t.photo === undefined ? spec.photo : t.photo;
    form.append(el('label', {}, 'Photo', el('select', {
      onchange: e => { t.photo = e.target.value ? { id: e.target.value, focus: [0.5, 0.5], zoom: 1 } : null; changed(true); },
    }, el('option', { value: '' }, layout === 'signal' ? 'none' : 'none (black field)'),
    Object.keys(brand.tokens.photography).map(id => el('option', { value: id, selected: ph?.id === id }, id)))));
    if (ph) {
      t.photo = ph;
      const slider = (name, min, max, step, get, set) => el('div', { class: 'slider' }, name,
        el('input', { type: 'range', min, max, step, value: get(), oninput: e => { set(+e.target.value); e.target.nextSibling.textContent = (+e.target.value).toFixed(2); changed(); } }),
        el('span', {}, get().toFixed(2)));
      ph.focus ||= [0.5, 0.5];
      form.append(
        slider('Focus x', 0, 1, 0.01, () => ph.focus[0], v => { ph.focus[0] = v; }),
        slider('Focus y', 0, 1, 0.01, () => ph.focus[1], v => { ph.focus[1] = v; }),
        slider('Zoom', 1, 2.5, 0.05, () => ph.zoom || 1, v => { ph.zoom = v; }),
      );
    }
  }
  if (layout === 'photo-hero') {
    const sc = t.scrim ?? spec.scrim ?? 'auto';
    form.append(el('label', {}, 'Scrim', el('select', { onchange: e => { t.scrim = e.target.value; changed(); } },
      ['auto', 'off'].map(v => el('option', { value: v, selected: sc === v }, v === 'auto' ? 'auto (solve for 4.5:1)' : 'off')))));
    const ac = t.accent ?? spec.accent ?? 'lavender';
    form.append(el('label', {}, 'Accent panel', el('select', { onchange: e => { t.accent = e.target.value; changed(); } },
      ['lavender', 'coolgrey'].map(v => el('option', { value: v, selected: ac === v }, v)))));
  } else if (['type-led', 'signal', 'contour-title'].includes(layout)) {
    const fv = t.field ?? (layout === 'contour-title' ? 'black' : 'white');
    form.append(el('label', {}, 'Field colour', el('select', { onchange: e => { t.field = e.target.value; changed(); } },
      (layout === 'contour-title' ? ['black', 'lavender', 'white', 'coolgrey'] : ['white', 'lavender', 'coolgrey']).map(v => el('option', { value: v, selected: fv === v }, v)))));
  }

  form.append(el('label', {}, 'Formats'), el('div', { class: 'fmt' }, FORMAT_KEYS.map(k => el('label', {},
    el('input', { type: 'checkbox', checked: spec.formats.includes(k), onchange: e => {
      spec.formats = FORMAT_KEYS.filter(f => f === k ? e.target.checked : spec.formats.includes(f));
      if (!spec.formats.length) spec.formats = ['feed'];
      changed(true);
    } }), brand.formats[k].label))));

  form.append(
    el('label', {}, 'Caption', el('textarea', { rows: 5, oninput: e => { spec.caption = e.target.value; changed(); } }, spec.caption || '')),
    el('label', {}, 'Alt text', el('textarea', { rows: 3, oninput: e => { spec.alt = e.target.value; changed(); } }, spec.alt || '')),
  );
}

// When the layout changes, fill any required slot the new layout needs from what the frame
// already says (or the nearest approved line), so a switch never leaves an empty frame.
function carryContent(t) {
  t.content ||= {};
  const c = t.content, signals = brand.copy.product.signals;
  for (const slot of REQUIRED[t.layout] || []) {
    if (String(c[slot] ?? '').trim()) continue;
    if (slot === 'signal') c.signal = signals.includes(c.headline) ? c.headline : signals[Math.max(0, (spec.frames ? frameSel - 1 : 0)) % signals.length];
    else if (slot === 'headline') c.headline = c.signal && candidates(brand, 'headline').length ? (candidates(brand, 'headline').find(h => h.includes('signal')) || candidates(brand, 'headline')[0]) : candidates(brand, 'headline')[0];
    else c[slot] = candidates(brand, slot)[0];
  }
}

let timer;
function changed(rebuild = false) {
  if (rebuild) buildForm();
  clearTimeout(timer);
  timer = setTimeout(rerender, 180);
}

// ---------- render + validate ----------
function rerender() {
  spec.request = { requester: $('#requester').value, channel: $('#channel').value, brief: $('#brief').value };
  $('#json').value = JSON.stringify(spec, null, 2);
  outputs = [];
  for (const fr of frames(spec)) {
    for (const fmt of spec.formats) {
      const canvas = document.createElement('canvas');
      try {
        const result = render(canvas, brand, fr, fmt);
        outputs.push({ name: spec.frames ? `${fmt}-${String(fr.frameIndex + 1).padStart(2, '0')}` : fmt, fmt, layout: fr.layout, frameIndex: fr.frameIndex, canvas, result, report: validateFrame(result, canvas, brand) });
      } catch (e) {
        outputs.push({ name: spec.frames ? `${fmt}-${String(fr.frameIndex + 1).padStart(2, '0')}` : fmt, fmt, layout: fr.layout, frameIndex: fr.frameIndex, canvas, error: e.message, report: { status: 'fail', checks: [{ id: 'render', title: 'Render', status: 'fail', detail: e.message, boxes: [] }] } });
      }
    }
  }
  const copy = validateSpecCopy(spec, brand);
  spec.__copy = copy;
  $('#renderMeta').textContent = `${outputs.length} output${outputs.length > 1 ? 's' : ''} · ${spec.title || ''}`;
  $('#thumbs').replaceChildren(...outputs.map((o, i) => el('button', { class: 'thumb', 'aria-pressed': String(i === sel), onclick: () => selectOutput(i) },
    o.canvas, el('span', {}, el('b', { class: `chip ${o.report.status}` }, o.report.status), `${o.name} · ${o.canvas.width}×${o.canvas.height}`))));
  sel = Math.min(sel, outputs.length - 1);
  selectOutput(sel);
  renderCopyChecks(copy);
  renderGates();
  delete spec.__copy;
}

function selectOutput(i) {
  if (i < 0) i = 0;
  sel = i;
  document.querySelectorAll('.thumb').forEach((t, j) => t.setAttribute('aria-pressed', String(j === i)));
  if (spec.frames && outputs[i] && outputs[i].frameIndex !== frameSel) { frameSel = outputs[i].frameIndex; buildForm(); }
  showSelected();
}

function showSelected() {
  const o = outputs[sel];
  if (!o) return;
  const big = $('#big'), ov = $('#overlay');
  // draw at display size with high-quality resampling (a CSS-scaled canvas aliases thin lines)
  const area = big.parentElement.parentElement.getBoundingClientRect();
  const k = Math.min((area.width - 40) / o.canvas.width, (window.innerHeight * 0.62) / o.canvas.height, 1);
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.round(o.canvas.width * k), cssH = Math.round(o.canvas.height * k);
  big.width = Math.round(cssW * dpr); big.height = Math.round(cssH * dpr);
  big.style.width = ov.style.width = `${cssW}px`; big.style.height = ov.style.height = `${cssH}px`;
  const bctx = big.getContext('2d');
  bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(o.canvas, 0, 0, big.width, big.height);
  ov.width = o.canvas.width; ov.height = o.canvas.height;
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.width, ov.height);
  if ($('#showOverlay').checked) {
    for (const c of o.report.checks.filter(c => c.status !== 'pass')) {
      ctx.strokeStyle = c.status === 'fail' ? '#c4321b' : '#e0a100';
      ctx.lineWidth = Math.max(3, o.canvas.width / 300);
      ctx.setLineDash(c.status === 'fail' ? [] : [14, 8]);
      ctx.font = `700 ${Math.round(o.canvas.width / 45)}px "Inter Tight"`;
      for (const b of c.boxes || []) {
        ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(c.id, b.x, Math.max(24, b.y - 12));
      }
    }
  }
  $('#notes').textContent = (o.result?.notes || []).join(' ');
  $('#overall').className = `chip ${o.report.status}`;
  $('#overall').textContent = `${o.name}: ${o.report.status}`;
  $('#checks').replaceChildren(...o.report.checks.map(c => el('li', { class: c.status },
    el('span', { class: 'i' }, ICON[c.status]),
    el('div', {}, c.title, c.page ? el('span', { class: 'muted' }, ` · guide p${String(c.page).padStart(2, '0')}`) : null,
      el('small', {}, c.detail), c.gate ? el('span', { class: 'gate' }, `→ ${c.gate}`) : null,
      fixButtons(c.status === 'pass' ? [] : fixer.forCheck(c, o))))));
}

function fixButtons(fixes) {
  if (!fixes.length) return null;
  return el('div', { class: 'fixes' }, el('span', { class: 'fixhead' }, 'Fix:'), fixes.map(f => el('button', {
    class: 'fix', onclick: async e => {
      e.currentTarget.disabled = true;
      const msg = await f.run();
      if (msg) $('#notes').textContent = msg;
    },
  }, f.hint ? el('small', {}, `${f.hint} `) : null, f.label)));
}

function renderCopyChecks(copy) {
  $('#copyChecks').replaceChildren(...copy.checks.map(c => el('li', { class: c.status },
    el('span', { class: 'i' }, ICON[c.status]),
    el('div', {}, c.title, el('small', {}, c.detail), c.gate ? el('span', { class: 'gate' }, `→ ${c.gate}`) : null, fixButtons(fixer.forCopy(c))))));
  const cap = copy.checks.find(c => c.id === 'caption');
  $('#captionView').replaceChildren(...(cap?.sentences || []).flatMap(s => [el('span', { class: `s ${s.status}`, title: s.reason || 'approved' }, s.text), ' ']));
}

// ---------- approval gates ----------
function requiredGates() {
  const all = [...outputs.flatMap(o => o.report.checks), ...validateSpecCopy(spec, brand).checks];
  const gates = [
    { id: 'designer', who: 'Designer', why: 'Craft: crop, rhythm, type, the image carrying the message.' },
    { id: 'brand', who: 'Brand lead', why: 'Final creative and brand sign-off. Owns the rules and library.' },
  ];
  if (all.some(c => c.gate === 'Product marketing')) gates.splice(1, 0, { id: 'pmm', who: 'Product marketing', why: 'New copy or claims outside the approved library.' });
  return { gates, blocked: all.some(c => c.status === 'fail') };
}

function specHash() { const { request, ...rest } = spec; return JSON.stringify(rest); }

function renderGates() {
  const h = specHash();
  if (approvedHash && approvedHash !== h && Object.keys(approvals).length) {
    approvals = {};
    $('#exportStatus').textContent = 'Approvals cleared: the spec changed after it was approved.';
  }
  approvedHash = h;
  const { gates, blocked } = requiredGates();
  $('#gates').replaceChildren(...gates.map(g => {
    const done = approvals[g.id];
    const name = el('input', { placeholder: 'Name', value: done?.name || '', disabled: !!done || blocked });
    return el('div', { class: `gate${done ? ' done' : ''}` },
      el('div', { class: 'who' }, g.who, el('small', {}, done ? `Approved by ${done.name}, ${new Date(done.at).toLocaleString()}` : g.why), done ? null : name),
      done ? el('button', { onclick: () => { delete approvals[g.id]; renderGates(); } }, 'Undo')
        : el('button', { disabled: blocked, onclick: () => {
          if (!name.value.trim()) { name.focus(); return; }
          approvals[g.id] = { gate: g.who, name: name.value.trim(), at: new Date().toISOString() };
          renderGates();
        } }, 'Approve'));
  }));
  const ready = !blocked && gates.every(g => approvals[g.id]);
  $('#export').disabled = !ready;
  if (blocked) $('#exportStatus').textContent = 'Blocked: fix the failing checks before anyone can approve.';
  else if (!ready) $('#exportStatus').textContent = `Needs approval from: ${gates.filter(g => !approvals[g.id]).map(g => g.who).join(', ')}.`;
  else $('#exportStatus').textContent = 'Ready to export.';
}

// ---------- export ----------
async function exportZip() {
  const zip = new JSZip();
  const dir = zip.folder(spec.id || 'sonderline-social');
  for (const o of outputs) dir.file(`${o.name}.png`, o.canvas.toDataURL('image/png').split(',')[1], { base64: true });
  dir.file('caption.md', `# ${spec.title}\n\n## Caption\n${spec.caption || ''}\n\n## Alt text\n${spec.alt || ''}\n`);
  dir.file('spec.json', JSON.stringify(spec, null, 2));
  dir.file('report.json', JSON.stringify({
    copy: validateSpecCopy(spec, brand),
    outputs: Object.fromEntries(outputs.map(o => [o.name, { status: o.report.status, checks: o.report.checks.map(({ boxes, ...c }) => c), notes: o.result?.notes }])),
  }, null, 2));
  dir.file('approvals.json', JSON.stringify({ spec: spec.id, approvals: Object.values(approvals), exportedAt: new Date().toISOString() }, null, 2));
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${spec.id || 'sonderline-social'}.zip` });
  document.body.append(a); a.click(); a.remove();
  $('#exportStatus').textContent = `Exported ${outputs.length} files with caption, spec, report and approval record.`;
}

// exposed for the walkthrough recorder and debugging
window.studio = { get spec() { return spec; }, get outputs() { return outputs; }, sentences };

// ---------- boot (last, so every declaration above is initialised) ----------
brand = await loadBrand('..');
approved = approvedSet(brand.copy);
fixer = makeFixer({
  brand, getSpec: () => spec, targetFor: i => (spec.frames ? spec.frames[i] : spec),
  commit: rebuild => { if (rebuild) buildForm(); rerender(); },
  setBusy: msg => { $('#notes').textContent = msg; },
});
buildDatalists();
$('#preset').addEventListener('change', e => e.target.value === 'new' ? newBrief() : loadPreset(e.target.value));
$('#draft').addEventListener('click', draft);
$('#applyJson').addEventListener('click', () => {
  try { setSpec(JSON.parse($('#json').value)); } catch (e) { alert(`Invalid JSON: ${e.message}`); }
});
$('#showOverlay').addEventListener('change', showSelected);
$('#export').addEventListener('click', exportZip);
const fromHash = new URLSearchParams(location.hash.slice(1)).get('spec');
if (fromHash && [...$('#preset').options].some(o => o.value === fromHash)) $('#preset').value = fromHash;
await loadPreset(fromHash || ($('#preset').value === 'new' ? 'specs/d1-early-access.json' : $('#preset').value));
