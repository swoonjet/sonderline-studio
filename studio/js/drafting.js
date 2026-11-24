// Brief -> spec. Two drafters behind one interface:
//   draftWithClaude(): Claude via the Messages API, using a key the viewer pastes (kept in memory only).
//   draftOffline():    a small rules-based drafter, so the studio always works without a key.
// Both only *choose*: approved lines, layout, photo and crop. The engine does the rest.

const MODEL = 'claude-opus-5-5';

export function carouselFrames(content, photoId = 'material-study') {
  const signals = ['Site activity', 'Service requests', 'Escalations', 'Team updates'];
  const fields = ['white', 'lavender', 'coolgrey', 'white'];
  return [
    { layout: 'type-led', field: 'lavender', flow: true, flowSeed: 11,
      content: { label: 'SONDERLINE PULSE / PRODUCT PERSPECTIVE', headline: content.headline || 'Site signals.', lead: 'One consolidated view across your locations.', cta: content.cta || 'Request a Pulse demo.' } },
    ...signals.map((signal, i) => ({
      layout: 'signal', field: fields[i], index: `0${i + 1} / 04`,
      photo: { id: photoId, focus: [0.12 + i * 0.253, 0.5], zoom: 1.6 },
      content: { label: 'THE OPERATIONAL VIEW', signal },
    })),
    { layout: 'photo-hero', photo: null, flow: true, flowSeed: 5, accent: 'coolgrey',
      content: { headline: 'Keep the details connected.', label: 'SONDERLINE PULSE', lead: content.lead || 'For organizations managing multiple locations.', cta: content.cta || 'Request a Pulse demo.', status_label: 'PILOT STATUS', status: 'Early-access pilots planned for Q1 2027.' } },
  ];
}

function toSpec(d, request, source) {
  const spec = {
    id: `draft-${Date.now().toString(36)}`,
    title: d.title,
    request,
    formats: d.layout === 'carousel' ? ['feed'] : d.formats,
    content: { footer_label: d.content.footer_label || 'OPERATIONS / PERSPECTIVE' },
    caption: d.caption,
    alt: d.alt,
    draftedBy: source,
  };
  if (d.layout === 'carousel') spec.frames = carouselFrames(d.content, d.photo.id);
  else Object.assign(spec, {
    layout: 'photo-hero', scrim: 'auto', accent: d.accent,
    photo: { id: d.photo.id, focus: [d.photo.focus_x, d.photo.focus_y], zoom: 1 },
    content: { ...d.content },
  });
  return spec;
}

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'rationale', 'layout', 'formats', 'photo', 'accent', 'content', 'caption', 'alt', 'copy_gaps'],
  properties: {
    title: { type: 'string' },
    rationale: { type: 'string' },
    layout: { type: 'string', enum: ['photo-hero', 'carousel'] },
    formats: { type: 'array', items: { type: 'string', enum: ['feed', 'square', 'link', 'story'] } },
    photo: {
      type: 'object', additionalProperties: false, required: ['id', 'focus_x', 'focus_y'],
      properties: { id: { type: 'string', enum: ['motion-study', 'material-study'] }, focus_x: { type: 'number' }, focus_y: { type: 'number' } },
    },
    accent: { type: 'string', enum: ['lavender', 'coolgrey'] },
    content: {
      type: 'object', additionalProperties: false,
      required: ['headline', 'label', 'lead', 'cta', 'status_label', 'status', 'footer_label'],
      properties: Object.fromEntries(['headline', 'label', 'lead', 'cta', 'status_label', 'status', 'footer_label'].map(k => [k, { type: 'string' }])),
    },
    caption: { type: 'string' },
    alt: { type: 'string' },
    copy_gaps: { type: 'array', items: { type: 'string' } },
  },
};

