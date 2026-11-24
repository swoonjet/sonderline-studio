# Sonderline Social System

A prototype production system for Sonderline's social media content, built for SketchDeck's Director of AI Solutions practical exercise. Sonderline is a fictional brand supplied by SketchDeck.

Claude drafts a spec from the approved copy library, a layout engine renders each format, a checker tests the output against the brand guide, and named reviewers approve it.

- Live site: https://jontoews.com/sonderline-studio/
- Social Studio (stills): https://jontoews.com/sonderline-studio/studio/
- Video Studio (motion + music): https://jontoews.com/sonderline-studio/video/
- Deck Studio (slides, PowerPoint, PDF): https://jontoews.com/sonderline-studio/deck/
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
| `studio/js/engine.js` | Layout engine (canvas). Nine layouts, including full-bleed footage, contour-title and three storyboard scenes |
| `studio/js/validate.js` | Brand checks on geometry and real pixels: pass / review (names who decides) / fail |
| `studio/js/drafting.js` | Brief → spec with Claude (viewer's key, memory only) or the offline rules drafter |
| `studio/index.html` | Pulse Social Studio web app |
| `studio/specs/` | Specs for every deliverable and the review example |
| `tools/produce.py` | Batch: spec(s) → PNGs + report + caption (headless Chromium, same engine) |
| `studio/js/motion.js` | Motion engine: footage, Contour overlays, line-by-line type reveals, dissolves on the downbeat, scenes timed in beats |
| `video/` | Pulse Video Studio web app |
| `tools/produce_video.py` | Video spec → MP4 (H.264 + AAC music), frame by frame, with per-scene checks |
| `tools/gen_video_assets.py` | Generates footage from the supplied stills (Google Veo 3.1 Fast via OpenRouter) into `assets/video/` |
| `deck/` | Pulse Deck Studio web app |
| `studio/js/export-deck.js` | Editable PowerPoint (PptxGenJS) and PDF (jsPDF) export |
| `tools/produce_deck.py` | Deck spec → PNGs, .pptx and .pdf |
| `figcraft/` | Figma brand kit built with FigCraft (`build_kit.py`, `sonderline-brand-kit.figcraft`, previews) |
| `skills/sonderline/SKILL.md` | Claude skill for making Sonderline assets (copy to `~/.claude/skills/sonderline/`) |
| `deliverables/`, `review/` | Outputs, reports and zips |
| `docs/` | System overview |
| `brand-kit/` | The supplied Sonderline kit (unchanged) |

## Run it locally
```bash
python3 -m http.server 8000        # then open http://localhost:8000/studio/
~/.venvs/playwright/bin/python tools/produce.py studio/specs/d1-early-access.json
~/.venvs/playwright/bin/python tools/produce_video.py studio/specs/d4-launch-video.json
```
Needs Python with Playwright and Pillow (and ffmpeg for video).

## Sources and assumptions
- Inter Tight by Rasmus Andersson (SIL OFL 1.1), supplied with the kit.
- Photography: the two supplied images, which are fictional and AI-generated. No other imagery was used.
- Flow graphics were listed in the brief but not supplied. `rules/tokens.json → flow` defines "Contour", a proposed graphic derived from the S symbol. Any output using it is routed to the brand lead.
- Footage: generated from the supplied stills with Google Veo 3.1 Fast through OpenRouter (`assets/video/clips.json` lists each clip, its source photo and safe window).
- Music: two excerpts of a track supplied by Jon Toews (`assets/music/tracks.json` has the beat grid).
- JSZip 3.10.1 (MIT) from cdnjs for the Studio's zip export.
