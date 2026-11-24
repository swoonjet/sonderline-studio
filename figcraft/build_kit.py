"""Builds the Sonderline brand kit in FigCraft from rules/*.json, headless (figcraft-cli mcp, no window).

    python3 figcraft/build_kit.py [--fresh] [--stage all|foundations|components|templates|board|examples|qa|previews]
                                  [--redo <section,...>]   delete those ledger sections first and rebuild them

Stages run in order and skip work the ledger says is done, so a re-run only builds what's missing.
--fresh starts a new document and a new ledger. Writes figcraft/sonderline-brand-kit.figcraft,
figcraft/ledger.json (node ids by name) and figcraft/previews/*.png.

Sizes are fractions of a 1080-wide frame (u = 1080), as in the guide's social example. Formats with
another unit (link card u = 1000, slides u = 1500) are built at the 1080 unit and scaled as a whole, so
their text carries scaled font sizes (the same as Figma's Scale tool).
"""
import argparse, json, math, pathlib, re, sys, zipfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from fc import FCHeadless, FCError  # noqa: E402

tokens = json.loads((ROOT / "rules/tokens.json").read_text())
formats = json.loads((ROOT / "rules/formats.json").read_text())
copy = json.loads((ROOT / "rules/copy-library.json").read_text())
LEDGER = HERE / "ledger.json"
OUT = HERE / "sonderline-brand-kit.figcraft"
PREVIEWS = HERE / "previews"

# ---------------------------------------------------------------- brand constants
COLOURS = {"black": "#000000", "white": "#FFFFFF", "lavender": "#E2CBFF", "vermilion": "#FF6242", "cool grey": "#DADDE3"}
assert {k.replace("coolgrey", "cool grey"): v["hex"] for k, v in tokens["colour"].items()} == COLOURS
ROLES = {k.replace("coolgrey", "cool grey"): v["role"] for k, v in tokens["colour"].items()}
SHARE = {k.replace("coolgrey", "cool grey"): v for k, v in tokens["colour_share_target"].items() if not k.startswith("_")}
PAIRS = {k: v for k, v in tokens["text_pairings"].items() if not k.startswith("_")}

U = 1080                                   # the type/spacing unit everything is drawn at
M = round(tokens["social_template_ratios"]["margin_ratio_of_width"] * U)   # 43: outer margin
RULE_W = round(0.0146 * U)                 # 16: vermilion rule at the 2/3 split
PAD = round(0.9 * M)                       # 39: info-row padding
FAM = "Inter Tight"
LOCK_ASPECT, SYM_ASPECT = tokens["logo"]["aspect"]["lockup"], tokens["logo"]["aspect"]["symbol"]

# name, style, size (px at u=1080), fraction of u, line height, tracking, case, use
STYLES = [
    ("Display", "Regular", 151, 0.14, "95%", "-2.5%", None, "Type-led covers and signal frames"),
    ("Headline", "Regular", 135, 0.125, "98%", "-2%", None, "One message per piece; set in Regular"),
    ("Lead", "Regular", 50, 0.046, "110%", "-0.5%", None, "The supporting line under a headline"),
    ("Body", "Regular", 37, 0.034, "122%", "0%", None, "Longer copy on slides"),
    ("Status", "Regular", 31, 0.029, "125%", "0%", None, "Product status in the accent panel"),
    ("CTA", "Regular", 29, 0.027, "120%", "0%", None, "Always with the arrow"),
    ("Detail", "Regular", 26, 0.024, "130%", "0%", None, "Capabilities and small supporting text"),
    ("List", "Regular", 31, 0.029, "125%", "0%", None, "Signal list, regular item"),
    ("List current", "Bold", 31, 0.029, "125%", "0%", None, "Signal list, current item (with the vermilion square)"),
    ("Label", "Regular", 18, 0.0167, "120%", "1%", "upper", "Micro-labels, uppercase"),
    ("Footer label", "Regular", 18, 0.0167, "120%", "1%", "upper", "Footer micro-label, white on black"),
]

APPROVED = set(copy["voice"]) | set(copy["labels"]) | {l["text"] for l in copy["lines"]} | set(copy["product"]["capabilities"]) \
    | set(copy["product"]["signals"]) | {copy["product"][k] for k in ("name", "description", "audience", "status", "cta")}


def L(id_):
    """A copy-library line by id (fails loudly if the id is wrong, so copy can't drift)."""
    return next(l["text"] for l in copy["lines"] if l["id"] == id_)


def lab(s):
    assert s in copy["labels"], s
    return s


P = copy["product"]


def smootherstep(k):
    k = min(1.0, max(0.0, k))
    return k * k * k * (k * (k * 6 - 15) + 10)


def contour_paths(w, h, n=8):
    """The Contour flow graphic (studio/js/engine.js contourField, calm): n bands that step up through a
    smootherstep S-curve. Step height 2.2 x pitch, run 34% of width centred at 62%, each line 1% further right.
    Returns (stroke width, [(svg path, is_signal_line)])."""
    rise = 2.2
    pitch = h / (n + rise)
    t = max(0.0075 * U, pitch * 0.34)
    dy, xs, run = -pitch * rise, w * 0.62, w * 0.34
    sig = math.floor(n * 0.62)
    out = []
    for i in range(n):
        base = (rise + i + 0.5) * pitch
        x0 = xs + i * w * 0.01 - run / 2
        pts = [(-t, base), (x0, base)]
        pts += [(x0 + run * j / 48, base + dy * smootherstep(j / 48)) for j in range(1, 48)]
        pts += [(x0 + run, base + dy), (w + t, base + dy)]
        d = "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in pts)
        out.append((d, i == sig))
    return t, out


