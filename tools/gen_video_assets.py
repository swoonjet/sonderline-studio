"""Generate motion footage from the two supplied stills with an image-to-video model (OpenRouter).

    python3 tools/gen_video_assets.py submit     # crop the stills, submit one job per clip
    python3 tools/gen_video_assets.py collect    # poll, download, transcode to WebM (VP9) for the engine

The key comes from OPENROUTER_API_KEY, or else the ComfyUI OpenRouter node's key file. It is never printed or stored here.
Every clip starts from a supplied photograph as its first frame; prompts keep the kit's photo
direction (monochrome silver, partial human presence, no faces, no text). Clips are AI-generated
derivatives of AI-generated stills: disclose them as such.
"""
import base64
import io
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.request

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets/video"
KEY_FILE = pathlib.Path.home() / "ComfyUI/custom_nodes/ComfyUI-Openrouter_node/openrouter_api_key.json"
API = "https://openrouter.ai/api/v1/videos"
MODEL = "google/veo-3.1-fast"
STYLE = ("Monochrome silver, black and cool grey with only a faint lavender reflection; fine photographic grain; "
         "calm, observational art-book photography. Keep the exact look and composition of the first frame. "
         "No faces, no text, no logos, no new objects, no colour shift, no cuts.")

CLIPS = {
    "concourse-walk": dict(photo="motion-study", aspect="16:9", crop=(0, 80, 1536, 944), prompt=(
        "Continue this photograph as live footage. The person in the long black coat keeps walking steadily through the "
        "glass-and-steel concourse, close to the camera. The camera pans slowly sideways with them; long-exposure motion "
        "blur streaks the figure and the architecture; reflections slide across the polished floor. ")),
    "concourse-stream": dict(photo="motion-study", aspect="16:9", crop=(0, 80, 1536, 944), prompt=(
        "Continue this photograph as live footage from a locked-off camera. The figure in the black coat passes out of frame; "
        "soft blurred silhouettes of other commuters stream through the concourse as streaks of light and shadow; "
        "daylight shifts gently on the glass. ")),
    "metal-glide": dict(photo="material-study", aspect="16:9", crop=(0, 80, 1536, 944), prompt=(
        "Extreme close-up of ribbed brushed aluminium. The camera glides slowly along the ribs; daylight moves across the "
        "surface so highlights travel along the ridges and the curved black shadow slides gently. Macro, shallow focus. ")),
    "metal-sweep": dict(photo="material-study", aspect="16:9", crop=(0, 80, 1536, 944), prompt=(
        "Extreme close-up of ribbed brushed aluminium. A band of soft sunlight sweeps across the metal, as if light were "
        "passing through a moving window; the curved shadow breathes and recedes. Very slow push-in. ")),
    "concourse-walk-vertical": dict(photo="motion-study", aspect="9:16", crop=(120, 0, 696, 1024), prompt=(
        "Continue this photograph as live footage. The person in the long black coat walks steadily through the concourse, "
        "close to the camera; slow camera follow, long-exposure motion blur, reflections sliding on the floor. ")),
    "metal-glide-vertical": dict(photo="material-study", aspect="9:16", crop=(700, 0, 1276, 1024), prompt=(
        "Extreme close-up of ribbed brushed aluminium. Slow vertical camera glide along the ribs; daylight travels across the "
        "ridges and the dark curved shadow slides. Macro, shallow focus. ")),
}


def key():
    if os.environ.get("OPENROUTER_API_KEY"):
        return os.environ["OPENROUTER_API_KEY"]
    data = json.loads(KEY_FILE.read_text())
    return data.get("api_key") or next(iter(data.values()))


def call(method, url, body=None):
    req = urllib.request.Request(url, method=method, headers={"Authorization": f"Bearer {key()}", "Content-Type": "application/json"},
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def first_frame(name, spec):
    src = Image.open(ROOT / f"brand-kit/assets/photography/{spec['photo']}.png").convert("RGB")
    im = src.crop(spec["crop"])
    target = (1920, 1080) if spec["aspect"] == "16:9" else (1080, 1920)
    im = im.resize(target, Image.LANCZOS)
    (OUT / "first-frames").mkdir(parents=True, exist_ok=True)
    im.save(OUT / f"first-frames/{name}.jpg", quality=94)
    buf = io.BytesIO(); im.save(buf, "JPEG", quality=92)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def submit():
    OUT.mkdir(parents=True, exist_ok=True)
    jobs_file = OUT / "jobs.json"
    jobs = json.loads(jobs_file.read_text()) if jobs_file.exists() else {}
    for name, spec in CLIPS.items():
        if name in jobs:
            print(f"{name}: already submitted ({jobs[name]['id']})"); continue
        payload = {
            "model": MODEL, "prompt": spec["prompt"] + STYLE, "duration": 8, "resolution": "1080p",
            "aspect_ratio": spec["aspect"], "generate_audio": False, "seed": 7,
            "frame_images": [{"type": "image_url", "image_url": {"url": first_frame(name, spec)}, "frame_type": "first_frame"}],
        }
        res = call("POST", API, payload)
        jobs[name] = {"id": res["id"], "status": res.get("status"), "aspect": spec["aspect"], "photo": spec["photo"], "prompt": payload["prompt"]}
        jobs_file.write_text(json.dumps(jobs, indent=2))
        print(f"{name}: submitted {res['id']} ({res.get('status')})")


def collect():
    jobs_file = OUT / "jobs.json"
    jobs = json.loads(jobs_file.read_text())
    (OUT / "raw").mkdir(exist_ok=True)
    pending = {n for n, j in jobs.items() if not (OUT / f"{n}.webm").exists()}
    while pending:
        for name in sorted(pending):
            res = call("GET", f"{API}/{jobs[name]['id']}")
            jobs[name]["status"] = res.get("status")
            if res.get("status") == "completed":
                raw = OUT / f"raw/{name}.mp4"
                req = urllib.request.Request(f"{API}/{jobs[name]['id']}/content?index=0", headers={"Authorization": f"Bearer {key()}"})
                with urllib.request.urlopen(req, timeout=300) as r:
                    raw.write_bytes(r.read())
                # engine copy: VP9 WebM (plays in Chrome and headless Chromium), 30 fps, no audio
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-an", "-c:v", "libvpx-vp9", "-g", "24",
                                "-b:v", "0", "-crf", "36", "-row-mt", "1", "-deadline", "good", str(OUT / f"{name}.webm")], check=True)
                jobs[name]["cost"] = res.get("usage", {}).get("cost") if isinstance(res.get("usage"), dict) else None
                print(f"{name}: downloaded")
                pending.discard(name)
            elif res.get("status") in ("failed", "cancelled", "expired"):
                print(f"{name}: {res.get('status')} {str(res.get('error'))[:200]}")
                pending.discard(name)
        jobs_file.write_text(json.dumps(jobs, indent=2))
        if pending:
            print(f"waiting on {len(pending)}: {', '.join(sorted(pending))}")
            time.sleep(20)


if __name__ == "__main__":
    {"submit": submit, "collect": collect}[sys.argv[1]]()
