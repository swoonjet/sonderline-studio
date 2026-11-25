"""Batch production: spec(s) -> PNGs for every format/frame + validation report + caption.

Uses the same engine as the web studio (studio/render.html in headless Chromium), so CLI
and browser output are pixel-identical.

    python tools/produce.py studio/specs/d1-early-access.json [more specs...] [--out deliverables]
"""
import argparse
import base64
import json
import pathlib

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent


def serve():
    from serve import serve as _serve
    return _serve()


def annotate(png_path, report, out_path):
    """Draw failing (red) and review (amber, dashed look) boxes onto a copy of the render."""
    im = Image.open(png_path).convert("RGB")
    d = ImageDraw.Draw(im)
    font = ImageFont.truetype(str(ROOT / "brand-kit/fonts/InterTight-Bold.ttf"), max(18, im.width // 45))
    lw = max(4, im.width // 260)
    for c in report["checks"]:
        if c["status"] == "pass":
            continue
        col = (196, 50, 27) if c["status"] == "fail" else (224, 161, 0)
        for b in c.get("boxes", []):
            x0, y0, x1, y1 = b["x"] - 6, b["y"] - 6, b["x"] + b["w"] + 6, b["y"] + b["h"] + 6
            d.rectangle([x0, y0, x1, y1], outline=col, width=lw)
            tag = f" {c['id']} "
            tw = d.textlength(tag, font=font)
            ty = max(0, y0 - font.size - 8)
            d.rectangle([x0, ty, x0 + tw, ty + font.size + 8], fill=col)
            d.text((x0, ty + 2), tag, font=font, fill=(255, 255, 255))
    im.save(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("specs", nargs="+")
    ap.add_argument("--out", default="deliverables")
    ap.add_argument("--strict", action="store_true", help="exit with status 1 if any output fails its checks")
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
                if fr["report"]["status"] == "fail":
                    annotate(out / f"{fr['name']}.png", fr["report"], out / f"{fr['name']}-annotated.png")
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
    if args.strict and worst == "fail":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
