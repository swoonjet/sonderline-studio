// Pulse Video Studio: video posts on the Sonderline social content system.
import { loadBrand } from '../studio/js/brand.js';
import { REQUIRED } from '../studio/js/engine.js';
import { checkCopy, approvedSet } from '../studio/js/validate.js';
import { MotionRenderer, timeline } from '../studio/js/motion.js';
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
const FORMATS = { feed: 'Feed 4:5', square: 'Square 1:1', story: 'Reel or story 9:16', slide: 'Landscape 16:9' };
const LAYOUTS = {
  'full-bleed': 'Footage with headline',
  'photo-hero': 'Footage with message panel',
  'signal': 'One signal over footage',
  'scene-context': 'Footage with statement',
  'scene-story': 'Product story',
  'contour-title': 'Contour title card',
  'type-led': 'End card',
  'scene-invite': 'Invitation end card',
};
const FIELDS = {
  'full-bleed': [['label', 'Label'], ['headline', 'Headline']],
  'contour-title': [['label', 'Label'], ['headline', 'Headline'], ['lead', 'Lead']],
  'photo-hero': [['headline', 'Headline'], ['label', 'Label'], ['lead', 'Lead'], ['cta', 'Call to action'], ['status_label', 'Status label'], ['status', 'Status']],
  'scene-context': [['headline', 'Headline']],
  'scene-story': [['label', 'Label'], ['headline', 'Headline'], ['status_label', 'Panel label'], ['lead', 'Panel text']],
  'signal': [['label', 'Label'], ['signal', 'Signal']],
  'type-led': [['label', 'Label'], ['headline', 'Headline'], ['lead', 'Lead'], ['cta', 'Call to action']],
  'scene-invite': [['label', 'Label'], ['headline', 'Headline'], ['cta', 'Call to action'], ['status', 'Status']],
};
const FOOTAGE_LAYOUTS = ['full-bleed', 'photo-hero', 'signal', 'scene-context', 'scene-story'];
const listFor = slot => `dl-${['status_label', 'footer_label'].includes(slot) ? 'label' : slot}`;
const vertical = fmt => fmt === 'story';

let brand, tracks, clips, approved, fixer, spec, mr, report;
let sel = 0, playing = false, T = 0, approvals = {}, approvedHash = null, busy = false;
let actx, buffers = {}, source = null, gain = null, t0 = 0, onEnded = null;
const screen = $('#screen');
const videos = {};          // `${sceneIndex}:${clip}` -> <video>

// ---------- footage ----------
async function videoFor(i, name) {
  const key = `${i}:${name}`;
  if (!videos[key]) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.loop = false;
    v.src = `../${clips[name].file}`;
    videos[key] = v;
    await new Promise(res => { if (v.readyState >= 2) res(); else v.addEventListener('loadeddata', res, { once: true }); });
  }
  return videos[key];
}

async function mediaFor(s) {
  const els = {};
  for (const sc of timeline(s, tracks).scenes) if (sc.clip && !sc.continuous) els[sc.index] = await videoFor(sc.index, sc.clip.name);
  return els;
}

function pauseAll() { for (const v of Object.values(videos)) v.pause(); }

// ---------- spec ----------
async function loadPreset(v) {
  if (v === 'blank') {
    await setSpec({
      id: `video-${Date.now().toString(36)}`, title: 'New video post', kind: 'video', format: 'feed', fps: 24, music: 'chronolith-a',
      content: { footer_label: 'OPERATIONS / PERSPECTIVE' },
      scenes: [
        { layout: 'full-bleed', beats: 16, textIn: 4, clip: { name: 'concourse-walk', in: 0 }, content: { label: 'SONDERLINE PULSE', headline: 'Every site. One view.' } },
        { layout: 'type-led', beats: 20, field: 'lavender', flow: true, flowStyle: 'contour', content: { label: 'SONDERLINE PULSE', headline: 'Meet Pulse.', cta: 'Request a Pulse demo.' } },
      ],
      caption: '', alt: '',
    });
  } else await setSpec(await fetch(v).then(r => r.json()));
}

