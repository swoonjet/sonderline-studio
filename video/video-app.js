// Pulse Video Studio: video social posts on the Sonderline Social System.
import { loadBrand } from '../studio/js/brand.js';
import { REQUIRED } from '../studio/js/engine.js';
import { checkCopy, approvedSet } from '../studio/js/validate.js';
import { MotionRenderer } from '../studio/js/motion.js';
import { makeFixer, candidates } from '../studio/js/fixes.js';

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
const FORMATS = { feed: 'Feed 4:5', square: 'Square 1:1', story: 'Reel / Story 9:16', slide: 'Landscape 16:9' };
const LAYOUTS = {
  'contour-title': 'Contour title card',
  'photo-hero': 'Photo + message',
  'scene-context': 'Photo + statement',
  'scene-story': 'Product story',
  'signal': 'One signal',
  'type-led': 'Type-led (end card)',
  'scene-invite': 'Invitation (end card)',
};
const FIELDS = {
  'contour-title': [['label', 'Label'], ['headline', 'Headline'], ['lead', 'Lead']],
  'photo-hero': [['headline', 'Headline'], ['label', 'Label'], ['lead', 'Lead'], ['cta', 'Call to action'], ['status_label', 'Status label'], ['status', 'Status']],
  'scene-context': [['headline', 'Headline']],
  'scene-story': [['label', 'Label'], ['headline', 'Headline'], ['status_label', 'Panel label'], ['lead', 'Panel text']],
  'signal': [['label', 'Label'], ['signal', 'Signal']],
  'type-led': [['label', 'Label'], ['headline', 'Headline'], ['lead', 'Lead'], ['cta', 'Call to action']],
  'scene-invite': [['label', 'Label'], ['headline', 'Headline'], ['cta', 'Call to action'], ['status', 'Status']],
};
const PHOTO_LAYOUTS = ['photo-hero', 'scene-context', 'scene-story', 'signal'];
const listFor = slot => `dl-${['status_label', 'footer_label'].includes(slot) ? 'label' : slot}`;

let brand, tracks, approved, fixer, spec, mr, report;
let sel = 0, playing = false, T = 0, approvals = {}, approvedHash = null;
let actx, buffers = {}, source = null, gain = null, t0 = 0;
const screen = $('#screen');

// ---------- spec ----------
async function loadPreset(v) {
  if (v === 'blank') {
    setSpec({
      id: `video-${Date.now().toString(36)}`, title: 'New video post', kind: 'video', format: 'feed', music: 'pulse',
      content: { footer_label: 'OPERATIONS / PERSPECTIVE' },
      scenes: [
        { layout: 'contour-title', beats: 8, field: 'black', content: { label: 'SONDERLINE PULSE', headline: 'Every site. One view.' } },
        { layout: 'scene-invite', beats: 8, content: { label: 'SONDERLINE PULSE', headline: 'Meet Pulse.', cta: 'Request a Pulse demo.', status: 'Early-access pilots planned for Q1 2027.' } },
      ],
      caption: '', alt: '',
    });
  } else setSpec(await fetch(v).then(r => r.json()));
}

function setSpec(s) {
  stop();
  spec = structuredClone(s);
  sel = 0; T = 0;
  build();
  refresh();
}

function refresh() {
  mr = new MotionRenderer(brand, spec, tracks).prepare();
  report = mr.check();
  $('#json').value = JSON.stringify(spec, null, 2);
  const tl = mr.tl;
  $('#meta').textContent = `${FORMATS[spec.format]} · ${tl.total.toFixed(1)}s · ${tl.scenes.length} scenes · ${tl.bpm} bpm`;
  $('#sceneMeta').textContent = `${tl.scenes.length} · ${tl.total.toFixed(1)}s`;
  $('#lanes').replaceChildren(...tl.scenes.map((sc, i) => el('div', {
    class: `${report.scenes[i].status}${i === sel ? ' on' : ''}`, style: `flex:${sc.dur}`,
    title: `${i + 1}: ${LAYOUTS[sc.layout] || sc.layout} · ${sc.beats} beats`,
    onclick: () => { seek(sc.start + sc.dur * 0.6); selectScene(i); },
  }, `${i + 1} · ${sc.beats}♩`)));
  renderChecks();
  renderGates();
  draw();
}

