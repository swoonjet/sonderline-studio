// Colour maths shared by the engine (scrim solving) and the validator.
// WCAG 2.2 relative luminance and contrast ratio.

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

export function luminance([r, g, b]) {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(l1, l2) {
  const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (a + 0.05) / (b + 0.05);
}

// Luminances of the pixels inside a box of an ImageData, sampled on a grid.
export function sampleLuminance(img, box, step = 3) {
  const out = [];
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.w)), y1 = Math.min(img.height, Math.ceil(box.y + box.h));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * img.width + x) * 4;
      out.push(luminance([img.data[i], img.data[i + 1], img.data[i + 2]]));
    }
  }
  return out;
}

// Worst-case contrast of a text colour against the background under it.
// Uses the 98th percentile (or 2nd for dark text) so single noisy pixels don't decide it.
export function worstContrast(lums, textHex) {
  if (!lums.length) return null;
  const t = luminance(hexToRgb(textHex));
  const sorted = [...lums].sort((a, b) => a - b);
  const pick = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const bg = t > 0.5 ? pick(0.98) : pick(0.02);
  return contrast(t, bg);
}