async function setSpec(s) {
  stop();
  spec = structuredClone(s);
  sel = 0; T = 0;
  build();
  await refresh();
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const els = await mediaFor(spec);
    mr = new MotionRenderer(brand, spec, tracks, { video: i => els[i] || null, live: false });
    await mr.prepare();
    report = await mr.check();
    $('#json').value = JSON.stringify(spec, null, 2);
    const tl = mr.tl;
    $('#meta').textContent = `${FORMATS[spec.format]} · ${tl.total.toFixed(1)}s · ${tl.scenes.length} scenes · ${tl.bpm.toFixed(1)} bpm`;
    $('#sceneMeta').textContent = `${tl.scenes.length} scenes, ${tl.scenes.reduce((a, s2) => a + s2.beats, 0)} beats`;
    $('#lanes').replaceChildren(...tl.scenes.map((sc, i) => el('div', {
      class: `${report.scenes[i].status}${i === sel ? ' on' : ''}`, style: `flex:${sc.dur}`,
      title: `${i + 1}: ${LAYOUTS[sc.layout] || sc.layout}, ${sc.beats} beats`,
      onclick: () => { selectScene(i); seek(sc.start + sc.dur * 0.6); },
    }, `${i + 1} · ${sc.beats}`)));
    renderChecks();
    renderGates();
    T = Math.min(T, tl.total);
    await draw();
  } finally { busy = false; }
}

let timer;
function changed(rebuild = false) {
  if (rebuild) build();
  clearTimeout(timer);
  timer = setTimeout(refresh, 250);
}

