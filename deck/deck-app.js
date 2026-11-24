// Pulse Deck Studio: presentations on the Sonderline social content system.
import { loadBrand } from '../studio/js/brand.js';
import { frames, render, REQUIRED } from '../studio/js/engine.js';
import { validateFrame, checkCopy, approvedSet } from '../studio/js/validate.js';
import { makeFixer, candidates } from '../studio/js/fixes.js';
import { draftDeckWithClaude, draftDeckOffline } from '../studio/js/drafting.js';
import { buildPptx, buildPdf } from '../studio/js/export-deck.js';

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
const LAYOUTS = {
  'full-bleed': 'Photo with headline',
  'contour-title': 'Statement with Contour',
  'photo-hero': 'Photo with message panel',
  'signal-grid': 'Signal grid',
  'scene-story': 'Product story',
  'type-led': 'Statement with call to action',
  'signal': 'One signal',
  'scene-invite': 'Closing slide',
};
const FIELDS = {
  'full-bleed': [['label', 'Label'], ['headline', 'Headline']],
  'contour-title': [['label', 'Label'], ['headline', 'Headline'], ['lead', 'Lead']],
  'photo-hero': [['headline', 'Headline'], ['label', 'Label'], ['lead', 'Lead'], ['cta', 'Call to action'], ['status_label', 'Status label'], ['status', 'Status']],
  'signal-grid': [['label', 'Label'], ['headline', 'Headline'], ['lead', 'Lead'], ['cta', 'Call to action']],
  'scene-story': [['label', 'Label'], ['headline', 'Headline'], ['status_label', 'Panel label'], ['lead', 'Panel text']],
  'type-led': [['label', 'Label'], ['headline', 'Headline'], ['lead', 'Lead'], ['cta', 'Call to action']],
  'signal': [['label', 'Label'], ['signal', 'Signal']],
  'scene-invite': [['label', 'Label'], ['headline', 'Headline'], ['cta', 'Call to action'], ['status', 'Status']],
};
const PHOTO_LAYOUTS = ['full-bleed', 'photo-hero', 'scene-story', 'signal'];
const listFor = slot => `dl-${['status_label', 'footer_label'].includes(slot) ? 'label' : slot}`;

let brand, approved, fixer, spec, outputs = [], sel = 0, approvals = {}, approvedHash = null;
const view = $('#view');

// ---------- spec ----------
async function loadPreset(v) {
  if (v === 'new') {
    for (const id of ['requester', 'channel', 'brief']) $(`#${id}`).value = '';
    $('#brief').focus();
    $('#draftStatus').textContent = 'Write a brief, then Draft deck.';
    return;
  }
  setSpec(await fetch(v).then(r => r.json()));
}

function setSpec(s) {
  spec = structuredClone(s);
  spec.kind = 'deck'; spec.formats = ['slide'];
  sel = 0;
  $('#requester').value = spec.request?.requester || '';
  $('#channel').value = spec.request?.channel || '';
  $('#brief').value = spec.request?.brief || '';
  $('#draftStatus').textContent = spec.draftedBy ? `Drafted by ${spec.draftedBy.by}. ${spec.draftedBy.rationale || ''}` : '';
  build();
  rerender();
}

async function draft() {
  const request = { requester: $('#requester').value, channel: $('#channel').value, brief: $('#brief').value.trim() };
  if (!request.brief) { $('#draftStatus').textContent = 'Write a brief first.'; return; }
  const key = $('#apikey').value.trim();
  $('#draft').disabled = true;
  $('#draftStatus').textContent = key ? 'Claude is drafting the deck…' : 'Drafting with the offline rules (no key)…';
  try {
    setSpec(key ? await draftDeckWithClaude(brand, request, key) : draftDeckOffline(brand, request));
    const gaps = spec.draftedBy?.copy_gaps?.length ? ` Copy gaps for product marketing: ${spec.draftedBy.copy_gaps.join('; ')}` : '';
    $('#draftStatus').textContent = `Drafted by ${spec.draftedBy.by}. ${spec.draftedBy.rationale || ''}${gaps}`;
  } catch (e) {
    $('#draftStatus').textContent = `Drafting failed: ${e.message}`;
  } finally { $('#draft').disabled = false; }
}

