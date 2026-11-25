"""Regression test: renders every spec in studio/test/matrix (84 specs, 420 outputs across layouts, formats,
copy lengths, photos and colours) and fails if any output fails its brand checks.

    python tools/test_regression.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

specs = sorted(str(p) for p in (ROOT / "studio/test/matrix").glob("*.json"))
r = subprocess.run([sys.executable, str(ROOT / "tools/produce.py"), *specs, "--out", "out/matrix"],
                   cwd=ROOT, capture_output=True, text=True)
fails = [l for l in r.stdout.splitlines() if " FAIL " in l]
print(f"{len(specs)} specs rendered; {len(fails)} failing outputs")
for l in fails[:20]:
    print(" ", l)
if r.returncode or fails:
    print(r.stderr[-2000:])
    sys.exit(1)