// ---------- editor ----------
function build() {
  $('#format').replaceChildren(...Object.entries(FORMATS).map(([k, v]) => el('option', { value: k, selected: spec.format === k }, v)));
  $('#music').replaceChildren(
    ...Object.entries(tracks).map(([k, v]) => el('option', { value: k, selected: spec.music === k }, `${k === 'chronolith-a' ? 'Excerpt A' : 'Excerpt B'} · ${v.bpm.toFixed(1)} bpm`)),
    el('option', { value: '', selected: !spec.music }, 'No music'));
  $('#musicNote').textContent = spec.music ? `${tracks[spec.music].mood}. ${tracks[spec.music].bars} bars.` : 'No music: the video still has to read with the sound off.';
  $('#caption').value = spec.caption || '';
  $('#alt').value = spec.alt || '';
  $('#addLayout').replaceChildren(...Object.entries(LAYOUTS).map(([k, v]) => el('option', { value: k }, v)));
  const clipNames = Object.keys(clips).filter(n => (clips[n].aspect === '9:16') === vertical(spec.format));

  $('#scenes').replaceChildren(...spec.scenes.map((sc, i) => {
    const body = el('div', { class: 'body' });
    body.append(el('div', { class: 'row2' },
      el('label', {}, 'Layout', el('select', { onchange: e => { sc.layout = e.target.value; fillRequired(sc, i); changed(true); } },
        Object.entries(LAYOUTS).map(([k, v]) => el('option', { value: k, selected: sc.layout === k }, v)))),
      el('label', {}, 'Length', el('select', { onchange: e => { sc.beats = +e.target.value; changed(); } },
        [2, 4, 6, 8, 12, 16, 20].map(b => el('option', { value: b, selected: sc.beats === b }, `${b} beats`))))));
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
    if (i === 0) body.append(el('label', {}, 'Type appears', el('select', { onchange: e => { sc.textIn = +e.target.value; changed(); } },
      [[0.5, 'at the start'], [2, 'after 2 beats'], [4, 'on bar 2 (the drop)']].map(([v, l]) => el('option', { value: v, selected: (sc.textIn ?? 0.5) === v }, l)))));
    if (i > 0 && sc.clip) body.append(el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: !!sc.continuous, onchange: e => { sc.continuous = e.target.checked; changed(); } }),
      'Continue the previous scene\'s footage'));
    if (['contour-title', 'type-led', 'signal'].includes(sc.layout)) {
      const opts = sc.layout === 'signal' ? ['white', 'lavender', 'coolgrey'] : ['black', 'lavender', 'white', 'coolgrey'];
      body.append(el('label', {}, 'Field', el('select', { onchange: e => { sc.field = e.target.value; changed(); } },
        opts.map(v => el('option', { value: v, selected: (sc.field || opts[sc.layout === 'type-led' ? 1 : 0]) === v }, v)))));
    }
    if (sc.layout === 'photo-hero') body.append(el('label', {}, 'Accent panel', el('select', { onchange: e => { sc.accent = e.target.value; changed(); } },
      ['lavender', 'coolgrey'].map(v => el('option', { value: v, selected: (sc.accent || 'lavender') === v }, v)))));
    if (FOOTAGE_LAYOUTS.includes(sc.layout)) {
      body.append(el('label', {}, 'Footage', el('select', {
        onchange: e => { sc.clip = e.target.value ? { name: e.target.value, in: 0 } : undefined; delete sc.continuous; changed(true); },
      }, el('option', { value: '' }, 'none'), clipNames.map(n => el('option', { value: n, selected: sc.clip?.name === n }, n)))));
      if (sc.clip && clips[sc.clip.name]) {
        const c = clips[sc.clip.name];
        body.append(el('p', { class: 'fine' }, c.note));
        if (!sc.continuous) {
          const [lo, hi] = c.safe_window;
          body.append(el('div', { class: 'slider' }, 'Start at', el('input', { type: 'range', min: lo, max: Math.max(lo, hi - 1), step: 0.1, value: sc.clip.in || 0,
            oninput: e => { sc.clip.in = +e.target.value; sc.clip.out = hi; e.target.nextSibling.textContent = `${(+e.target.value).toFixed(1)}s`; changed(); } }),
          el('span', {}, `${(sc.clip.in || 0).toFixed(1)}s`)));
        }
        body.append(el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: sc.overlay !== false, onchange: e => { sc.overlay = e.target.checked ? undefined : false; changed(); } }),
          'Contour lines over the footage'));
      }
    }
    const move = d => () => { const j = i + d; if (j < 0 || j >= spec.scenes.length) return; [spec.scenes[i], spec.scenes[j]] = [spec.scenes[j], spec.scenes[i]]; changed(true); };
    return el('div', { class: `scene${i === sel ? ' sel' : ''}` },
      el('header', { onclick: e => { if (e.target.tagName !== 'BUTTON') { selectScene(i); const s2 = mr?.tl.scenes[i]; if (s2) seek(s2.start + s2.dur * 0.6); } } },
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
    sc.content[slot] = slot === 'signal' ? (signals.includes(sc.content.headline) ? sc.content.headline : signals[i % signals.length]) : candidates(brand, slot)[0];
  }
  if (FOOTAGE_LAYOUTS.includes(sc.layout) && !sc.clip) {
    const name = Object.keys(clips).find(n => (clips[n].aspect === '9:16') === vertical(spec.format) && n.startsWith(sc.layout === 'signal' ? 'metal' : 'concourse'));
    if (name) sc.clip = { name, in: 0 };
  }
  if (!FOOTAGE_LAYOUTS.includes(sc.layout)) { delete sc.clip; delete sc.continuous; }
}

function selectScene(i) {
  sel = i;
  document.querySelectorAll('.scene').forEach((n, j) => n.classList.toggle('sel', j === i));
  document.querySelectorAll('.lanes div').forEach((n, j) => n.classList.toggle('on', j === i));
}

// ---------- checks and approvals ----------
function fixButtons(fixes) {
  if (!fixes.length) return null;
  return el('div', { class: 'fixes' }, el('span', { class: 'fixhead' }, 'Fix:'), fixes.map(f => el('button', {
    class: 'fix', onclick: async e => { e.currentTarget.disabled = true; const msg = await f.run(); if (msg) $('#exportStatus').textContent = msg; },
  }, f.hint ? el('small', {}, `${f.hint} `) : null, f.label)));
}

