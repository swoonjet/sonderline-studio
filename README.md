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
| `studio/test/` | Regression matrix specs and the fuzz page |
| `requirements.txt` | Python packages for the command-line tools |
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

## Using it remotely
The three Studios are static web pages. Anyone on the team can use them at the links above in a current desktop browser (Chrome, Edge, Firefox or Safari), with no login or install. Everything runs in the browser; nothing is uploaded.

- **Claude drafting** is optional. Paste an Anthropic API key into the Studio's "Claude API key" field. The key stays in memory for that tab and goes only to api.anthropic.com. Without a key, the offline drafter is used and everything else works.
- **Exports** (PNG zip, MP4 video, PowerPoint, PDF) are made in the browser and downloaded directly.
- **Video recording** uses the browser's MediaRecorder: MP4 in Chrome, Edge and Safari, WebM in Firefox.

## Dependencies
**Web (loaded by the pages, nothing to install)**

| Dependency | Version | Used for | Loaded from |
|---|---|---|---|
| JSZip | 3.10.1 (MIT) | Social Studio zip export | cdnjs |
| PptxGenJS | 3.12.0 (MIT) | Deck Studio PowerPoint export | jsDelivr |
| jsPDF | 2.5.1 (MIT) | Deck Studio PDF export | cdnjs |
| Inter Tight | supplied (OFL 1.1) | All type | `brand-kit/fonts/` in this repo |
| Claude API | `claude-opus-5-5` | Live drafting (optional, the viewer's key) | api.anthropic.com |

**Command-line tools**

| Dependency | Needed for |
|---|---|
| Python 3.10+ with `requirements.txt` (Playwright, Pillow) | Every tool in `tools/` |
| Playwright's Chromium (`python -m playwright install chromium`) | Rendering, which uses the same engine as the Studios |
| ffmpeg 6+ | `produce_video.py` only |
| `OPENROUTER_API_KEY` | `gen_video_assets.py` only, which regenerates footage. Not needed to use the existing clips |
| FigCraft CLI (`FIGCRAFT_CLI` = path to `figcraft-cli`) | `figcraft/build_kit.py` only, which rebuilds the Figma kit. The built `.figcraft` file is in the repo |
| Claude Code | Only to use the `/sonderline` skill |

## Setup and commands
```bash
git clone https://github.com/swoonjet/sonderline-studio.git && cd sonderline-studio
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt && python -m playwright install chromium

python3 -m http.server 8000                                         # Studios at http://localhost:8000/studio/, /video/, /deck/
python tools/produce.py studio/specs/d1-early-access.json --strict    # stills: PNGs + check report + caption (exit 1 on FAIL)
python tools/produce_deck.py studio/specs/d6-pilot-deck.json          # deck: PNGs + editable .pptx + .pdf
python tools/produce_video.py studio/specs/d4-launch-video.json       # video: MP4 with music (needs ffmpeg)
python tools/test_regression.py                                       # 420 renders, fails on any FAIL
python tools/test_fuzz.py                                             # 3,600 random renders, fails on errors or unfixable outputs
cp -r skills/sonderline ~/.claude/skills/                             # install the Claude skill
```
Every command above has been run from a fresh clone into a new virtual environment, with no files from the author's machine.

## Sources and assumptions
- Inter Tight by Rasmus Andersson (SIL OFL 1.1), supplied with the kit.
- Photography: the two supplied images, which are fictional and AI-generated. No other imagery was used.
- Flow graphics were listed in the brief but not supplied. `rules/tokens.json → flow` defines "Contour", a proposed graphic derived from the S symbol. Any output using it is routed to the brand lead.
- Footage: generated from the supplied stills with Google Veo 3.1 Fast through OpenRouter (`assets/video/clips.json` lists each clip, its source photo and safe window).
- Music: two excerpts of a track supplied by Jon Toews (`assets/music/tracks.json` has the beat grid).
- JSZip, PptxGenJS and jsPDF (all MIT); see Dependencies.