let timer;
function changed(rebuild = false) {
  if (rebuild) build();
  clearTimeout(timer);
  timer = setTimeout(rerender, 200);
}

// ---------- slide editor ----------
function build() {
  $('#addLayout').replaceChildren(...Object.entries(LAYOUTS).map(([k, v]) => el('option', { value: k }, v)));
  $('#slides').replaceChildren(...spec.frames.map((fr, i) => {
    const body = el('div', { class: 'body' });
    body.append(el('label', {}, 'Layout', el('select', { onchange: e => { fr.layout = e.target.value; fillRequired(fr, i); changed(true); } },
      Object.entries(LAYOUTS).map(([k, v]) => el('option', { value: k, selected: fr.layout === k }, v)))));
    fr.content ||= {};
    for (const [slot, label] of FIELDS[fr.layout] || []) {
      const tag = el('span', { class: 'tag' });
      const setTag = v => {
        const r = v ? checkCopy(v, brand.copy, approved) : { status: 'pass' };
        tag.className = `tag ${r.status}`;
        tag.textContent = v ? { pass: 'approved', review: 'new copy: review', fail: `blocked: ${r.reason}` }[r.status] : '';
      };
      setTag(fr.content[slot]);
      body.append(el('div', { class: 'field' }, el('label', {}, label, tag, el('input', {
        list: listFor(slot), value: fr.content[slot] ?? '', oninput: e => { fr.content[slot] = e.target.value; setTag(e.target.value); changed(); },
      }))));
    }
    if (PHOTO_LAYOUTS.includes(fr.layout)) {
      body.append(el('label', {}, 'Photo', el('select', {
        onchange: e => { fr.photo = { id: e.target.value, focus: [0.3, 0.5], zoom: 1 }; changed(true); },
      }, Object.keys(brand.tokens.photography).map(id => el('option', { value: id, selected: fr.photo?.id === id }, id)))));
    }
    if (['contour-title', 'type-led', 'signal'].includes(fr.layout)) {
      const opts = fr.layout === 'signal' ? ['white', 'lavender', 'coolgrey'] : ['lavender', 'black', 'white', 'coolgrey'];
      body.append(el('label', {}, 'Field', el('select', { onchange: e => { fr.field = e.target.value; changed(); } },
        opts.map(v => el('option', { value: v, selected: (fr.field || opts[0]) === v }, v)))));
    }
    if (fr.layout === 'photo-hero') body.append(el('label', {}, 'Accent panel', el('select', { onchange: e => { fr.accent = e.target.value; changed(); } },
      ['lavender', 'coolgrey'].map(v => el('option', { value: v, selected: (fr.accent || 'lavender') === v }, v)))));
    body.append(el('label', {}, 'Speaker notes', el('textarea', { rows: 2, oninput: e => { fr.notes = e.target.value; changed(); } }, fr.notes || '')));
    const move = d => () => { const j = i + d; if (j < 0 || j >= spec.frames.length) return; [spec.frames[i], spec.frames[j]] = [spec.frames[j], spec.frames[i]]; sel = j; changed(true); };
    return el('div', { class: `scene${i === sel ? ' sel' : ''}` },
      el('header', { onclick: e => { if (e.target.tagName !== 'BUTTON') select(i); } },
        el('b', {}, `${i + 1} · ${LAYOUTS[fr.layout] || fr.layout}`),
        el('button', { onclick: move(-1), title: 'Move up' }, '↑'),
        el('button', { onclick: move(1), title: 'Move down' }, '↓'),
        el('button', { onclick: () => { if (spec.frames.length > 1) { spec.frames.splice(i, 1); sel = Math.min(sel, spec.frames.length - 1); changed(true); } }, title: 'Remove' }, '✕')),
      body);
  }));
}

function fillRequired(fr, i) {
  fr.content ||= {};
  const signals = brand.copy.product.signals;
  for (const slot of REQUIRED[fr.layout] || []) {
    if (String(fr.content[slot] ?? '').trim()) continue;
    fr.content[slot] = slot === 'signal' ? signals[i % signals.length] : candidates(brand, slot)[0];
  }
  if (PHOTO_LAYOUTS.includes(fr.layout) && !fr.photo) fr.photo = { id: 'motion-study', focus: [0.3, 0.5], zoom: 1 };
}

