"""Video production: video spec -> MP4 (H.264 + AAC music) via the motion engine, frame by frame.

    ~/.venvs/playwright/bin/python tools/produce_video.py studio/specs/d4-launch-video.json [--out deliverables]

Writes <out>/<id>/<id>.mp4, a poster (held frame) per scene, and a validation report in which
every scene was checked at the start, middle and end of its move.
"""
import argparse
import base64
import json
import pathlib
import subprocess
import tempfile

from playwright.sync_api import sync_playwright

from produce import ROOT, serve


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("specs", nargs="+")
    ap.add_argument("--out", default="deliverables")
    args = ap.parse_args()
    httpd = serve()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for spec_path in args.specs:
            rel = pathlib.Path(spec_path).resolve().relative_to(ROOT / "studio")
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{httpd.server_address[1]}/studio/video.html?spec={rel.as_posix()}")
            page.wait_for_function("window.__video", timeout=300_000)
            v = page.evaluate("({error: window.__video.error, total: window.__video.total, fps: window.__video.fps, seconds: window.__video.seconds, bpm: window.__video.bpm, music: window.__video.music, spec: window.__video.spec, copy: window.__video.copy})")
            if v.get("error"):
                raise SystemExit(f"{spec_path}: {v['error']}")
            spec = v["spec"]
            out = ROOT / args.out / spec["id"]
            out.mkdir(parents=True, exist_ok=True)
            print(f"{spec['id']}: {v['seconds']:.2f}s, {v['total']} frames at {v['fps']} fps, {v['bpm']} bpm, music: {spec.get('music') or 'none'}")
            report = {"spec": spec["id"], "seconds": v["seconds"], "bpm": v["bpm"], "copy": v["copy"], "scenes": {}}
            for h in page.evaluate("window.__video.held()"):
                (out / f"{h['name']}.png").write_bytes(base64.b64decode(h["png"].split(",", 1)[1]))
                report["scenes"][h["name"]] = h["report"]
                flags = [f"{c['id']}:{c['status']}" for c in h["report"]["checks"] if c["status"] != "pass"]
                print(f"  {h['name']} {h['report']['layout']:<14} {h['report']['status'].upper():<6} {' '.join(flags)}")
            print(f"  copy      {v['copy']['status'].upper()}")
            with tempfile.TemporaryDirectory() as tmp:
                for i in range(v["total"]):
                    data = page.evaluate(f"window.__video.frame({i})")
                    (pathlib.Path(tmp) / f"f{i:05d}.jpg").write_bytes(base64.b64decode(data.split(",", 1)[1]))
                mp4 = out / f"{spec['id']}.mp4"
                cmd = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(v["fps"]), "-i", f"{tmp}/f%05d.jpg"]
                if v["music"]:
                    fade = max(0.0, v["seconds"] - 1.6)
                    cmd += ["-i", str(ROOT / v["music"]), "-af", f"afade=t=out:st={fade:.2f}:d=1.6", "-c:a", "aac", "-b:a", "192k", "-shortest"]
                cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "slow", "-movflags", "+faststart",
                        "-t", f"{v['seconds']:.3f}", str(mp4)]
                subprocess.run(cmd, check=True)
            page.close()
            (out / "report.json").write_text(json.dumps(report, indent=2))
            (out / "caption.md").write_text(f"# {spec['title']}\n\n## Caption\n{spec.get('caption', '')}\n\n## Alt text\n{spec.get('alt', '')}\n\n## Music\n{spec.get('music') or 'none'}: excerpt of a track supplied by Jon Toews.\n\n## Footage\nGenerated from the supplied stills with Google Veo 3.1 Fast (AI-generated, fictional).\n")
            (out / "spec.json").write_text(json.dumps(spec, indent=2))
            print(f"  wrote {mp4.relative_to(ROOT)} ({mp4.stat().st_size / 1e6:.1f} MB)")
        browser.close()
    httpd.shutdown()


if __name__ == "__main__":
    main()
