"""Fuzz test: thousands of random combinations of layout, format, copy (including empty, numeric and very long),
photo, crop, zoom and colour, run through the Studio engine, checks and one-click fixes (studio/test/fuzz.html).
Fails if anything throws or a failing output has no working fix.

    python tools/test_fuzz.py
"""
import functools, http.server, threading, pathlib, time, collections, sys
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
httpd = http.server.ThreadingHTTPServer(('127.0.0.1',0), functools.partial(Q, directory=str(ROOT)))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
tot=collections.Counter(); exc=[]; unf=[]
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(); pg.set_default_timeout(900000)
    pg.goto(f'http://127.0.0.1:{httpd.server_address[1]}/studio/test/fuzz.html'); pg.wait_for_function('window.__ready')
    for L in pg.evaluate('window.__layouts'):
      for F in ['feed','square','link','story','slide']:
        t=time.time(); r=pg.evaluate(f'window.__fuzzOne("{L}","{F}")')
        tot['renders']+=r['renders']; tot['fails']+=r['fails']; exc+=r['exceptions']; unf+=r['unfixable']
        for k,v in r['byCheck'].items(): tot['check:'+k]+=v
        print(f"{L:<14}{F:<7} renders {r['renders']:>3}  exc {len(r['exceptions'])}  unfixable {len(r['unfixable'])}  {time.time()-t:.1f}s  slowest {r.get('slowMs',0):.0f}ms {r.get('slowest','')[:60]}", flush=True)
    b.close()
print('TOTAL', dict(tot)); print('EXCEPTIONS', len(exc)); [print('  ',x) for x in exc[:15]]
print('UNFIXABLE', len(unf), collections.Counter(u.split(' :: ')[1] for u in unf)); [print('  ',x) for x in unf[:15]]
sys.exit(1 if exc or unf else 0)