// ---------- render, check ----------
function rerender() {
  spec.request = { requester: $('#requester').value, channel: $('#channel').value, brief: $('#brief').value };
  $('#json').value = JSON.stringify(spec, null, 2);
  outputs = frames(spec).map(fr => {
    const canvas = document.createElement('canvas');
    try {
      const result = render(canvas, brand, fr, 'slide');
      return { fr, canvas, result, report: validateFrame(result, canvas, brand) };
    } catch (e) {
      return { fr, canvas, report: { status: 'fail', checks: [{ id: 'render', title: 'Render', status: 'fail', detail: e.message, boxes: [] }] } };
    }
  });
  const order = ['pass', 'review', 'fail'];
  const worst = outputs.map(o => o.report.status).reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), 'pass');
  $('#overall').className = `chip ${worst}`; $('#overall').textContent = worst;
  $('#meta').textContent = `${outputs.length} slides · 16:9 · ${spec.title || ''}`;
  $('#slideMeta').textContent = `${outputs.length}`;
  $('#thumbs').replaceChildren(...outputs.map((o, i) => el('button', { class: 'thumb', 'aria-pressed': String(i === sel), onclick: () => select(i) },
    o.canvas, el('span', {}, el('b', { class: `chip ${o.report.status}` }, o.report.status), el('span', { class: 'num' }, `${i + 1}`)))));
  sel = Math.min(sel, outputs.length - 1);
  select(sel);
  renderGates();
}

function select(i) {
  sel = Math.max(0, Math.min(outputs.length - 1, i));
  document.querySelectorAll('.thumb').forEach((t, j) => t.setAttribute('aria-pressed', String(j === sel)));
  document.querySelectorAll('.scene').forEach((n, j) => n.classList.toggle('sel', j === sel));
  const o = outputs[sel];
  if (!o) return;
  // draw at display size with high-quality resampling
  const area = view.parentElement.parentElement.getBoundingClientRect();
  const k = Math.min((area.width - 40) / o.canvas.width, (window.innerHeight * 0.55) / o.canvas.height, 1);
  const dpr = window.devicePixelRatio || 1, cssW = Math.round(o.canvas.width * k), cssH = Math.round(o.canvas.height * k);
  view.width = Math.round(cssW * dpr); view.height = Math.round(cssH * dpr);
  view.style.width = `${cssW}px`; view.style.height = `${cssH}px`;
  const ctx = view.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(o.canvas, 0, 0, view.width, view.height);
  $('#notesView').textContent = o.fr.notes ? `Notes: ${o.fr.notes}` : '';
  const bad = o.report.checks.filter(c => c.status !== 'pass');
  $('#checks').replaceChildren(
    el('p', { class: 'fine' }, `Slide ${sel + 1}: ${LAYOUTS[o.fr.layout] || o.fr.layout}`),
    el('ul', { class: 'checks' }, (bad.length ? bad : [{ status: 'pass', title: 'All checks pass', detail: `${o.report.checks.length} checks on this slide.` }]).map(c =>
      el('li', { class: c.status }, el('span', { class: 'i' }, ICON[c.status]),
        el('div', {}, c.title, c.page ? el('span', { class: 'muted' }, ` · guide p${String(c.page).padStart(2, '0')}`) : null, el('small', {}, c.detail),
          c.gate ? el('span', { class: 'gate' }, `→ ${c.gate}`) : null,
          c.status === 'pass' ? null : fixButtons(fixer.forCheck(c, { fmt: 'slide', layout: o.fr.layout, frameIndex: sel })))))));
}

function fixButtons(fixes) {
  if (!fixes.length) return null;
  return el('div', { class: 'fixes' }, el('span', { class: 'fixhead' }, 'Fix:'), fixes.map(f => el('button', {
    class: 'fix', onclick: async e => { e.currentTarget.disabled = true; const msg = await f.run(); if (msg) $('#exportStatus').textContent = msg; },
  }, f.hint ? el('small', {}, `${f.hint} `) : null, f.label)));
}

