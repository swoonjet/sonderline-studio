"""Video production: spec -> MP4 (H.264) via the same engine, frame by frame.

    ~/.venvs/playwright/bin/python tools/produce_video.py studio/specs/d4-pulse-motion.json [--out deliverables]

Writes <out>/<id>/<id>.mp4, a poster per scene (held frame) and a validation report.
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
    ap.add_argument("spec")
    ap.add_argument("--out", default="deliverables")
    args = ap.parse_args()
    httpd = serve()
    rel = pathlib.Path(args.spec).resolve().relative_to(ROOT / "studio")
    with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(f"http://127.0.0.1:{httpd.server_address[1]}/studio/video.html?spec={rel.as_posix()}")
        page.wait_for_function("window.__video", timeout=120_000)
        total, fps = page.evaluate("[window.__video.total, window.__video.fps]")
        spec = page.evaluate("window.__video.spec")
        out = ROOT / args.out / spec["id"]
        out.mkdir(parents=True, exist_ok=True)
        print(f"{spec['id']}: {total} frames at {fps} fps")
        for i in range(total):
            data = page.evaluate(f"window.__video.frame({i})")
            (pathlib.Path(tmp) / f"f{i:05d}.jpg").write_bytes(base64.b64decode(data.split(",", 1)[1]))
        report = {"spec": spec["id"], "copy": page.evaluate("window.__video.copy"), "scenes": {}}
        for h in page.evaluate("window.__video.held()"):
            (out / f"{h['name']}.png").write_bytes(base64.b64decode(h["png"].split(",", 1)[1]))
            report["scenes"][h["name"]] = h["report"]
            flags = [f"{c['id']}:{c['status']}" for c in h["report"]["checks"] if c["status"] != "pass"]
            print(f"  {h['name']}  {h['report']['status'].upper()}  {' '.join(flags)}")
        print(f"  copy      {report['copy']['status'].upper()}")
        browser.close()
        mp4 = out / f"{spec['id']}.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-i", f"{tmp}/f%05d.jpg",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "slow",
                        "-movflags", "+faststart", str(mp4)], check=True)
    (out / "report.json").write_text(json.dumps(report, indent=2))
    (out / "caption.md").write_text(f"# {spec['title']}\n\n## Caption\n{spec.get('caption', '')}\n\n## Alt text\n{spec.get('alt', '')}\n")
    (out / "spec.json").write_text(json.dumps(spec, indent=2))
    httpd.shutdown()
    print(f"  wrote {mp4.relative_to(ROOT)} ({mp4.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