class Kit:
    def __init__(self, fresh=False):
        self.fc = FCHeadless(ROOT)
        if fresh and LEDGER.exists():
            LEDGER.unlink()
        if OUT.exists() and not fresh:
            self.fc.open(OUT)
        self.ids = json.loads(LEDGER.read_text()) if LEDGER.exists() else {}

    # ------------------------------------------------------------ plumbing
    def ex(self, cmd, params=None):
        return self.fc.ex(cmd, params)

    @staticmethod
    def nid(r):
        return r["id"] if isinstance(r, dict) else r

    def get(self, i, depth=0):
        return self.fc.call("node.get", {"id": i, "depth": depth})

    def save_ledger(self):
        LEDGER.write_text(json.dumps(self.ids, indent=1))

    def save(self):
        """Save, then prove the file on disk holds every page the session has."""
        doc = self.fc.call("document.inspect")
        want = {p["name"] for p in doc["pages"]}
        self.ex("file.saveAs", {"path": str(OUT)})
        d = json.loads(zipfile.ZipFile(OUT).read("document.json"))
        nodes = d["nodes"]
        got = {nodes[str(i)]["name"] for i in d["pages"] if str(i) in nodes}
        if not want <= got:
            raise FCError(f"saved file is missing pages {sorted(want - got)}")
        return sorted(got)

    def var(self, name):
        return {"$var": name}

    def go(self, page):
        self.ex("page.select", {"id": self.ids["pages"][page]})

    def frame(self, parent, name, **props):
        p = {"type": "frame", "name": name, "select": False}
        if parent is not None:
            p["parent"] = parent
        for k in ("x", "y", "width", "height"):
            if k in props:
                p[k] = props.pop(k)
        sizing = {k: props[k] for k in ("sizingH", "sizingV") if k in props}
        p["props"] = props
        f = self.nid(self.ex("node.create", p))
        if sizing:                                     # fill needs the parent's auto layout to exist first
            self.ex("node.set", dict(ids=[f], **sizing))
        return f

    def rect(self, parent, name, x, y, w, h, fill, **props):
        p = {"type": "rectangle", "name": name, "x": x, "y": y, "width": w, "height": h, "select": False,
             "props": dict({"fill": self.var(fill) if fill in COLOURS else fill}, **props)}
        if parent is not None:
            p["parent"] = parent
        r = self.nid(self.ex("node.create", p))
        sizing = {k: props[k] for k in ("sizingH", "sizingV") if k in props}
        if sizing:
            self.ex("node.set", dict(ids=[r], **sizing))
        return r

    def text(self, parent, txt, style, colour="black", width=None, name=None, x=0, y=0, **extra):
        props = {"textAutoResize": "height" if width else "widthAndHeight", "fill": self.var(colour)}
        sizing = {k: extra.pop(k) for k in ("sizingH", "sizingV") if k in extra}
        props.update(extra)
        p = {"text": txt, "x": x, "y": y, "name": name or style.lower(), "props": props, "select": False}
        if parent is not None:
            p["parent"] = parent
        if width:
            p["width"] = width
        t = self.nid(self.ex("node.create", dict(p, type="text")))
        self.ex("style.apply", {"ids": [t], "style": self.ids["styles"][style]})
        if sizing:
            self.ex("node.set", dict(ids=[t], **sizing))
        return t

    def inst(self, comp, parent=None, props=None, x=None, y=None, **set_props):
        p = {"component": self.ids["components"][comp] if isinstance(comp, str) else comp}
        if parent is not None:
            p["parent"] = parent
        i = self.nid(self.ex("instance.create", p))
        if props:
            self.ex("instance.setProperties", {"ids": [i], "properties": props})
        pos = {k: v for k, v in (("x", x), ("y", y)) if v is not None}
        if pos or set_props:
            self.ex("node.set", dict(ids=[i], **pos, **set_props))
        return i

    def child(self, root, name, type_=None):
        q = {"root": root, "name": name}
        if type_:
            q["type"] = type_
        r = self.ex("node.find", q)["ids"]
        if not r:
            raise FCError(f"no {name} under {root}")
        return r[0]

    def bottom(self, i):
        b = self.get(i)["absoluteBounds"]
        return b["y"] + b["height"]

    def bind_props(self, variants, props):
        """variants: [{key: layer id}], first one gets the property; the rest bind to it."""
        for prop, key, kind, default in props:
            r = self.ex("component.addProperty", {"id": variants[0][key], "name": prop, "type": kind, "default": default})
            pname = (r.get("name") or prop) if isinstance(r, dict) else prop
            for v in variants[1:]:
                self.ex("component.bindProperty", {"layer": v[key], "property": pname,
                                                   "field": "characters" if kind == "text" else "visible"})

    # ------------------------------------------------------------ pages, variables, styles
    def pages(self):
        doc = self.fc.call("document.inspect")
        existing = {p["name"]: p["id"] for p in doc["pages"]}
        if "Cover" not in existing:
            first = doc["pages"][0]
            self.ex("page.rename", {"id": first["id"], "name": "Cover"})
            existing = {"Cover": first["id"], **{k: v for k, v in existing.items() if v != first["id"]}}
        for name in ["Foundations", "Components", "Templates", "Examples"]:
            if name not in existing:
                existing[name] = self.nid(self.ex("page.add", {"name": name}))
        for pid in existing.values():
            self.ex("page.setBackground", {"id": pid, "color": "#F2F2F2"})
        self.ids["pages"] = existing
        self.save_ledger()

    def variables(self):
        if self.ids.get("variables"):
            return
        col = self.nid(self.ex("variable.createCollection", {"name": "Sonderline colour", "modes": ["Value"]}))
        out = {}
        for name, hexv in COLOURS.items():
            desc = ROLES[name] + (". Under 5% of any layout; never a full field; black text on it." if name == "vermilion" else "")
            out[name] = self.nid(self.ex("variable.create", {"collection": col, "name": name, "type": "color", "value": hexv, "description": desc}))
        sp = self.nid(self.ex("variable.createCollection", {"name": "Sonderline space (1080 frame)", "modes": ["Value"]}))
        for name, val, desc in [("margin", M, "Outer margin, 3.96% of width"), ("rule", RULE_W, "Vermilion rule at the 2/3 split, 1.46% of width"),
                                ("info padding", PAD, "Info-row padding, 0.9 x margin")]:
            out[name] = self.nid(self.ex("variable.create", {"collection": sp, "name": name, "type": "number", "value": val, "description": desc}))
        self.ids["variables"] = out
        self.save_ledger()

    def text_styles(self):
        if self.ids.get("styles"):
            return
        self.go("Foundations")
        out = {}
        for name, style, size, frac, lh, ls, case, use in STYLES:
            props = {"fontFamily": FAM, "fontStyle": style, "fontSize": size, "lineHeight": lh, "letterSpacing": ls}
            if case:
                props["textCase"] = case
            t = self.nid(self.ex("text.create", {"text": "Sample", "x": -4000, "y": -4000, "select": False, "props": props}))
            out[name] = self.nid(self.ex("style.create", {"type": "text", "name": name, "from": t,
                                                         "description": f"Inter Tight {style}, {size} px = {frac} x frame width (1080). {use}."}))
            self.ex("edit.delete", {"ids": [t]})
        self.ids["styles"] = out
        self.save_ledger()

    # ------------------------------------------------------------ components
    def caption(self, x, y, title, note=None, width=1600):
        """Page annotation: an uppercase label and a plain note (not part of any component)."""
        g = self.frame(None, f"Note · {title}", x=x, y=y, layout="vertical", gap=12, fill="none", sizingH="hug", sizingV="hug")
        self.text(g, title.upper(), "Label", name="title")
        if note:
            self.text(g, note, "Detail", width=width, name="note")
        return g

    def logos(self, c, x, y):
        sets = {}
        for kind, aspect in (("Lockup", LOCK_ASPECT), ("Symbol", SYM_ASPECT)):
            vs = []
            for colour in ("Black", "White"):
                f = self.nid(self.ex("file.import", {"path": str(ROOT / tokens["logo"][f"{kind.lower()}_{colour.lower()}"]), "x": 0, "y": 0}))
                self.ex("component.create", {"ids": [f]})
                self.ex("node.set", {"ids": [f], "name": f"Colour={colour}",
                                     "description": ("On white, lavender, cool grey and vermilion." if colour == "Black" else "On black and on photography.")
                                     + " Supplied artwork, clearspace (h/2) included in its frame. Scale it as a whole; never redraw, recolour or stretch."})
                vs.append(f)
            st = self.nid(self.ex("component.combineVariants", {"ids": vs}))
            self.ex("node.set", {"ids": [st], "name": f"Logo / {kind}", "x": x, "y": y, "layout": "horizontal", "gap": 64, "padding": 48, "fill": "none",
                                 "description": f"Sonderline {kind.lower()} from brand-kit/assets (aspect {aspect:.3f} including clearspace)."})
            self.ex("node.set", {"ids": [st], "sizingH": "hug", "sizingV": "hug"})
            g = self.get(st, 1)
            wv = next(k for k in g["children"] if "White" in k["name"])["absoluteBounds"]
            c.setdefault("_backdrops", []).append(0)
            c["_backdrops"][-1] = self.rect(None, f"Backdrop · {kind} white", wv["x"] - 24, wv["y"] - 24, wv["width"] + 48, wv["height"] + 48, "black", locked=True)
            sets[kind] = st
            x += g["width"] + 80
        # keep the backdrops behind the sets
        for k in sets.values():
            self.ex("arrange.front", {"ids": [k]})
        c["Logo / Lockup"], c["Logo / Symbol"] = sets["Lockup"], sets["Symbol"]

    def arrow(self, c, x, y):
        f = self.frame(None, "Arrow", x=x, y=y, width=49, height=24, fill="none")
        hd = round(0.011 * U, 2)
        d = f"M0 12 H49 M{49 - hd:.2f} {12 - hd * 0.62:.2f} L49 12 L{49 - hd:.2f} {12 + hd * 0.62:.2f}"
        self.ex("node.create", {"type": "vector", "path": d, "parent": f, "name": "arrow", "x": 0, "y": 12 - hd * 0.62, "select": False,
                                "props": {"fill": "none", "stroke": self.var("black"), "strokeWeight": round(0.0022 * U, 2), "strokeCap": "none", "strokeJoin": "miter",
                                          "constraints": {"horizontal": "scale", "vertical": "scale"}}})
        self.ex("component.create", {"ids": [f]})
        self.ex("node.set", {"ids": [f], "description": "CTA arrow: 4.5% of width long, drawn in black. Always paired with the CTA text."})
        c["Arrow"] = f

    def label(self, c, x, y):
        f = self.frame(None, "Label", x=x, y=y, layout="horizontal", fill="none", sizingH="hug", sizingV="hug")
        t = self.text(f, "SONDERLINE PULSE", "Label", name="label")
        self.ex("component.create", {"ids": [f]})
        self.ex("component.addProperty", {"id": t, "name": "Label", "type": "text"})
        self.ex("node.set", {"ids": [f], "description": "Micro-label: uppercase, Regular, 1.67% of width. Use the approved labels in rules/copy-library.json."})
        c["Label"] = f

    def cta(self, c, x, y):
        f = self.frame(None, "CTA", x=x, y=y, width=634, layout="horizontal", mainAlign="spaceBetween", crossAlign="center", gap=22,
                       fill="none", sizingH="fixed", sizingV="hug")
        t = self.text(f, P["cta"], "CTA", name="cta")
        self.inst("Arrow", f)
        self.ex("component.create", {"ids": [f]})
        self.ex("component.addProperty", {"id": t, "name": "CTA", "type": "text"})
        self.ex("node.set", {"ids": [f], "description": "CTA text with the arrow at the far end. Set it to fill the panel width, or hug for a CTA beside the lead."})
        c["CTA"] = f

    def marks(self, c, x, y):
        vs = []
        for name, w, h in (("Type=Rule", RULE_W, 378), ("Type=Tick", round(0.17 * U), RULE_W), ("Type=Square", round(0.016 * U), round(0.016 * U))):
            f = self.frame(None, name, x=0, y=0, width=w, height=h, fill=self.var("vermilion"))
            self.ex("component.create", {"ids": [f]})
            vs.append(f)
        st = self.nid(self.ex("component.combineVariants", {"ids": vs}))
        self.ex("node.set", {"ids": [st], "name": "Vermilion mark", "x": x, "y": y, "layout": "horizontal", "gap": 64, "padding": 48, "crossAlign": "min", "fill": "none",
                             "description": "The only vermilion shapes: the rule at the 2/3 split (1.46% of width), the tick on type-led fields, the square that marks the current signal. Keep vermilion under 5% of a layout."})
        self.ex("node.set", {"ids": [st], "sizingH": "hug", "sizingV": "hug"})
        c["Vermilion mark"] = st

    def footer(self, c, x, y):
        f = self.frame(None, "Footer bar", x=x, y=y, width=1080, height=180, fill=self.var("black"), layout="horizontal", mainAlign="spaceBetween",
                       crossAlign="center", padding=[0, M - 28, 0, M], sizingH="fixed", sizingV="fixed")
        t = self.text(f, "OPERATIONS / PERSPECTIVE", "Footer label", "white", name="footer label")
        lg = self.inst("Logo / Lockup", f, {"Colour": "White"}, name="lockup")
        self.ex("transform.scale", {"ids": [lg], "factor": 112 / self.get(lg)["height"]})
        self.ex("component.create", {"ids": [f]})
        self.ex("component.addProperty", {"id": t, "name": "Label", "type": "text"})
        self.ex("node.set", {"ids": [f], "description": "Black footer: micro-label left, white lockup right. Lockup frame = min(10.4% of width, 92% of footer height); its visible art sits on the right margin (the frame's built-in clearspace hangs past it)."})
        c["Footer bar"] = f

    def info_row(self, c, x, y):
        variants = []
        for accent in ("Lavender", "Cool grey"):
            for layout in ("Stacked", "Row"):
                f = self.frame(None, f"Accent={accent}, Layout={layout}", x=0, y=0, width=1080, height=378, layout="horizontal", fill="none",
                               sizingH="fixed", sizingV="fixed")
                main = self.frame(f, "White panel", width=720, fill=self.var("white"), layout="vertical", padding=[PAD, M, PAD, M], gap=26,
                                  mainAlign="spaceBetween", sizingH="fixed", sizingV="fill")
                top = self.frame(main, "Top", layout="vertical", gap=26, fill="none", sizingH="fill", sizingV="hug")
                v = {"label": self.text(top, "SONDERLINE PULSE", "Label", name="label")}
                if layout == "Stacked":
                    v["lead"] = self.text(top, L("clearer-view-locations"), "Lead", width=634, name="lead", sizingH="fill")
                    v["cta"] = self.inst("CTA", main, sizingH="fill")
                else:
                    row = self.frame(main, "Lead + CTA", layout="horizontal", gap=40, crossAlign="max", fill="none", sizingH="fill", sizingV="hug")
                    v["lead"] = self.text(row, L("clearer-view-locations"), "Lead", width=400, name="lead", sizingH="fill")
                    v["cta"] = self.inst("CTA", row, sizingH="hug")
                self.rect(f, "Vermilion rule", 0, 0, RULE_W, 378, "vermilion", sizingV="fill")
                acc = self.frame(f, "Accent panel", fill=self.var(accent.lower()), layout="vertical", padding=[PAD, round(0.8 * M), PAD, round(0.6 * M)], gap=26,
                                 sizingH="fill", sizingV="fill")
                v["status label"] = self.text(acc, "EARLY ACCESS", "Label", name="status label")
                v["status"] = self.text(acc, L("pilots-planned"), "Status", width=280, name="status", sizingH="fill")
                self.ex("component.create", {"ids": [f]})
                v["id"] = f
                variants.append(v)
        st = self.nid(self.ex("component.combineVariants", {"ids": [v["id"] for v in variants]}))
        self.ex("node.set", {"ids": [st], "name": "Info row", "x": x, "y": y, "layout": "grid", "gridColumns": 2, "gap": 80, "crossGap": 80, "padding": 48, "fill": "none",
                             "description": "The guide's info row: white panel on the left 2/3, the vermilion rule at the split, an accent panel (lavender or cool grey) on the right. "
                                            "Stacked: CTA under the lead (tall formats). Row: CTA beside the lead (link cards, slides). Resize the White panel to 2/3 of the frame width."})
        self.ex("node.set", {"ids": [st], "sizingH": "hug", "sizingV": "hug"})
        self.bind_props(variants, [("Label", "label", "text", "SONDERLINE PULSE"), ("Lead", "lead", "text", L("clearer-view-locations")),
                                   ("Status label", "status label", "text", "EARLY ACCESS"), ("Status", "status", "text", L("pilots-planned"))])
        for v in variants:
            self.ex("component.exposeInstance", {"id": v["cta"]})
        c["Info row"] = st

    def signal_item(self, c, x, y):
        vs = []
        for state in ("Regular", "Current"):
            f = self.frame(None, f"State={state}", layout="horizontal", gap=22, crossAlign="center", fill="none", sizingH="hug", sizingV="hug")
            mk = round(0.016 * U)
            self.rect(f, "marker", 0, 0, mk, mk, "vermilion" if state == "Current" else "none")
            t = self.text(f, P["signals"][0], "List current" if state == "Current" else "List", name="signal")
            self.ex("component.create", {"ids": [f]})
            vs.append({"id": f, "t": t})
        st = self.nid(self.ex("component.combineVariants", {"ids": [v["id"] for v in vs]}))
        self.ex("node.set", {"ids": [st], "name": "Signal item", "x": x, "y": y, "layout": "horizontal", "gap": 64, "padding": 48, "fill": "none",
                             "description": "One of the four signals. Current = Bold plus the vermilion square, so the state never relies on colour alone."})
        self.ex("node.set", {"ids": [st], "sizingH": "hug", "sizingV": "hug"})
        self.bind_props(vs, [("Signal", "t", "text", P["signals"][0])])
        c["Signal item"] = st

    def photos(self, c, x, y):
        vs = []
        for key, name in (("motion-study", "Motion study"), ("material-study", "Material study")):
            f = self.frame(None, f"Image={name}", width=1080, height=792, fill="none", clip=True)
            self.ex("image.place", {"path": str(ROOT / tokens["photography"][key]["file"]), "target": f, "mode": "fill"})
            self.ex("component.create", {"ids": [f]})
            self.ex("node.set", {"ids": [f], "description": f'{tokens["photography"][key]["mode"]}. Fictional, AI-generated; supplied by SketchDeck, not customer evidence.'})
            vs.append(f)
        st = self.nid(self.ex("component.combineVariants", {"ids": vs}))
        self.ex("node.set", {"ids": [st], "name": "Photo frame", "x": x, "y": y, "layout": "horizontal", "gap": 64, "padding": 48, "fill": "none",
                             "description": "Image fill, cropped to the frame. Two modes: motion (partial human presence) and material (light, shadow, texture). Type over a photo needs the black scrim."})
        self.ex("node.set", {"ids": [st], "sizingH": "hug", "sizingV": "hug"})
        c["Photo frame"] = st

    def contour(self, c, x, y):
        w, h = 994, 300
        t, paths = contour_paths(w, h)
        vs = []
        for key, cw in tokens["flow"]["colourways"].items():
            nice = {"coolgrey": "Cool grey"}.get(key, key.title())
            f = self.frame(None, f"Colourway={nice}", width=w, height=h, fill=cw["field"], clip=True)
            self.ex("node.set", {"ids": [f], "fill": self.var({"coolgrey": "cool grey"}.get(key, key))})
            bars = {"#000000": "black", "#E2CBFF": "lavender"}[cw["bars"]]
            for i, (d, sig) in enumerate(paths):
                self.ex("node.create", {"type": "vector", "path": d, "parent": f, "name": "signal line" if sig else f"line {i + 1}", "select": False,
                                        "props": {"fill": "none", "stroke": self.var("vermilion" if sig else bars), "strokeWeight": round(t, 2),
                                                  "strokeCap": "none", "strokeJoin": "round", "constraints": {"horizontal": "scale", "vertical": "scale"}}})
            self.ex("component.create", {"ids": [f]})
            vs.append(f)
        st = self.nid(self.ex("component.combineVariants", {"ids": vs}))
        self.ex("node.set", {"ids": [st], "name": "Contour (proposed)", "x": x, "y": y, "layout": "grid", "gridColumns": 2, "gap": 64, "crossGap": 64, "padding": 48, "fill": "none",
                             "description": "PROPOSED — NOT SUPPLIED BY SONDERLINE. The brief lists flow graphics in four colourways but none were supplied. "
                                            "Contour: 8 bands step up through a smootherstep S-curve (step 2.2 x line pitch, run 34% of width centred at 62%, each line 1% further right); "
                                            "one line in vermilion. Mirrors studio/js/engine.js contourField. Replace with Sonderline's originals when provided."})
        self.ex("node.set", {"ids": [st], "sizingH": "hug", "sizingV": "hug"})
        c["Contour"] = st

    def components(self):
        self.go("Components")
        c = self.ids.setdefault("components", {})
        if c.get("_done"):
            return
        notes = self.ids.setdefault("component_notes", [])
        y = 0
        notes.append(self.caption(0, y, "Components", "Every template is built from these. Text layers have component properties; vermilion, colours and type come from the variables and text styles."))
        y += 200
        steps = [
            ("Logo", "Lockup and symbol from the supplied SVGs (black and white). The frame already holds h/2 clearspace: scale the whole frame, never redraw, recolour or stretch.", self.logos),
            ("Arrow, label, CTA", "Small parts. The CTA is the approved line plus the arrow.", None),
            ("Vermilion mark", "Rule at the 2/3 split, tick for type-led fields, square for the current signal.", self.marks),
            ("Footer bar", "Black, micro-label left, white lockup right.", self.footer),
            ("Info row", "White panel 2/3, vermilion rule, accent panel 1/3. Lavender or cool grey; stacked or row.", self.info_row),
            ("Signal item", "Regular and current (Bold plus vermilion square).", self.signal_item),
            ("Photo frame", "The two supplied photos as image fills. Fictional, AI-generated.", self.photos),
            ("Contour (proposed — not supplied by Sonderline)", "Flow graphic in the four colourways from rules/tokens.json. Proposed by Jon Toews; replace with Sonderline's originals when they exist.", self.contour),
        ]
        for title, note, fn in steps:
            notes.append(self.caption(0, y, title, note))
            y += 110
            if fn is None:
                self.arrow(c, 0, y)
                self.label(c, 160, y)
                self.cta(c, 480, y)
                y += 160
            else:
                key = len([k for k in c if not k.startswith("_")])
                fn(c, 0, y)
                new = [v for k, v in c.items() if not k.startswith("_")][key:]
                y = max(self.bottom(i) for i in new) + 140
            self.save_ledger()
        c["_done"] = True
        self.save_ledger()

    # ------------------------------------------------------------ templates
    def headline(self, parent, txt, style, colour, x, y, w, max_lines, box_h=None):
        """Headline sized to its box and line budget, with no orphan and no word split across lines."""
        t = self.text(parent, txt, style, colour, width=w, x=x, y=y, name="headline")
        size = next(s[2] for s in STYLES if s[0] == style)
        longest = max(txt.split(), key=len)
        probe = self.text(None, longest, style, x=-5000, y=-5000, name="probe")
        ww = self.get(probe)["width"]
        self.ex("edit.delete", {"ids": [probe]})
        cap = math.floor(size * min(1, w / ww * 0.98))   # the longest word must fit on a line by itself
        self.ex("node.set", {"ids": [t], "fontSize": cap})
        if box_h:
            self.ex("node.set", {"ids": [t], "textAutoResize": "none", "height": box_h})
        self.ex("text.fit", {"ids": [t], "maxLines": max_lines, "orphans": len(txt.split()) > 2, "minSize": 40})
        if self.get(t)["fontSize"] > cap:                # text.fit may grow it again; keep the cap
            self.ex("node.set", {"ids": [t], "fontSize": cap})
        if box_h:
            self.ex("node.set", {"ids": [t], "textAutoResize": "height"})
        return t

    def scrim(self, parent, w, h):
        r = self.rect(parent, "Scrim (keeps white type at 4.5:1 or more)", 0, 0, w, h, "none")
        self.ex("node.set", {"ids": [r], "fills": [{"type": "linearGradient", "stops": ["#000000A6", "#00000000"], "from": [0.5, 0], "to": [0.5, 1]}]})
        return r

    def info(self, parent, y, w, h, accent="Lavender", layout="Stacked", **texts):
        props = {"Accent": accent, "Layout": layout}
        names = {"label": "Label", "lead": "Lead", "status_label": "Status label", "status": "Status"}
        props.update({names[k]: v for k, v in texts.items()})
        i = self.inst("Info row", parent, props, x=0, y=y, width=w, height=h)
        self.ex("node.set", {"ids": [self.child(i, "White panel")], "width": round(w * 2 / 3)})
        return i

    def foot(self, parent, y, w, h, label="OPERATIONS / PERSPECTIVE"):
        i = self.inst("Footer bar", parent, {"Label": lab(label)}, x=0, y=y, width=w, height=h)
        lh = min(0.104 * U, 0.92 * h)
        lg = self.child(i, "lockup", "INSTANCE")
        cur = self.get(lg)["height"]
        if abs(cur - lh) > 0.5:
            self.ex("transform.scale", {"ids": [lg], "factor": lh / cur})
        self.ex("node.set", {"ids": [i], "paddingRight": round(M - lh / 4)})
        return i

    def photo(self, parent, image, x, y, w, h):
        return self.inst("Photo frame", parent, {"Image": image}, x=x, y=y, width=w, height=h)

    def template(self, name, w, h, x, y, build, description, unit=U):
        """Build at the 1080 unit (w, h scaled down by unit/1080), then scale to the real size."""
        k = unit / U
        t = self.frame(None, name, x=x, y=y, width=w / k, height=h / k, clip=True, fill=self.var("white"))
        try:
            build(t, w / k, h / k)
        except Exception:
            self.ex("edit.delete", {"ids": [t]})
            raise
        if k != 1:
            self.ex("transform.scale", {"ids": [t], "factor": k})
            self.ex("node.set", {"ids": [t], "width": w, "height": h})
        self.ex("component.create", {"ids": [t]})
        self.ex("node.set", {"ids": [t], "description": description})
        return t

    def templates(self):
        self.go("Templates")
        T = self.ids.setdefault("templates", {})
        f = formats

        def photo_hero(fmt, image, head, info, accent, layout="Stacked", head_style="Headline", top=M):
            def build(t, W, H):
                F = f[fmt]
                yP = round(H * F["photo"])
                yI = yP + round(H * F["info"])
                self.photo(t, image, 0, 0, W, yP)
                self.scrim(t, W, round(yP * 0.75))
                lines = F.get("headlineLines", 3)
                self.headline(t, head, head_style, "white", M, top, round(W * F["headlineW"]), lines, box_h=yP - top - M)
                self.info(t, yP, W, yI - yP, accent, layout, **info)
                if fmt == "story":
                    self.foot(t, yI, W, F["footerContent"])
                    self.rect(t, "Safe zone · bottom 340 px (platform UI)", 0, yI + F["footerContent"], W, H - yI - F["footerContent"], "black")
                else:
                    self.foot(t, yI, W, H - yI)
            return build

        def carousel_cover(t, W, H):
            yF = H - round(H * f["feed"]["footer"])
            self.ex("node.set", {"ids": [t], "fill": self.var("lavender")})
            self.inst("Vermilion mark", t, {"Type": "Tick"}, x=0, y=0)
            self.inst("Label", t, {"Label": lab("SONDERLINE PULSE / PRODUCT PERSPECTIVE")}, x=M, y=M)
            hl = self.headline(t, L("site-signals"), "Display", "black", M, M + 40, round(W * 0.72), 2)
            hb = self.bottom(hl) - self.get(t)["absoluteBounds"]["y"]
            ct = self.inst("CTA", t, {"CTA": P["cta"]}, x=M, y=yF - M - 35, width=W - 2 * M)
            ld = self.text(t, L("consolidated-your-locations"), "Lead", width=round(W * 0.62), x=M, y=0, name="lead")
            lead_top = yF - M - 35 - 60 - self.get(ld)["height"]
            self.ex("node.set", {"ids": [ld], "y": lead_top})
            ch = 300
            self.inst("Contour", t, {"Colourway": "Lavender"}, x=M, y=round((hb + lead_top - ch) / 2), width=W - 2 * M, height=ch)
            self.foot(t, yF, W, H - yF)

        def signal_frame(t, W, H):
            yF = H - round(H * f["feed"]["footer"])
            yP = round(H * 0.4)
            self.photo(t, "Material study", 0, 0, W, yP)
            self.inst("Label", t, {"Label": lab("THE OPERATIONAL VIEW")}, x=M, y=yP + M)
            self.headline(t, P["signals"][0], "Display", "black", M, yP + M + 50, round(W * 0.62), 2)
            lst = self.frame(t, "Signal list", x=M, y=0, layout="vertical", gap=8, fill="none", sizingH="hug", sizingV="hug")
            for i, s in enumerate(P["signals"]):
                self.inst("Signal item", lst, {"State": "Current" if i == 0 else "Regular", "Signal": s})
            hgt = self.get(lst)["height"]
            self.ex("node.set", {"ids": [lst], "y": yF - M - hgt})
            self.foot(t, yF, W, H - yF)

        def slide_title(t, W, H):
            F = f["slide"]
            yP = round(H * F["photo"]); yI = yP + round(H * F["info"])
            self.photo(t, "Motion study", 0, 0, W, yP)
            self.scrim(t, W, round(yP * 0.75))
            self.headline(t, L("progress-in-view"), "Headline", "white", M, M, round(W * F["headlineW"]), 2, box_h=yP - 2 * M)
            self.info(t, yP, W, yI - yP, "Cool grey", "Row", label=lab("SONDERLINE / PULSE"), lead=L("every-site"),
                      status_label=lab("PILOT STATUS"), status=L("early-access-pilots"))
            self.foot(t, yI, W, H - yI)

        def slide_grid(t, W, H):
            yF = H - round(H * f["slide"]["footer"])
            lw = round(W * 0.34)
            self.rect(t, "Lavender panel", 0, 0, lw, yF, "lavender")
            self.inst("Vermilion mark", t, {"Type": "Tick"}, x=0, y=0, width=round(lw * 0.25))
            self.headline(t, L("site-signals"), "Headline", "black", M, round(1.6 * M), lw - 2 * M, 2)
            self.inst("CTA", t, {"CTA": P["cta"]}, x=M, y=yF - M - 35, width=lw - 2 * M)
            ld = self.text(t, L("consolidated-your-locations"), "Body", width=lw - 2 * M, x=M, y=0, name="lead")
            self.ex("node.set", {"ids": [ld], "y": yF - M - 35 - 50 - self.get(ld)["height"]})
            self.inst("Label", t, {"Label": lab("SONDERLINE PULSE / PRODUCT PERSPECTIVE")}, x=lw + M, y=M)
            gw = W - lw
            tile_h = round((yF - 110 - 170) / 2)
            for i, (s, fill) in enumerate(zip(P["signals"], ["white", "lavender", "cool grey", "white"])):
                tx, ty = lw + (i % 2) * gw / 2, 110 + (i // 2) * tile_h
                tile = self.frame(t, f"Tile · {s}", x=tx, y=ty, width=gw / 2, height=tile_h, fill=self.var(fill), layout="vertical", padding=[30, M, 30, M])
                self.text(tile, s, "Lead", width=gw / 2 - 2 * M, name="signal", sizingH="fill")
            cy = 110 + 2 * tile_h + 36
            self.inst("Label", t, {"Label": lab("CAPABILITIES")}, x=lw + M, y=cy)
            row = self.frame(t, "Capabilities", x=lw + M, y=cy + 40, layout="horizontal", gap=40, fill="none", sizingH="hug", sizingV="hug")
            for cap in P["capabilities"]:
                self.text(row, cap, "Detail", name="capability")
            self.foot(t, yF, W, H - yF)

        def slide_end(t, W, H):
            yF = H - round(H * f["slide"]["footer"])
            self.rect(t, "Lavender field", 0, 0, W, yF, "lavender")
            self.inst("Vermilion mark", t, {"Type": "Tick"}, x=0, y=0, width=round(W * 0.17))
            self.inst("Label", t, {"Label": lab("SONDERLINE PULSE")}, x=M, y=M)
            hl = self.headline(t, L("meet-pulse"), "Display", "black", M, M + 50, round(W * 0.6), 1)
            hb = self.bottom(hl) - self.get(t)["absoluteBounds"]["y"]
            self.text(t, P["description"], "Body", width=round(W * 0.42), x=M, y=hb + 60, name="body")
            self.inst("CTA", t, {"CTA": P["cta"]}, x=M, y=yF - M - 35, width=W - 2 * M)
            self.foot(t, yF, W, H - yF)

        status = dict(status_label=lab("EARLY ACCESS"), status=L("pilots-planned"))
        plan = [
            ("Social feed 4:5 · Photo hero", 1080, 1350, U, photo_hero("feed", "Motion study", L("meet-pulse"),
                dict(label=lab("SONDERLINE PULSE"), lead=L("clearer-view-every-location"), **status), "Lavender"),
             "1080 × 1350. Photo 58.67%, info row 28%, footer 13.33%; split at 2/3. White headline on the photo with the black scrim."),
            ("Square 1:1 · Photo hero", 1080, 1080, U, photo_hero("square", "Material study", L("every-site"),
                dict(label=lab("SONDERLINE / PULSE"), lead=L("for-organizations"), status_label=lab("PILOT STATUS"), status=L("early-access-pilots")), "Cool grey"),
             "1080 × 1080. Photo 52%, info row 31%, footer 17%."),
            ("Link card 1.91:1", 1200, 628, formats["link"]["u"], photo_hero("link", "Motion study", L("progress-in-view"),
                dict(label=lab("SONDERLINE PULSE"), lead=L("clearer-view-locations"), **status), "Lavender", "Row"),
             "1200 × 628 (unit 1000). Photo 55.5%, info row 30% with the CTA beside the lead, footer 14.5%."),
            ("Story 9:16 · Photo hero", 1080, 1920, U, photo_hero("story", "Motion study", L("meet-pulse"),
                dict(label=lab("SONDERLINE PULSE"), lead=L("clearer-view-every-location"), **status), "Lavender", head_style="Display", top=formats["story"]["safeTop"]),
             "1080 × 1920. Text stays out of the top 250 px and bottom 340 px (platform UI). Footer content 140 px; black below it."),
            ("Carousel cover 4:5 · Type-led", 1080, 1350, U, carousel_cover,
             "Type-led lavender field with the vermilion tick and the Contour graphic (proposed — not supplied by Sonderline)."),
            ("Carousel frame 4:5 · Signal", 1080, 1350, U, signal_frame,
             "One signal per frame: material photo, the signal as headline, the four-item list with the current one in Bold plus the vermilion square."),
            ("Slide 16:9 · Photo title", 1920, 1080, formats["slide"]["u"], slide_title,
             "1920 × 1080 (unit 1500). Photo 62%, info row 24% (row layout), footer 14%."),
            ("Slide 16:9 · Signal grid", 1920, 1080, formats["slide"]["u"], slide_grid,
             "Guide p11: lavender lead panel, four signal tiles separated by colour and alignment, capabilities, logo in the reserved footer."),
            ("Slide 16:9 · End", 1920, 1080, formats["slide"]["u"], slide_end,
             "Closing slide: approved product description and the CTA on lavender."),
        ]
        x, y, row_h = 0, 0, 0
        rows = {"Social feed": 0, "Square": 0, "Link": 0, "Story": 0, "Carousel cover": 1, "Carousel frame": 1, "Slide 16:9 · Photo": 2, "Slide 16:9 · Signal": 2, "Slide 16:9 · End": 2}
        row_y = {0: 160, 1: 160 + 1920 + 240, 2: 160 + 1920 + 240 + 1350 + 240}
        row_x = {0: 0, 1: 0, 2: 0}
        if "_note" not in T:
            T["_note"] = self.caption(0, 0, "Templates", "Real sizes, built from component instances. All copy is from rules/copy-library.json. Text overrides go through the component properties.")
        for name, w, h, unit, build, desc in plan:
            r = next(v for k, v in rows.items() if name.startswith(k))
            if name not in T:
                T[name] = self.template(name, w, h, row_x[r], row_y[r], build, desc, unit)
                self.save_ledger()
            row_x[r] += w + 160
        if "Story 9:16 · Photo hero" in T and "_safe" not in T:
            b = self.get(T["Story 9:16 · Photo hero"])["absoluteBounds"]
            ids = []
            for yy, txt in ((b["y"] + 250, "SAFE ZONE · TOP 250 PX"), (b["y"] + b["height"] - 340, "SAFE ZONE · BOTTOM 340 PX")):
                ids.append(self.rect(None, f"Guide · {txt}", b["x"] + b["width"], yy - 2, 120, 4, "vermilion"))
                ids.append(self.text(None, txt, "Label", x=b["x"] + b["width"] + 20, y=yy + 12, name=txt))
            T["_safe"] = ids
        self.save_ledger()

    # ------------------------------------------------------------ cover + foundations board
    def cover(self):
        self.go("Cover")
        if self.ids.get("cover"):
            return
        cv = self.frame(None, "Cover", x=0, y=0, width=1920, height=1080, fill=self.var("white"), clip=True)
        self.inst("Vermilion mark", cv, {"Type": "Tick"}, x=0, y=0, width=326)
        lg = self.inst("Logo / Lockup", cv, {"Colour": "Black"}, x=0, y=0)
        s = 240 / self.get(lg)["height"]
        self.ex("transform.scale", {"ids": [lg], "factor": s})
        self.ex("node.set", {"ids": [lg], "x": 80 - 60, "y": 80 - 60})     # visible art on the 80 px margin (inset = h/4 = 60)
        self.text(cv, "Sonderline brand kit", "Headline", x=80, y=520, name="title")
        self.text(cv, "Colour, type, logo, components and templates for Sonderline social posts and presentations, "
                      "built from Brand Guide 8.0 and the files SketchDeck supplied.", "Lead", width=1300, x=80, y=700, name="description")
        self.rect(cv, "Footer", 0, 940, 1920, 140, "cool grey")
        self.text(cv, "Prepared by Jon Toews for SketchDeck. Sonderline is a fictional brand.", "Detail", x=80, y=995, name="credit")
        self.ids["cover"] = cv
        self.save_ledger()

    def foundations(self):
        self.go("Foundations")
        if self.ids.get("board"):
            return
        board = self.frame(None, "Foundations", x=0, y=0, width=2400, layout="vertical", padding=120, gap=140, fill=self.var("white"),
                           sizingH="fixed", sizingV="hug")

        def section(title, note=None):
            sec = self.frame(board, title, layout="vertical", gap=40, fill="none", sizingH="fill", sizingV="hug")
            self.text(sec, title, "Lead", name="title")
            if note:
                self.text(sec, note, "Detail", width=1500, name="note")
            return sec

        def row(parent, name, gap=32, wrap=False):
            return self.frame(parent, name, layout="horizontal", gap=gap, crossGap=48, wrap=wrap, fill="none", sizingH="fill", sizingV="hug")

        self.text(board, "Foundations", "Headline", name="title")
        # colour
        col = section("Colour", "Five colours. Neutrals lead, lavender expresses, vermilion signals. Each is a variable in the Sonderline colour collection; bind to it, never type a hex.")
        sw = row(col, "Swatches")
        for name, hexv in COLOURS.items():
            card = self.frame(sw, f"Swatch · {name}", layout="vertical", gap=12, fill="none", sizingH="hug", sizingV="hug")
            self.rect(card, "chip", 0, 0, 400, 240, name, stroke=self.var("cool grey"), strokeWeight=2, strokeAlign="inside")
            self.text(card, name.capitalize(), "Status", name="name")
            self.text(card, hexv, "Detail", name="hex")
            self.text(card, ROLES[name][0].upper() + ROLES[name][1:], "Detail", width=400, name="role")
            self.text(card, f"Share about {round(SHARE[name] * 100)}%", "Detail", name="share")
        # pairings
        pr = section("Text on colour", "Only these pairings. 4.5:1 minimum for all text. No white type on lavender, cool grey or vermilion; no accent-on-accent text. "
                                       "Over photos, white type sits on a black scrim that keeps it at 4.5:1 or more.")
        pw = row(pr, "Pairings")
        for key, ratio in PAIRS.items():
            fg, bg = key.split("-on-")
            fg, bg = fg.replace("coolgrey", "cool grey"), bg.replace("coolgrey", "cool grey")
            tile = self.frame(pw, f"Pairing · {key}", width=400, height=260, layout="vertical", padding=32, mainAlign="spaceBetween", fill=self.var(bg),
                              stroke=self.var("cool grey"), strokeWeight=2, strokeAlign="inside")
            self.text(tile, "Aa", "Headline", fg, name="sample")
            meta = self.frame(tile, "meta", layout="vertical", gap=4, fill="none", sizingH="fill", sizingV="hug")
            self.text(meta, f"{fg.capitalize()} on {bg}", "Detail", fg, name="pair")
            self.text(meta, f"{ratio:.2f}:1".replace(".00:", ":"), "Status", fg, name="ratio")
        # share
        sh = section("Colour share", "Directional, not a pixel rule. Vermilion stays under 5% of any layout: CTAs, micro-labels, the rule and rare emphasis. No full vermilion fields.")
        bar = self.frame(sh, "Share bar", width=2160, height=120, layout="horizontal", fill="none", stroke=self.var("cool grey"), strokeWeight=2, strokeAlign="outside")
        for name in ("white", "lavender", "black", "cool grey", "vermilion"):
            self.rect(bar, f"{name} {round(SHARE[name] * 100)}%", 0, 0, round(2160 * SHARE[name]), 120, name)
        leg = row(sh, "Legend", gap=64)
        for name in ("white", "lavender", "black", "cool grey", "vermilion"):
            item = self.frame(leg, f"Legend · {name}", layout="horizontal", gap=14, crossAlign="center", fill="none", sizingH="hug", sizingV="hug")
            self.rect(item, "key", 0, 0, 26, 26, name, stroke=self.var("cool grey"), strokeWeight=2, strokeAlign="inside")
            self.text(item, f"{name.capitalize()} {round(SHARE[name] * 100)}%", "Detail", name="legend")
        # type
        ty = section("Typography", "Inter Tight, Regular 400 and Bold 700 only. Headlines in Regular. Size, weight and space set the reading order. "
                                   "Sizes are fractions of a 1080-wide frame; other formats scale by their unit (link card 1000, slides 1500).")
        samples = {"Display": L("site-signals"), "Headline": L("progress-in-view"), "Lead": L("clearer-view-every-location"), "Body": P["description"],
                   "Status": L("early-access-pilots"), "CTA": P["cta"], "Detail": " ".join(P["capabilities"]), "List": P["signals"][1],
                   "List current": P["signals"][0], "Label": "SONDERLINE PULSE / PRODUCT PERSPECTIVE", "Footer label": "OPERATIONS / PERSPECTIVE"}
        for name, style, size, frac, lh, ls, case, use in STYLES:
            r = self.frame(ty, f"Specimen · {name}", layout="horizontal", gap=48, crossAlign="min", fill=self.var("black" if name == "Footer label" else "white"),
                           sizingH="fill", sizingV="hug", padding=[16, 16, 16, 16], stroke=self.var("cool grey"), strokeBottomWeight=2,
                           strokeTopWeight=0, strokeLeftWeight=0, strokeRightWeight=0)
            ink = "white" if name == "Footer label" else "black"
            meta = self.frame(r, "meta", layout="vertical", gap=6, fill="none", sizingH="hug", sizingV="hug")
            self.text(meta, name, "Status", ink, width=420, name="style")
            self.text(meta, f"{style} {700 if style == 'Bold' else 400} · {size} px · {frac} × width", "Detail", ink, width=420, name="spec")
            self.text(meta, f"Leading {lh} · tracking {ls}" + (" · uppercase" if case else ""), "Detail", ink, width=420, name="spec2")
            self.text(r, samples[name], name, ink, width=1600, name="sample", sizingH="fill")
        # logo
        lo = section("Logo", "Use the supplied files as they are. h = the visible height of the complete logo; keep h/2 clear on every side. "
                             "The supplied frames already include that clearspace, so place and scale the whole frame. Never redraw, recolour or stretch.")
        tiles = row(lo, "Logo tiles")
        for kind, colour, bg in (("Lockup", "Black", "white"), ("Lockup", "White", "black"), ("Symbol", "Black", "lavender"), ("Symbol", "White", "black")):
            tile = self.frame(tiles, f"Tile · {kind} {colour} on {bg}", width=520, height=300, fill=self.var(bg), layout="vertical", mainAlign="center", crossAlign="center",
                              stroke=self.var("cool grey"), strokeWeight=2, strokeAlign="inside")
            i = self.inst(f"Logo / {kind}", tile, {"Colour": colour})
            self.ex("transform.scale", {"ids": [i], "factor": (96 if kind == "Lockup" else 200) / self.get(i)["height"]})
        # clearspace diagram (lockup canvas = 2h tall: h visible, h/2 above and below)
        H2 = 360
        dg = self.frame(lo, "Clearspace diagram", width=round(H2 * LOCK_ASPECT) + 400, height=H2 + 200, fill="none")
        ox, oy = 200, 80
        i = self.inst("Logo / Lockup", dg, {"Colour": "Black"}, x=ox, y=oy)
        self.ex("transform.scale", {"ids": [i], "factor": H2 / self.get(i)["height"]})
        cw = H2 * LOCK_ASPECT
        self.rect(dg, "Clearspace boundary (the file's frame)", ox, oy, cw, H2, "none", stroke=self.var("vermilion"), strokeWeight=3, dashes=[12, 8])
        art = self.get(i, 1)["children"][0]["absoluteBounds"]          # the artwork group inside the supplied frame
        d0 = self.get(dg)["absoluteBounds"]
        ax, ay, aw, ah = art["x"] - d0["x"], art["y"] - d0["y"], art["width"], art["height"]
        self.rect(dg, "Visible artwork (h tall)", ax, ay, aw, ah, "none", stroke=self.var("black"), strokeWeight=2, dashes=[6, 6])
        self.rect(dg, "h", ox + cw + 30, ay, 3, ah, "black")
        self.text(dg, "h", "Status", x=ox + cw + 46, y=ay + ah / 2 - 20, name="h")
        self.rect(dg, "h/2 top", ox + cw + 30, ay - ah / 2, 3, ah / 2, "vermilion")
        self.text(dg, "h/2", "Status", x=ox + cw + 46, y=ay - ah / 4 - 20, name="h/2")
        self.rect(dg, "h/2 left", ax - ah / 2, oy - 30, ah / 2, 3, "vermilion")
        self.text(dg, "h/2", "Status", x=ax - ah / 2, y=oy - 72, name="h/2 left")
        self.text(dg, "Dashed vermilion: the supplied file's frame (h/2 clearspace built in). Dashed black: the visible artwork.", "Detail",
                  x=ox, y=oy + H2 + 30, name="key")
        # composition
        cp = section("Composition", "Photo 58.67%, info row 28%, footer 13.33% on a 4:5 feed post. The info row splits at 2/3 with a vermilion rule 1.46% of the width. "
                                    "Margin about 4% of the width. One message, consistent spacing, a clear footer.")
        mini = self.frame(cp, "Grid · 4:5", width=432, height=540, fill="none", clip=True)
        self.rect(mini, "photo 58.67%", 0, 0, 432, round(540 * 0.586667), "cool grey")
        self.rect(mini, "info 2/3", 0, round(540 * 0.586667), 288, round(540 * 0.28), "white", stroke=self.var("cool grey"), strokeWeight=2, strokeAlign="inside")
        self.rect(mini, "rule", 288, round(540 * 0.586667), 6, round(540 * 0.28), "vermilion")
        self.rect(mini, "accent 1/3", 294, round(540 * 0.586667), 138, round(540 * 0.28), "lavender")
        self.rect(mini, "footer 13.33%", 0, round(540 * 0.866667), 432, 540 - round(540 * 0.866667), "black")
        self.ids["board"] = board
        self.save_ledger()

    # ------------------------------------------------------------ examples
    def examples(self):
        self.go("Examples")
        if self.ids.get("examples"):
            return
        D = ROOT / "deliverables"
        groups = [("D1 · Early access", ["d1-early-access/feed.png", "d1-early-access/square.png", "d1-early-access/link.png", "d1-early-access/story.png"]),
                  ("D2 · Site signals carousel", [f"d2-site-signals/feed-0{i}.png" for i in range(1, 7)]),
                  ("D3 · Product perspective slides", [f"d3-product-perspective/slide-0{i}.png" for i in range(1, 4)])]
        out, y = [], 0
        out.append(self.caption(0, y, "Examples", "Rendered deliverables from the Pulse studio (deliverables/), placed as images for reference. "
                                               "Photos are fictional and AI-generated; supplied by SketchDeck."))
        y += 200
        for title, files in groups:
            out.append(self.caption(0, y, title))
            y += 80
            x, h = 0, 0
            for fn in files:
                r = self.ex("image.place", {"path": str(D / fn), "x": x, "y": y, "name": fn})
                i = self.nid(r)
                g = self.get(i)
                x += g["width"] + 80
                h = max(h, g["height"])
                out.append(i)
            y += h + 200
        self.ids["examples"] = out
        self.save_ledger()

    # ------------------------------------------------------------ QA + previews
    def walk(self, i):
        n = self.get(i, 50)
        stack = [n]
        while stack:
            k = stack.pop()
            yield k
            stack.extend(k.get("children", []))

    def qa(self):
        """Every text layer: Inter Tight Regular/Bold; template text is approved copy; every solid paint is a palette colour."""
        palette = set(COLOURS.values())
        problems = []
        for page in self.ids["pages"]:
            self.go(page)
            found = self.ex("node.find", {"limit": 10000})["ids"]
            for i in found:
                n = self.get(i)
                if True:
                    if n["type"] == "TEXT":
                        if n.get("fontFamily") != FAM or n.get("fontStyle") not in ("Regular", "Bold"):
                            problems.append((page, n["id"], n.get("name"), "font", n.get("fontFamily"), n.get("fontStyle")))
                        chars = (n.get("characters") or "").replace("\xa0", " ").replace("\u2011", "-")   # text.fit's no-break glue
                        if page == "Templates" and n["name"] not in ("title", "note") and not n["name"].startswith("SAFE ZONE") \
                                and chars not in APPROVED and not any(chars == s.upper() for s in APPROVED):
                            problems.append((page, n["id"], n.get("name"), "copy", n.get("characters")))
                    for key in ("fills", "strokes"):
                        if key == "strokes" and n["type"] == "COMPONENT_SET":
                            continue                       # FigCraft's dashed purple set outline (editor chrome)
                        for p in n.get(key) or []:
                            if p.get("type") == "solid" and p.get("color", "").upper()[:7] not in palette:
                                problems.append((page, n["id"], n.get("name"), key, p.get("color")))
        return problems

    def previews(self):
        PREVIEWS.mkdir(exist_ok=True)
        files = []
        for page, scale in (("Cover", 0.5), ("Foundations", 0.35), ("Components", 0.3), ("Templates", 0.2), ("Examples", 0.15)):
            self.go(page)
            p = PREVIEWS / f"page-{page.lower()}.png"
            # page exports are transparent: lay a temporary page-coloured backdrop behind everything, export, remove it
            tops = self.fc.tool("inspect_document", {"depth": 1})
            kids = next(pg for pg in tops["pages"] if "children" in pg)["children"]
            bs = [k["absoluteBounds"] for k in kids]
            x0, y0 = min(b["x"] for b in bs) - 80, min(b["y"] for b in bs) - 80
            x1, y1 = max(b["x"] + b["width"] for b in bs) + 80, max(b["y"] + b["height"] for b in bs) + 80
            bg = self.rect(None, "_preview backdrop", x0, y0, x1 - x0, y1 - y0, "#F2F2F2")
            self.ex("arrange.back", {"ids": [bg]})
            try:
                self.ex("file.export", {"format": "png", "scale": scale, "path": str(p)})
            finally:
                self.ex("edit.delete", {"ids": [bg]})
            files.append(p)
        self.go("Templates")
        for name, i in self.ids["templates"].items():
            if name.startswith("_"):
                continue
            slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
            p = PREVIEWS / f"template-{slug}.png"
            self.ex("file.export", {"ids": [i], "format": "png", "scale": 0.5, "path": str(p)})
            files.append(p)
        return files


SECTIONS = {"variables": "variables", "styles": "styles", "components": "components", "templates": "templates", "cover": "cover",
            "board": "board", "examples": "examples"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh", action="store_true", help="start a new document and ledger")
    ap.add_argument("--stage", default="all", help="all|foundations|components|templates|board|examples|qa|previews")
    ap.add_argument("--redo", default="", help="comma list of ledger sections to delete and rebuild: templates,cover,board,examples")
    a = ap.parse_args()
    k = Kit(fresh=a.fresh)
    k.pages()
    for sec in [s for s in a.redo.split(",") if s]:
        v = k.ids.pop(sec, None)
        if sec == "components" and k.ids.get("component_notes"):
            v = [v, k.ids.pop("component_notes")]
        ids = []

        def collect(x):
            if isinstance(x, dict):
                for y in x.values():
                    collect(y)
            elif isinstance(x, list):
                for y in x:
                    collect(y)
            elif isinstance(x, int) and not isinstance(x, bool):
                ids.append(x)
        collect(v)
        if ids:
            for i in ids:
                try:
                    k.ex("edit.delete", {"ids": [i]})
                except FCError:
                    pass
        k.save_ledger()
    st = a.stage
    if st in ("all", "foundations"):
        k.variables()
        k.text_styles()
    if st in ("all", "components"):
        k.components()
    if st in ("all", "templates"):
        k.templates()
    if st in ("all", "board"):
        k.cover()
        k.foundations()
    if st in ("all", "examples"):
        k.examples()
    print("saved pages:", k.save())
    if st in ("all", "qa"):
        probs = k.qa()
        print(f"QA: {len(probs)} problem(s)")
        for p in probs[:60]:
            print("  ", p)
    if st in ("all", "previews"):
        for f in k.previews():
            print("preview", f)
    print(json.dumps({x: (len(v) if isinstance(v, (dict, list)) else v) for x, v in k.ids.items()}))
    k.fc.close()


if __name__ == "__main__":
    main()
