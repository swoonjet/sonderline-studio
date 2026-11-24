---
name: sonderline
description: Make, check or plan Sonderline brand assets (social posts in any format, carousels, video posts, presentation decks, Figma templates) and answer Sonderline brand questions, using the Sonderline social content system in ~/Projects/sonderline-pulse-studio. Use whenever a request mentions Sonderline, Pulse (Sonderline's product), the Social, Video or Deck Studio, or the Sonderline Figma kit.
---

# /sonderline: Sonderline brand assets

Sonderline is a fictional enterprise operations brand (supplied by SketchDeck). Its product is **Sonderline Pulse**. Everything is produced by one system: brand rules as data, a canvas layout engine, an automated checker, and named human approval.

Project: `~/Projects/sonderline-pulse-studio` (live at https://jontoews.com/sonderline-studio/). Run commands from the project root.

## Rules that never bend
1. **Copy comes from `rules/copy-library.json`.** Never invent capabilities, performance numbers, customer names or testimonials (guide p13). If a brief needs a line the library doesn't have, use the closest approved line and tell the user the gap is for product marketing. Pulse is pre-launch: "Early-access pilots planned for Q1 2027."
2. **Never hand-edit renders.** Change the spec and re-run. If a rule must change, change `rules/*.json` and say why.
3. **Logos only from the supplied files** in `brand-kit/assets/` (they include h/2 clearspace). Never redraw, recolour or stretch.
4. **Colour:** black #000000, white #FFFFFF, lavender #E2CBFF, vermilion #FF6242 (≤5% of a layout; never a full field), cool grey #DADDE3. Black text on light and accent fields; white text only on black or photography. Contrast at least 4.5:1, measured.
5. **Type:** Inter Tight Regular 400 and Bold 700 only. Headlines in Regular.
6. **Contour** (the flow graphic) is a proposal, not Sonderline's own. Any output that uses it needs brand-lead confirmation.
7. **Photography and footage** are fictional and AI-generated (the two supplied stills, and clips generated from them). Disclose this. Clip `concourse-stream` is only usable from 0 to 3.95 s.
8. **Writing about the work:** plain language. No two-part taglines, no "X, not Y" constructions, no pithy headlines in our own copy.

## Specs
A spec is JSON in `studio/specs/`. Look at the existing ones before writing a new one:
- **Still post in several formats:** `d1-early-access.json` (layout + formats + photo + content + caption + alt).
- **Carousel:** `d2-site-signals.json` (`frames`, each with its own layout and content).
- **Deck:** `d6-pilot-deck.json` (`kind: "deck"`, `formats: ["slide"]`, frames with `notes`).
- **Video:** `d4-launch-video.json` (`kind: "video"`, `format`, `fps: 24`, `music`, `scenes` measured in `beats`, each with a `clip` from `assets/video/clips.json`).

Layouts (engine `studio/js/engine.js`): `photo-hero`, `full-bleed`, `type-led`, `signal`, `signal-grid`, `contour-title`, `scene-context`, `scene-story`, `scene-invite`. Formats (`rules/formats.json`): `feed` 1080×1350, `square` 1080×1080, `link` 1200×628, `story` 1080×1920 (safe zones top 250 / bottom 340), `slide` 1920×1080.

Video timing: music excerpts in `assets/music/tracks.json` start on a bar line (beat = 0.485387 s). Open with a quiet bar and bring the headline in on the drop (`textIn: 4` on scene 1). Use one bar or more per signal word, and two bars or more for any scene with an info panel.

## Produce and check
```bash
~/.venvs/playwright/bin/python tools/produce.py studio/specs/<spec>.json [--out out/<dir>]      # stills, carousels, slides: PNGs + report.json + caption.md
~/.venvs/playwright/bin/python tools/produce_deck.py studio/specs/<deck>.json                     # + editable .pptx and .pdf
~/.venvs/playwright/bin/python tools/produce_video.py studio/specs/<video>.json                   # MP4 with music, per-scene checks
python3 tools/stamp_media.py                                                                       # after replacing media on the site
```
Every output gets a check report: **pass**, **review** (names who decides: designer, product marketing or brand lead) or **fail** (blocked). Fix failures through the spec, for example a shorter approved line, another layout, or a different crop or clip. The Studios offer one-click versions of these fixes. Look at every render yourself before calling it done.

Regression before publishing engine changes:
```bash
~/.venvs/playwright/bin/python tools/produce.py studio/specs/_matrix/m-*.json --out out/matrix   # 420 renders, expect 0 FAIL
```

## Interactive tools (for people)
- `studio/` Social Studio: brief, spec, renders, checks, approvals, zip.
- `video/` Video Studio: scenes in beats, preview with music, MP4 recording.
- `deck/` Deck Studio: slides, notes, editable PowerPoint and PDF.

Serve locally with `python3 -m http.server 8000` from the project root.

## Figma
`figcraft/sonderline-brand-kit.figcraft`: foundations (colour variables, Inter Tight text styles, logo and clearspace), components (logo set, footer bar, info row variants, CTA, signal item, photo frame, Contour), templates at real sizes, and examples. Rebuild it headless with `python3 figcraft/build_kit.py --fresh` (close the file in FigCraft first). Open it with `figcraft/start.sh`.

## Delivering
Copy finished files to `~/Downloads`, open them, and send them with SendUserFile (make a copy under 30 MB for large videos). Publishing to the live site is `git push` on `main` in the project (GitHub Pages). Only push when the user asks, and wait for the Pages build before regenerating `docs/sonderline-system-overview.pdf` from the live page.
