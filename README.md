# Sonderline Social System

A prototype AI-assisted production system for **social media content**, built for SketchDeck's *Director of AI Solutions* practical exercise. Sonderline is a fictional brand supplied by SketchDeck.

**AI makes the choices. Code places the pixels. People approve.**

- Live site: https://jontoews.com/sonderline-studio/
- Social Studio (stills): https://jontoews.com/sonderline-studio/studio/
- Video Studio (motion + music): https://jontoews.com/sonderline-studio/video/
- System overview: https://jontoews.com/sonderline-studio/docs/
- Deliverables: https://jontoews.com/sonderline-studio/deliverables/

## How it fits together
```
brief ─► drafting (Claude, or offline rules) ─► spec JSON ─► engine ─► PNG / MP4 per format
                                                               │
                         approvals ◄── review gates ◄── validator (13 guide rules on real pixels)
rules/*.json (tokens, approved copy, formats) ─► every step
```

| Path | What |
|---|---|
| `rules/` | Single source of truth: brand tokens, approved copy library, formats |
| `studio/js/engine.js` | Layout engine (canvas). 8 elastic layouts: photo-hero, type-led, signal, signal-grid, contour-title, 3 storyboard scenes |
| `studio/js/validate.js` | Brand checks on geometry and real pixels: pass / review (names who decides) / fail |
| `studio/js/drafting.js` | Brief → spec with Claude (viewer's key, memory only) or the offline rules drafter |
| `studio/index.html` | Pulse Social Studio web app |
| `studio/specs/` | Specs for every deliverable and the review example |
| `tools/produce.py` | Batch: spec(s) → PNGs + report + caption (headless Chromium, same engine) |
| `studio/js/motion.js` | Motion engine: pans, type wipe-on/hold, Contour draw-on and wipes, beat-synced scenes |
| `video/` | Pulse Video Studio web app |
| `tools/produce_video.py` | Video spec → MP4 (H.264 + AAC music), frame by frame, with per-scene checks |
| `tools/make_music.py` | Synthesises the three original music beds into `assets/music/` |
| `deliverables/`, `review/` | Outputs, reports and zips |
| `docs/` | System overview |
| `brand-kit/` | The supplied Sonderline kit (unchanged) |

## Run it locally
```bash
python3 -m http.server 8000        # then open http://localhost:8000/studio/
~/.venvs/playwright/bin/python tools/produce.py studio/specs/d1-early-access.json
~/.venvs/playwright/bin/python tools/produce_video.py studio/specs/d4-pulse-motion.json
```
Needs Python with Playwright and Pillow (and ffmpeg for video).

## Sources and assumptions
- Inter Tight by Rasmus Andersson (SIL OFL 1.1), supplied with the kit.
- Photography: the two supplied images, which are fictional and AI-generated. No other imagery was used.
- Flow graphics were listed in the brief but not supplied. `rules/tokens.json → flow` defines "Contour", a proposed graphic derived from the S symbol. Any output using it is routed to the brand lead.
- Music: original, synthesised by `tools/make_music.py` (no samples).
- JSZip 3.10.1 (MIT) from cdnjs for the Studio's zip export.
