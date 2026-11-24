// Loads the single source of truth: rules/*.json, the supplied fonts, logos and photos.
// Nothing here is hard-coded; change the JSON and every output follows.

const loadImage = src => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`Could not load ${src}`));
  img.src = src;
});

export async function loadBrand(base = '..') {
  const [tokens, copy, formats] = await Promise.all(
    ['tokens', 'copy-library', 'formats'].map(n => fetch(`${base}/rules/${n}.json`).then(r => r.json())),
  );

  const faces = [
    new FontFace(tokens.type.family, `url(${base}/${tokens.type.files.regular})`, { weight: '400' }),
    new FontFace(tokens.type.family, `url(${base}/${tokens.type.files.bold})`, { weight: '700' }),
  ];
  for (const face of await Promise.all(faces.map(f => f.load()))) document.fonts.add(face);

  const photos = {};
  for (const [id, p] of Object.entries(tokens.photography)) photos[id] = await loadImage(`${base}/${p.file}`);

  const logos = {};
  for (const k of ['lockup_white', 'lockup_black', 'symbol_white', 'symbol_black']) {
    logos[k] = await loadImage(`${base}/${tokens.logo[k]}`);
  }

  return { tokens, copy, formats, photos, logos, base };
}