// ---------- approvals ----------
function specHash() { const { request, ...rest } = spec; return JSON.stringify(rest); }

function renderGates() {
  const h = specHash();
  if (approvedHash && approvedHash !== h && Object.keys(approvals).length) {
    approvals = {};
    $('#exportStatus').textContent = 'Approvals were cleared because the deck changed after it was approved.';
  }
  approvedHash = h;
  const all = outputs.flatMap(o => o.report.checks);
  const blocked = all.some(c => c.status === 'fail');
  const gates = [
    { id: 'designer', who: 'Designer', why: 'Slide order, crops and how each slide reads.' },
    { id: 'brand', who: 'Brand lead', why: 'Final approval, including the proposed Contour graphic.' },
  ];
  if (all.some(c => c.gate === 'Product marketing')) gates.splice(1, 0, { id: 'pmm', who: 'Product marketing', why: 'New copy or claims that are not in the approved library.' });
  $('#gates').replaceChildren(...gates.map(g => {
    const done = approvals[g.id];
    const name = el('input', { placeholder: 'Name', disabled: !!done || blocked });
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
  $('#pptx').disabled = $('#pdf').disabled = !ready;
  if (blocked) $('#exportStatus').textContent = 'Blocked: fix the failing checks before anyone can approve.';
  else if (!ready) $('#exportStatus').textContent = `Needs approval from: ${gates.filter(g => !approvals[g.id]).map(g => g.who).join(', ')}.`;
  else $('#exportStatus').textContent = 'Ready to export.';
}

// ---------- export ----------
function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
}

async function exportBlob(kind) {
  if (kind === 'pptx') {
    const pptx = await buildPptx(brand, spec, window.PptxGenJS, '..');
    return pptx.write({ outputType: 'blob' });
  }
  return buildPdf(brand, spec, window.jspdf.jsPDF).output('blob');
}

async function exportFile(kind) {
  $('#exportStatus').textContent = kind === 'pptx' ? 'Building the PowerPoint file…' : 'Building the PDF…';
  const blob = await exportBlob(kind);
  download(blob, `${spec.id || 'sonderline-deck'}.${kind}`);
  download(new Blob([JSON.stringify({ spec, approvals: Object.values(approvals), exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' }), `${spec.id || 'sonderline-deck'}-approvals.json`);
  $('#exportStatus').textContent = `Exported ${spec.id || 'sonderline-deck'}.${kind} with its approval record.`;
}

// ---------- start ----------
brand = await loadBrand('..');
approved = approvedSet(brand.copy);
for (const slot of ['headline', 'lead', 'cta', 'status', 'label', 'signal']) {
  document.body.append(el('datalist', { id: `dl-${slot}` }, candidates(brand, slot).map(t => el('option', { value: t }))));
}
fixer = makeFixer({
  brand, getSpec: () => spec, targetFor: i => spec.frames[i],
  commit: rebuild => changed(rebuild),
  setBusy: msg => { $('#exportStatus').textContent = msg; },
});
$('#preset').addEventListener('change', e => loadPreset(e.target.value));
$('#draft').addEventListener('click', draft);
$('#addSlide').addEventListener('click', () => {
  const fr = { layout: $('#addLayout').value, content: {} };
  fillRequired(fr, spec.frames.length);
  spec.frames.splice(spec.frames.length - 1, 0, fr);
  sel = spec.frames.length - 2;
  changed(true);
});
$('#applyJson').addEventListener('click', () => { try { setSpec(JSON.parse($('#json').value)); } catch (e) { alert(`Invalid JSON: ${e.message}`); } });
$('#pptx').addEventListener('click', () => exportFile('pptx'));
$('#pdf').addEventListener('click', () => exportFile('pdf'));
window.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') select(sel + 1);
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') select(sel - 1);
});
window.addEventListener('resize', () => select(sel));
const fromHash = new URLSearchParams(location.hash.slice(1)).get('spec');
await loadPreset(fromHash || $('#preset').value);
// used by tools/produce_deck.py to write deliverables without clicking
window.deckStudio = {
  get spec() { return spec; }, get outputs() { return outputs; },
  async exportBase64(kind) {
    const blob = await exportBlob(kind);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  },
};