function sceneFixes(c, s, i) {
  const sc = spec.scenes[i];
  if (sc.clip && ['contrast', 'photo'].includes(c.id)) {
    return Object.keys(clips).filter(n => n !== sc.clip.name && (clips[n].aspect === '9:16') === vertical(spec.format))
      .map(n => ({ label: `Use the ${n} footage`, run: () => { sc.clip = { name: n, in: 0 }; changed(true); } }));
  }
  return fixer.forCheck(c, { fmt: spec.format, layout: s.layout, frameIndex: i });
}

function renderChecks() {
  const order = ['pass', 'review', 'fail'];
  const worst = [...report.scenes.map(s => s.status), report.copy.status].reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), 'pass');
  $('#overall').className = `chip ${worst}`; $('#overall').textContent = worst;
  $('#checks').replaceChildren(...report.scenes.map((s, i) => {
    const bad = s.checks.filter(c => c.status !== 'pass');
    const note = spec.scenes[i].reviewNote;
    return el('details', { class: 'scenecheck', open: s.status === 'fail' },
      el('summary', {}, el('b', { class: `chip ${s.status}` }, s.status), `Scene ${i + 1} · ${LAYOUTS[s.layout] || s.layout}`),
      el('ul', { class: 'checks' },
        (bad.length ? bad : [{ status: 'pass', title: 'All checks pass', detail: `${s.checks.length} checks at the start, middle and end of the scene.` }]).map(c =>
          el('li', { class: c.status }, el('span', { class: 'i' }, ICON[c.status]),
            el('div', {}, c.title, c.page ? el('span', { class: 'muted' }, ` · guide p${String(c.page).padStart(2, '0')}`) : null, el('small', {}, c.detail),
              c.gate ? el('span', { class: 'gate' }, `→ ${c.gate}`) : null,
              c.status === 'pass' ? null : fixButtons(sceneFixes(c, s, i))))),
        note ? el('li', { class: 'review' }, el('span', { class: 'i' }, '!'), el('div', {}, 'Designer review', el('small', {}, note), el('span', { class: 'gate' }, '→ Designer'))) : null));
  }));
  $('#copyChecks').replaceChildren(...report.copy.checks.map(c => el('li', { class: c.status }, el('span', { class: 'i' }, ICON[c.status]),
    el('div', {}, c.title, el('small', {}, c.detail), c.gate ? el('span', { class: 'gate' }, `→ ${c.gate}`) : null, fixButtons(fixer.forCopy(c))))));
}

function specHash() { const { request, ...rest } = spec; return JSON.stringify(rest); }

