"""Deck production: deck spec -> editable PowerPoint (.pptx), PDF and slide PNGs, using the Deck Studio's
own exporter in headless Chromium.

    python tools/produce_deck.py studio/specs/d6-pilot-deck.json [--out deliverables]
"""
import argparse
import base64
import pathlib
import subprocess
import sys

from playwright.sync_api import sync_playwright

from produce import ROOT, serve


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("specs", nargs="+")
    ap.add_argument("--out", default="deliverables")
    args = ap.parse_args()
    # slide PNGs and check reports come from the standard producer
    subprocess.run([sys.executable, str(ROOT / "tools/produce.py"), *args.specs, "--out", args.out], check=True)
    httpd = serve()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for spec_path in args.specs:
            rel = pathlib.Path(spec_path).resolve().relative_to(ROOT)
            page = browser.new_page(viewport={"width": 1500, "height": 950})
            page.goto(f"http://127.0.0.1:{httpd.server_address[1]}/deck/#spec=../{rel.as_posix()}")
            page.wait_for_function("window.deckStudio && window.deckStudio.outputs.length && window.PptxGenJS && window.jspdf", timeout=120_000)
            sid = page.evaluate("window.deckStudio.spec.id")
            out = ROOT / args.out / sid
            out.mkdir(parents=True, exist_ok=True)
            for kind in ("pptx", "pdf"):
                data = page.evaluate(f"window.deckStudio.exportBase64('{kind}')")
                (out / f"{sid}.{kind}").write_bytes(base64.b64decode(data))
                print(f"  wrote {(out / f'{sid}.{kind}').relative_to(ROOT)}")
            page.close()
        browser.close()
    httpd.shutdown()


if __name__ == "__main__":
    main()
