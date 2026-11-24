// Deck export: editable PowerPoint (PptxGenJS) and PDF (jsPDF) from engine-rendered slides.
// In the .pptx, colour fields, photos, scrims and graphics are one background picture per slide;
// every piece of copy is a real text box in Inter Tight at the rendered position and size, the
// logo is the supplied artwork, arrows are line shapes, and speaker notes are kept.
import { frames, render } from './engine.js';

const PX_PER_IN = 144;                       // 1920 px = 13.333 in (PowerPoint 16:9)
const inch = px => px / PX_PER_IN;
const pt = px => px * 72 / PX_PER_IN;
const hex = c => c.replace('#', '').toUpperCase();

function slideLayers(brand, fr) {
  const layers = { bg: document.createElement('canvas'), fg: document.createElement('canvas') };
  const c = document.createElement('canvas');
  const res = render(c, brand, { ...fr, layers }, 'slide');
  return { res, bg: layers.bg.toDataURL('image/png') };
}

async function pngOf(url) {
  const blob = await fetch(url).then(r => r.blob());
  return new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
}

export async function buildPptx(brand, spec, PptxGenJS, base = '..') {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';                // 13.333 × 7.5 in
  pptx.title = spec.title || 'Sonderline deck';
  pptx.company = 'Sonderline (fictional brand)';
  const logos = {
    lockup_white: await pngOf(`${base}/brand-kit/assets/sonderline_lockup_white.png`),
    lockup_black: await pngOf(`${base}/brand-kit/assets/sonderline_lockup_black.png`),
    symbol_white: await pngOf(`${base}/brand-kit/assets/sonderline_symbol_white.png`),
    symbol_black: await pngOf(`${base}/brand-kit/assets/sonderline_symbol_black.png`),
  };
  for (const fr of frames(spec)) {
    const { res, bg } = slideLayers(brand, fr);
    const slide = pptx.addSlide();
    slide.background = { data: bg };
    for (const g of res.geometry) {
      if (g.kind === 'logo') {
        slide.addImage({ data: logos[g.key], x: inch(g.x), y: inch(g.y), w: inch(g.w), h: inch(g.h), altText: 'Sonderline logo' });
      } else if (g.kind === 'arrow') {
        const y = g.y + g.h / 2;
        slide.addShape(pptx.ShapeType.line, { x: inch(g.x), y: inch(y), w: inch(g.w), h: 0, line: { color: '000000', width: 1.25, endArrowType: 'arrow' } });
      } else if (g.kind === 'text' && g.lines?.length) {
        const lineGap = g.baselines.length > 1 ? g.baselines[1] - g.baselines[0] : g.size * 1.12;
        const wPx = g.w * 1.1 + g.size * 0.6;
        const right = g.draw.align === 'right';
        const xPx = right ? g.draw.x - wPx : g.draw.x;
        const yPx = g.baselines[0] - lineGap * 0.82;
        const hPx = lineGap * g.lines.length + g.size * 0.3;
        slide.addText(g.lines.join('\n'), {
          x: inch(xPx), y: inch(yPx), w: inch(wPx), h: inch(hPx),
          fontFace: brand.tokens.type.family, fontSize: Math.round(pt(g.size) * 10) / 10, bold: g.weight >= 700,
          color: hex(g.color), align: right ? 'right' : 'left', valign: 'top', margin: 0,
          lineSpacing: Math.round(pt(lineGap) * 10) / 10, charSpacing: Math.round(pt(g.draw.ls * g.size) * 100) / 100,
          paraSpaceBefore: 0, paraSpaceAfter: 0, fit: 'none', wrap: false,
        });
      }
    }
    if (fr.notes) slide.addNotes(fr.notes);
  }
  return pptx;
}

export function buildPdf(brand, spec, jsPDF) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'px', format: [1920, 1080], hotfixes: ['px_scaling'], compress: true });
  frames(spec).forEach((fr, i) => {
    const c = document.createElement('canvas');
    render(c, brand, fr, 'slide');
    if (i > 0) doc.addPage([1920, 1080], 'landscape');
    doc.addImage(c.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 1920, 1080);
  });
  doc.setProperties({ title: spec.title || 'Sonderline deck' });
  return doc;
}