function renderGates() {
  const h = specHash();
  if (approvedHash && approvedHash !== h && Object.keys(approvals).length) {
    approvals = {};
    $('#exportStatus').textContent = 'Approvals were cleared because the video changed after it was approved.';
  }
  approvedHash = h;
  const all = [...report.scenes.flatMap(s => s.checks), ...report.copy.checks];
  const blocked = all.some(c => c.status === 'fail');
  const gates = [
    { id: 'designer', who: 'Designer', why: 'Pacing, footage choices and how the edit carries the message.' },
    { id: 'brand', who: 'Brand lead', why: 'Final approval, including the proposed Contour graphic, the footage and the music.' },
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
  $('#record').disabled = !ready;
  if (blocked) $('#exportStatus').textContent = 'Blocked: fix the failing checks before anyone can approve.';
  else if (!ready) $('#exportStatus').textContent = `Needs approval from: ${gates.filter(g => !approvals[g.id]).map(g => g.who).join(', ')}.`;
  else $('#exportStatus').textContent = 'Ready to record.';
}

// ---------- playback ----------
let drawing = false;
async function draw() {
  if (!mr || drawing) return;
  drawing = true;
  try {
    const { scene } = await mr.frameAt(T, screen);
    const beat = Math.floor((T - scene.start) / mr.tl.beat) + 1;
    $('#clock').textContent = `${T.toFixed(1)}s / ${mr.tl.total.toFixed(1)}s · scene ${scene.index + 1} · beat ${beat}`;
    $('#scrub').value = Math.round((T / mr.tl.total) * 1000);
    if (scene.index !== sel && playing) selectScene(scene.index);
  } finally { drawing = false; }
}

async function audioFor(name) {
  if (!name) return null;
  actx ||= new AudioContext();
  if (!buffers[name]) buffers[name] = await actx.decodeAudioData(await fetch(`../${tracks[name].file}`).then(r => r.arrayBuffer()));
  return buffers[name];
}

async function play(dest = null) {
  if (playing || !mr) return;
  actx ||= new AudioContext();
  await actx.resume();
  if (T >= mr.tl.total - 0.05) T = 0;
  const buf = ($('#sound').checked || dest) ? await audioFor(spec.music) : null;
  mr.media.live = true;
  t0 = actx.currentTime + 0.08 - T;
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
  const tick = async () => {
    if (!playing) return;
    T = Math.max(0, actx.currentTime - t0);
    if (T >= mr.tl.total) { T = mr.tl.total - 1e-3; await draw(); stop(); onEnded?.(); return; }
    await draw();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stop() {
  playing = false;
  $('#play').textContent = 'Play';
  try { source?.stop(); } catch {}
  source = null;
  pauseAll();
  if (mr) mr.media.live = false;
}

async function seek(t) { const was = playing; stop(); T = Math.max(0, Math.min(mr.tl.total - 1e-3, t)); await draw(); if (was) play(); }

// ---------- export ----------
async function record() {
  stop(); T = 0; await draw();
  const stream = screen.captureStream(mr.fps);
  actx ||= new AudioContext();
  const dest = actx.createMediaStreamDestination();
  const outTracks = [...stream.getVideoTracks()];
  if (spec.music) outTracks.push(...dest.stream.getAudioTracks());
  const mime = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
    .find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  if (!mime) { $('#exportStatus').textContent = 'This browser cannot record video. Use tools/produce_video.py for an MP4.'; return; }
  const rec = new MediaRecorder(new MediaStream(outTracks), { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const a = el('a', { href: URL.createObjectURL(new Blob(chunks, { type: mime.split(';')[0] })), download: `${spec.id}.${ext}` });
    document.body.append(a); a.click(); a.remove();
    const log = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify({ spec, report, approvals: Object.values(approvals), exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' })), download: `${spec.id}-approvals.json` });
    document.body.append(log); log.click(); log.remove();
    $('#exportStatus').textContent = `Saved ${spec.id}.${ext} and its approval record.`;
    $('#record').disabled = false;
  };
  $('#record').disabled = true;
  $('#exportStatus').textContent = `Recording ${mr.tl.total.toFixed(1)} seconds in real time…`;
  onEnded = () => { onEnded = null; setTimeout(() => rec.stop(), 150); };
  rec.start(250);
  await play(dest);
}

// ---------- start ----------
brand = await loadBrand('..');
[tracks, clips] = await Promise.all([fetch('../assets/music/tracks.json').then(r => r.json()), fetch('../assets/video/clips.json').then(r => r.json())]);
approved = approvedSet(brand.copy);
for (const slot of ['headline', 'lead', 'cta', 'status', 'label', 'signal']) {
  document.body.append(el('datalist', { id: `dl-${slot}` }, candidates(brand, slot).map(t => el('option', { value: t }))));
}
fixer = makeFixer({
  brand, getSpec: () => spec, targetFor: i => spec.scenes[i],
  commit: rebuild => changed(rebuild),
  setBusy: msg => { $('#exportStatus').textContent = msg; },
});
$('#preset').addEventListener('change', e => loadPreset(e.target.value));
$('#format').addEventListener('change', e => {
  spec.format = e.target.value;
  // swap footage to the matching orientation
  for (const sc of spec.scenes) if (sc.clip) {
    const want = vertical(spec.format), cur = clips[sc.clip.name];
    if ((cur.aspect === '9:16') !== want) {
      const base = sc.clip.name.replace('-vertical', '');
      const alt = want ? `${base}-vertical` : base;
      sc.clip = { ...sc.clip, name: clips[alt] ? alt : Object.keys(clips).find(n => (clips[n].aspect === '9:16') === want), in: 0 };
    }
  }
  changed(true);
});
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
window.videoStudio = { get spec() { return spec; }, get report() { return report; }, get mr() { return mr; }, get T() { return T; } };
