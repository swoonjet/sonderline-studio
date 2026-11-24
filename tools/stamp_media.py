"""Add a content fingerprint (?v=<hash>) to every video and image URL on the site's HTML pages,
so browsers and the CDN never serve an old render after a file is replaced.

    python3 tools/stamp_media.py
"""
import hashlib
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = ["index.html", "deliverables/index.html", "docs/index.html"]
ATTR = re.compile(r'(?P<attr>\b(?:src|poster|href))="(?P<url>[^"#?]+\.(?:mp4|webm|png|jpg|pdf|zip))(?:\?v=[0-9a-f]+)?"')


def main():
    for page in PAGES:
        path = ROOT / page
        html = path.read_text()

        def stamp(m):
            target = (path.parent / m["url"]).resolve()
            if not target.exists():
                return m.group(0)
            digest = hashlib.sha1(target.read_bytes()).hexdigest()[:10]
            return f'{m["attr"]}="{m["url"]}?v={digest}"'

        new = ATTR.sub(stamp, html)
        if new != html:
            path.write_text(new)
            print(f"stamped {page}")


if __name__ == "__main__":
    main()