let timer;
function changed(rebuild = false) {
  if (rebuild) build();
  clearTimeout(timer);
  timer = setTimeout(refresh, 200);
}

// ---------- editor ----------
function build() {
  $('#format').replaceChildren(...Object.entries(FORMATS).map(([k, v]) => el('option', { value: k, selected: spec.format === k }, v)));
  $('#music').replaceChildren(
    ...Object.entries(tracks).map(([k, v]) => el('option', { value: k, selected: spec.music === k }, `${k[0].toUpperCase()}${k.slice(1)} · ${v.bpm} bpm`)),
    el('option', { value: '', selected: !spec.music }, 'No music'));
  $('#musicNote').textContent = spec.music ? `${tracks[spec.music].mood}. Original, made for this prototype.` : 'Silent: still designed to read with the sound off.';
  $('#caption').value = spec.caption || '';
  $('#alt').value = spec.alt || '';
  $('#addLayout').replaceChildren(...Object.entries(LAYOUTS).map(([k, v]) => el('option', { value: k }, v)));

  $('#scenes').replaceChildren(...spec.scenes.map((sc, i) => {
    const body = el('div', { class: 'body' });
    body.append(el('div', { class: 'row2' },
      el('label', {}, 'Layout', el('select', { onchange: e => { sc.layout = e.target.value; fillRequired(sc, i); changed(true); } },
        Object.entries(LAYOUTS).map(([k, v]) => el('option', { value: k, selected: sc.layout === k }, v)))),
      el('label', {}, 'Length', el('select', { onchange: e => { sc.beats = +e.target.value; changed(); } },
        [4, 6, 8, 12, 16].map(b => el('option', { value: b, selected: sc.beats === b }, `${b} beats`))))));
    sc.content ||= {};
    for (const [slot, label] of FIELDS[sc.layout] || []) {
      const tag = el('span', { class: 'tag' });
      const setTag = v => {
        const r = v ? checkCopy(v, brand.copy, approved) : { status: 'pass' };
        tag.className = `tag ${r.status}`;
        tag.textContent = v ? { pass: 'approved', review: 'new copy: review', fail: `blocked: ${r.reason}` }[r.status] : '';
      };
      setTag(sc.content[slot]);
      body.append(el('div', { class: 'field' }, el('label', {}, label, tag, el('input', {
        list: listFor(slot), value: sc.content[slot] ?? '', oninput: e => { sc.content[slot] = e.target.value; setTag(e.target.value); changed(); },
      }))));
    }
    if (['contour-title', 'type-led', 'signal'].includes(sc.layout)) {
      const opts = sc.layout === 'signal' ? ['white', 'lavender', 'coolgrey'] : ['black', 'lavender', 'white', 'coolgrey'];
      body.append(el('label', {}, 'Field', el('select', { onchange: e => { sc.field = e.target.value; changed(); } },
        opts.map(v => el('option', { value: v, selected: (sc.field || opts[sc.layout === 'type-led' ? 1 : 0]) === v }, v)))));
    }
    if (sc.layout === 'photo-hero') {
      body.append(el('label', {}, 'Accent panel', el('select', { onchange: e => { sc.accent = e.target.value; changed(); } },
        ['lavender', 'coolgrey'].map(v => el('option', { value: v, selected: (sc.accent || 'lavender') === v }, v)))));
    }
    if (PHOTO_LAYOUTS.includes(sc.layout)) {
      body.append(el('label', {}, 'Photo', el('select', {
        onchange: e => { sc.photo = e.target.value ? { id: e.target.value, zoom: 1.3 } : null; sc.pan = sc.photo ? [[0.2, 0.5], [0.5, 0.5]] : undefined; changed(true); },
      }, el('option', { value: '' }, 'none'), Object.keys(brand.tokens.photography).map(id => el('option', { value: id, selected: sc.photo?.id === id }, id)))));
      if (sc.photo) {
        sc.pan ||= [[0.2, 0.5], [0.5, 0.5]];
        const slider = (name, min, max, step, get, set) => el('div', { class: 'slider' }, name,
          el('input', { type: 'range', min, max, step, value: get(), oninput: e => { set(+e.target.value); e.target.nextSibling.textContent = (+e.target.value).toFixed(2); changed(); } }),
          el('span', {}, get().toFixed(2)));
        body.append(
          slider('Pan from', 0, 1, 0.01, () => sc.pan[0][0], v => { sc.pan[0][0] = v; }),
          slider('Pan to', 0, 1, 0.01, () => sc.pan[1][0], v => { sc.pan[1][0] = v; }),
          slider('Zoom', 1, 2.5, 0.05, () => sc.photo.zoom || 1, v => { sc.photo.zoom = v; }));
      }
    }
    const move = d => () => { const j = i + d; if (j < 0 || j >= spec.scenes.length) return; [spec.scenes[i], spec.scenes[j]] = [spec.scenes[j], spec.scenes[i]]; changed(true); };
    return el('div', { class: `scene${i === sel ? ' sel' : ''}`, 'data-i': i },
      el('header', { onclick: e => { if (e.target.tagName !== 'BUTTON') { selectScene(i); seek(mr.tl.scenes[i].start + mr.tl.scenes[i].dur * 0.6); } } },
        el('b', {}, `${i + 1} · ${LAYOUTS[sc.layout] || sc.layout}`),
        el('button', { onclick: move(-1), title: 'Move up' }, '↑'),
        el('button', { onclick: move(1), title: 'Move down' }, '↓'),
        el('button', { onclick: () => { if (spec.scenes.length > 1) { spec.scenes.splice(i, 1); sel = Math.min(sel, spec.scenes.length - 1); changed(true); } }, title: 'Remove' }, '✕')),
      body);
  }));
}

