"""Batch production: spec(s) -> PNGs for every format/frame + validation report + caption.

Uses the same engine as the web studio (studio/render.html in headless Chromium), so CLI
and browser output are pixel-identical.

    ~/.venvs/playwright/bin/python tools/produce.py studio/specs/d1-early-access.json [more specs...] [--out deliverables]
"""
import argparse
import base64
import functools
import http.server
import json
import pathlib
import threading

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    handler = functools.partial(Quiet, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("specs", nargs="+")
    ap.add_argument("--out", default="deliverables")
    args = ap.parse_args()
    httpd = serve()
    port = httpd.server_address[1]
    worst = "pass"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.on("console", lambda m: print("  [browser]", m.text) if m.type == "error" else None)
        for spec_path in args.specs:
            rel = pathlib.Path(spec_path).resolve().relative_to(ROOT / "studio")
            page.goto(f"http://127.0.0.1:{port}/studio/render.html?spec={rel.as_posix()}")
            page.wait_for_function("window.__result", timeout=120_000)
            res = page.evaluate("window.__result")
            if "error" in res:
                raise SystemExit(f"{spec_path}: {res['error']}")
            spec = res["spec"]
            out = ROOT / args.out / spec["id"]
            out.mkdir(parents=True, exist_ok=True)
            report = {"spec": spec["id"], "copy": res["copy"], "frames": {}}
            print(f"\n{spec['id']}: {spec['title']}")
            for fr in res["frames"]:
                (out / f"{fr['name']}.png").write_bytes(base64.b64decode(fr["png"].split(",", 1)[1]))
                report["frames"][fr["name"]] = {"report": fr["report"], "notes": fr["notes"]}
                flags = [f"{c['id']}:{c['status']}" for c in fr["report"]["checks"] if c["status"] != "pass"]
                print(f"  {fr['name']:<10} {fr['report']['status'].upper():<6} {' '.join(flags)}  {' '.join(fr['notes'])}")
                worst = max(worst, fr["report"]["status"], key=["pass", "review", "fail"].index)
            c = res["copy"]
            print(f"  copy       {c['status'].upper():<6} " + " · ".join(f"{x['id']}:{x['status']} {x['detail']}" for x in c["checks"] if x["status"] != "pass"))
            worst = max(worst, c["status"], key=["pass", "review", "fail"].index)
            (out / "report.json").write_text(json.dumps(report, indent=2))
            (out / "caption.md").write_text(f"# {spec['title']}\n\n## Caption\n{spec.get('caption', '')}\n\n## Alt text\n{spec.get('alt', '')}\n")
            (out / "spec.json").write_text(json.dumps(spec, indent=2))
        browser.close()
    httpd.shutdown()
    print(f"\nOverall: {worst.upper()}")


if __name__ == "__main__":
    main()