function systemPrompt(brand) {
  return `You are the drafting step in Sonderline's social content system. You turn a creative brief into a production spec. A deterministic layout engine renders the spec and a validator checks it, so you only make choices.

Brand voice: Straightforward. Human. Useful. Specific, human and direct.

Hard rules (Sonderline Brand Guide 8.0, p13):
- On-image text must be copied verbatim from the approved library below. Pick the lines that best serve the brief.
- Never invent capabilities, performance numbers, customer names or testimonials. Keep product status intact: Pulse is pre-launch, with early-access pilots planned for Q1 2027.
- The caption should be built from approved sentences. If the brief needs something the library cannot say, use the closest approved line and record the need in copy_gaps so Product marketing can decide. Do not write the new claim yourself.
- Labels (label, status_label, footer_label) come from the approved labels list and are uppercase.

Layouts:
- photo-hero: one message over a photo, then an info row (label, lead, CTA; plus status label and status in an accent panel) and a black footer. Use it for announcements and single-message posts. Pick formats from feed, square, link, story based on the channels in the brief.
- carousel: a 6-frame explainer (cover, the four Pulse signals one per frame, closing invitation). Use it when the brief asks to explain or walk through what Pulse does. The headline you choose goes on the cover.

Photos (fictional, supplied with the kit):
- motion-study: a figure in a dark coat moving through the left third of a glass concourse, blurred by motion; bright, quiet right side. Partial human presence; good for people and operations stories.
- material-study: an extreme close-up of ribbed brushed aluminium, with a dark curved shadow lower left and bright silver upper right. Good for structure, systems and product stories.
focus_x and focus_y (0 to 1) are the point of the photo to keep centred in the crop. The headline sits top left, so favour crops where the top left is darker.

accent: lavender by default; coolgrey for quieter, more operational messages.
alt: plain description of the image and every word on it, under 300 characters, with no claims.

Approved library (JSON):
${JSON.stringify({ lines: brand.copy.lines.map(l => l.text), labels: brand.copy.labels, product: brand.copy.product }, null, 1)}`;
}

export async function draftWithClaude(brand, request, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: systemPrompt(brand),
      messages: [{ role: 'user', content: `Brief from ${request.requester || 'the team'} for ${request.channel || 'social'}:\n\n${request.brief}` }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `API error ${res.status}`);
  if (body.stop_reason === 'refusal') throw new Error('Claude declined this brief. Rephrase it or draft the spec by hand.');
  if (body.stop_reason === 'max_tokens') throw new Error('The draft was cut off. Try again.');
  const text = body.content.find(b => b.type === 'text')?.text;
  const d = JSON.parse(text);
  const spec = toSpec(d, request, { by: `Claude (${body.model || MODEL})`, rationale: d.rationale, copy_gaps: d.copy_gaps });
  return spec;
}

// Rules-based fallback: keyword routing + approved lines only. Clearly labelled as not AI.
export function draftOffline(brand, request) {
  const b = (request.brief || '').toLowerCase();
  const has = (...w) => w.some(x => b.includes(x));
  const carousel = has('carousel', 'explain', 'walk through', 'swipe', 'what pulse does', 'capabilit');
  const formats = [];
  if (has('feed', 'linkedin', 'instagram', 'post')) formats.push('feed');
  if (has('square', 'instagram')) formats.push('square');
  if (has('link', 'ad', 'banner', 'paid')) formats.push('link');
  if (has('story', 'stories', 'reel')) formats.push('story');
  const content = {
    headline: has('meet', 'launch', 'announce', 'introduc') ? 'Meet Pulse.'
      : has('progress') ? 'Progress, in view.'
      : has('connect', 'detail') ? 'Keep the details connected.'
      : carousel ? 'Site signals.' : 'Every site. One view.',
    label: 'SONDERLINE PULSE',
    lead: has('every location', 'locations', 'multi-site', 'multiple') ? 'A clearer view across every location.' : 'A clearer view across locations.',
    cta: 'Request a Pulse demo.',
    status_label: has('pilot', 'early') ? 'EARLY ACCESS' : 'PILOT STATUS',
    status: 'Pilots planned for Q1 2027.',
    footer_label: 'OPERATIONS / PERSPECTIVE',
  };
  const people = has('team', 'people', 'leader', 'human');
  const d = {
    title: request.title || (carousel ? 'Pulse explainer carousel' : `${content.headline.replace(/\.$/, '')}: social post`),
    layout: carousel ? 'carousel' : 'photo-hero',
    formats: formats.length ? formats : ['feed', 'square'],
    photo: people || !carousel ? { id: 'motion-study', focus_x: 0.3, focus_y: 0.5 } : { id: 'material-study', focus_x: 0.5, focus_y: 0.5 },
    accent: has('operational', 'quiet') ? 'coolgrey' : 'lavender',
    content,
    caption: `${content.headline} ${brand.copy.product.description} ${brand.copy.product.audience} Early-access pilots planned for Q1 2027. Request a Pulse demo.`,
    alt: carousel ? 'Six-frame carousel: Site activity, Service requests, Escalations and Team updates, ending with a demo request. Sonderline logo on every frame.'
      : `Black-and-white photograph with the headline ${content.headline} ${content.lead} ${content.cta} ${content.status} Sonderline logo.`,
  };
  return toSpec(d, request, { by: 'Offline drafter (rules, no AI)', rationale: 'Keyword routing to approved lines. Add a Claude key for real drafting.', copy_gaps: [] });
}