function fillRequired(sc, i) {
  sc.content ||= {};
  const signals = brand.copy.product.signals;
  for (const slot of REQUIRED[sc.layout] || []) {
    if (String(sc.content[slot] ?? '').trim()) continue;
    if (slot === 'signal') sc.content.signal = signals.includes(sc.content.headline) ? sc.content.headline : signals[i % signals.length];
    else sc.content[slot] = candidates(brand, slot)[0];
  }
  if (PHOTO_LAYOUTS.includes(sc.layout) && sc.layout !== 'signal' && sc.photo === undefined) { sc.photo = { id: 'motion-study', zoom: 1.3 }; sc.pan = [[0.1, 0.5], [0.45, 0.5]]; }
}

function selectScene(i) {
  sel = i;
  document.querySelectorAll('.scene').forEach((n, j) => n.classList.toggle('sel', j === i));
  document.querySelectorAll('.lanes div').forEach((n, j) => n.classList.toggle('on', j === i));
  document.querySelectorAll('.scenecheck').forEach((n, j) => { n.open = j === i || n.classList.contains('bad'); });
}

// ---------- checks + approvals ----------
function fixButtons(fixes) {
  if (!fixes.length) return null;
  return el('div', { class: 'fixes' }, el('span', { class: 'fixhead' }, 'Fix:'), fixes.map(f => el('button', {
    class: 'fix', onclick: async e => { e.currentTarget.disabled = true; const msg = await f.run(); if (msg) $('#exportStatus').textContent = msg; },
  }, f.hint ? el('small', {}, `${f.hint} `) : null, f.label)));
}

