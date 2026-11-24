"""Render the flow-graphic options into labelled review sheets (out/flow-options/)."""
import base64, io, pathlib
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright
from produce import ROOT, serve

NAMES = {
    "bars": "v0 · Current stand-in (plain slanted bars)",
    "lanes": "A · Lanes: parallel bands, each steps once, like signals moving across sites",
    "converge": "B · Converge: spread-out bands step into one tight bundle (every site, one view)",
    "supergraphic": "C · Supergraphic: one oversized stepped stroke, cropped by the frame",
    "contour": "D · Contour: fine bands stepping together, echoing the ribbed-metal photo",
}

def img(data):
    return Image.open(io.BytesIO(base64.b64decode(data.split(",", 1)[1]))).convert("RGB")

def main():
    httpd = serve()
    out = ROOT / "out/flow-options"; out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page()
        pg.goto(f"http://127.0.0.1:{httpd.server_address[1]}/studio/flow-options.html")
        pg.wait_for_function("window.__flows", timeout=120_000)
        data = pg.evaluate("window.__flows"); b.close()
    bold = ImageFont.truetype(str(ROOT / "brand-kit/fonts/InterTight-Bold.ttf"), 30)
    reg = ImageFont.truetype(str(ROOT / "brand-kit/fonts/InterTight-Regular.ttf"), 20)
    for style, d in data.items():
        sw = [img(d["swatches"][k]).resize((360, 360)) for k in ["lavender", "black", "coolgrey", "white"]]
        fr = [img(d["frames"][str(i)]).resize((432, 540)) for i in (0, 5)]
        W = 4 * 360 + 3 * 12 + 40 + 2 * 432 + 12
        sheet = Image.new("RGB", (W, 640), "#F2F3F5"); dr = ImageDraw.Draw(sheet)
        dr.text((24, 22), NAMES[style], font=bold, fill="#000")
        for i, (im, lab) in enumerate(zip(sw, ["lavender", "black", "cool grey", "white"])):
            x = 24 + i * 372; sheet.paste(im, (x, 80)); dr.text((x, 450), lab, font=reg, fill="#5b5f66")
        x0 = 24 + 4 * 372 + 16
        for j, im in enumerate(fr):
            sheet.paste(im, (x0 + j * 444, 80))
        dr.text((x0, 628 - 0), "", font=reg)
        dr.text((24, 490), "Colourways (field / bands, one vermilion signal band)        In context: D2 carousel cover and closing frame →", font=reg, fill="#5b5f66")
        sheet.save(out / f"flow-{style}.png")
        print("wrote", out / f"flow-{style}.png")
    httpd.shutdown()

if __name__ == "__main__":
    main()