function renderChecks() {
  const order = ['pass', 'review', 'fail'];
  const worst = [...report.scenes.map(s => s.status), report.copy.status].reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), 'pass');
  $('#overall').className = `chip ${worst}`; $('#overall').textContent = worst;
  $('#checks').replaceChildren(...report.scenes.map((s, i) => {
    const bad = s.checks.filter(c => c.status !== 'pass');
    return el('details', { class: `scenecheck${s.status === 'fail' ? ' bad' : ''}`, open: i === sel || s.status === 'fail' },
      el('summary', {}, el('b', { class: `chip ${s.status}` }, s.status), `Scene ${i + 1} · ${LAYOUTS[s.layout] || s.layout}`),
      el('ul', { class: 'checks' }, (bad.length ? bad : [{ status: 'pass', title: 'All checks pass', detail: `${s.checks.length} checks at start, middle and end of the move.` }]).map(c =>
        el('li', { class: c.status }, el('span', { class: 'i' }, ICON[c.status]),
          el('div', {}, c.title, c.page ? el('span', { class: 'muted' }, ` · guide p${String(c.page).padStart(2, '0')}`) : null, el('small', {}, c.detail),
            c.gate ? el('span', { class: 'gate' }, `→ ${c.gate}`) : null,
            c.status === 'pass' ? null : fixButtons(fixer.forCheck(c, { fmt: spec.format, layout: s.layout, frameIndex: i })))))));
  }));
  $('#copyChecks').replaceChildren(...report.copy.checks.map(c => el('li', { class: c.status }, el('span', { class: 'i' }, ICON[c.status]),
    el('div', {}, c.title, el('small', {}, c.detail), c.gate ? el('span', { class: 'gate' }, `→ ${c.gate}`) : null, fixButtons(fixer.forCopy(c))))));
}

function specHash() { const { request, ...rest } = spec; return JSON.stringify(rest); }

function renderGates() {
  const h = specHash();
  if (approvedHash && approvedHash !== h && Object.keys(approvals).length) {
    approvals = {};
    $('#exportStatus').textContent = 'Approvals cleared: the video changed after it was approved.';
  }
  approvedHash = h;
  const all = [...report.scenes.flatMap(s => s.checks), ...report.copy.checks];
  const blocked = all.some(c => c.status === 'fail');
  const gates = [
    { id: 'designer', who: 'Designer', why: 'Pacing, crops, motion: the edit carries the message.' },
    { id: 'brand', who: 'Brand lead', why: 'Final sign-off, including the proposed Contour graphic and the music.' },
  ];
  if (all.some(c => c.gate === 'Product marketing')) gates.splice(1, 0, { id: 'pmm', who: 'Product marketing', why: 'New copy or claims outside the approved library.' });
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
  $('#record').disabled = !ready;
  if (blocked) $('#exportStatus').textContent = 'Blocked: fix the failing checks before anyone can approve.';
  else if (!ready) $('#exportStatus').textContent = `Needs approval from: ${gates.filter(g => !approvals[g.id]).map(g => g.who).join(', ')}.`;
  else $('#exportStatus').textContent = 'Ready to record.';
}

// ---------- playback ----------
function draw() {
  const { scene } = mr.frameAt(T, screen);
  const beat = Math.floor((T - scene.start) / mr.tl.beat) + 1;
  $('#clock').textContent = `${T.toFixed(1)}s / ${mr.tl.total.toFixed(1)}s · scene ${scene.index + 1} · beat ${beat}`;
  $('#scrub').value = Math.round((T / mr.tl.total) * 1000);
  if (scene.index !== sel && playing) selectScene(scene.index);
}

async function audioFor(name) {
  if (!name) return null;
  actx ||= new AudioContext();
  if (!buffers[name]) {
    const data = await fetch(`../${tracks[name].file}`).then(r => r.arrayBuffer());
    buffers[name] = await actx.decodeAudioData(data);
  }
  return buffers[name];
}

async function play(dest = null) {
  if (playing) return;
  actx ||= new AudioContext();
  await actx.resume();
  if (T >= mr.tl.total - 0.05) T = 0;
  const buf = $('#sound').checked || dest ? await audioFor(spec.music) : null;
  t0 = actx.currentTime + 0.05 - T;
  if (buf) {
    source = actx.createBufferSource(); source.buffer = buf;
    gain = actx.createGain();
    const end = t0 + mr.tl.total;
    gain.gain.setValueAtTime(1, Math.max(actx.currentTime, end - 1.6));
    gain.gain.linearRampToValueAtTime(0, end);
    source.connect(gain);
    gain.connect(dest || actx.destination);
    if (dest && $('#sound').checked) gain.connect(actx.destination);
    source.start(t0 + T, T);
    source.stop(end + 0.05);
  }
  playing = true;
  $('#play').textContent = 'Pause';
  const tick = () => {
    if (!playing) return;
    T = actx.currentTime - t0;
    if (T >= mr.tl.total) { T = mr.tl.total; draw(); stop(); onEnded?.(); return; }
    draw();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let onEnded = null;
function stop() {
  playing = false;
  $('#play').textContent = 'Play';
  try { source?.stop(); } catch {}
  source = null;
}

function seek(t) { const was = playing; stop(); T = Math.max(0, Math.min(mr.tl.total, t)); draw(); if (was) play(); }

// ---------- export ----------
async function record() {
  stop(); T = 0; draw();
  const fps = 30;
  const stream = screen.captureStream(fps);
  actx ||= new AudioContext();
  const dest = actx.createMediaStreamDestination();
  const tracksOut = [...stream.getVideoTracks()];
  if (spec.music) tracksOut.push(...dest.stream.getAudioTracks());
  const mime = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
    .find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  if (!mime) { $('#exportStatus').textContent = 'This browser cannot record video. Use the CLI for an MP4.'; return; }
  const rec = new MediaRecorder(new MediaStream(tracksOut), { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const a = el('a', { href: URL.createObjectURL(new Blob(chunks, { type: mime.split(';')[0] })), download: `${spec.id}.${ext}` });
    document.body.append(a); a.click(); a.remove();
    const log = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify({ spec, report, approvals: Object.values(approvals), exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' })), download: `${spec.id}-approvals.json` });
    document.body.append(log); log.click(); log.remove();
    $('#exportStatus').textContent = `Recorded ${spec.id}.${ext} with its approval record.`;
    $('#record').disabled = false;
  };
  $('#record').disabled = true;
  $('#exportStatus').textContent = `Recording ${mr.tl.total.toFixed(1)}s in real time…`;
  onEnded = () => { onEnded = null; setTimeout(() => rec.stop(), 150); };
  rec.start(250);
  await play(dest);
}

// ---------- boot ----------
brand = await loadBrand('..');
tracks = await fetch('../assets/music/tracks.json').then(r => r.json());
approved = approvedSet(brand.copy);
for (const slot of ['headline', 'lead', 'cta', 'status', 'label', 'signal']) {
  document.body.append(el('datalist', { id: `dl-${slot}` }, candidates(brand, slot).map(t => el('option', { value: t }))));
}
fixer = makeFixer({
  brand, getSpec: () => spec, targetFor: i => spec.scenes[i],
  commit: rebuild => { if (rebuild) build(); refresh(); },
  setBusy: msg => { $('#exportStatus').textContent = msg; },
});
$('#preset').addEventListener('change', e => loadPreset(e.target.value));
$('#format').addEventListener('change', e => { spec.format = e.target.value; changed(); });
$('#music').addEventListener('change', e => { spec.music = e.target.value || null; changed(true); });
$('#caption').addEventListener('input', e => { spec.caption = e.target.value; changed(); });
$('#alt').addEventListener('input', e => { spec.alt = e.target.value; changed(); });
$('#addScene').addEventListener('click', () => {
  const sc = { layout: $('#addLayout').value, beats: 8, content: {} };
  fillRequired(sc, spec.scenes.length);
  spec.scenes.splice(spec.scenes.length - 1, 0, sc);
  changed(true);
});
$('#applyJson').addEventListener('click', () => { try { setSpec(JSON.parse($('#json').value)); } catch (e) { alert(`Invalid JSON: ${e.message}`); } });
$('#play').addEventListener('click', () => (playing ? stop() : play()));
$('#scrub').addEventListener('input', e => seek((e.target.value / 1000) * mr.tl.total));
$('#record').addEventListener('click', record);
$('#saveSpec').addEventListener('click', () => {
  const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' })), download: `${spec.id}.json` });
  document.body.append(a); a.click(); a.remove();
});
await loadPreset($('#preset').value);
window.videoStudio = { get spec() { return spec; }, get report() { return report; }, get mr() { return mr; } };
